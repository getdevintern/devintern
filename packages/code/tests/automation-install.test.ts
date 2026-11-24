import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { CatalogPack } from "../src/lib/automation/catalog";
import { listCatalogPacks, loadCatalogPack } from "../src/lib/automation/catalog";
import {
  installCatalogPack,
  tomlBasicString,
  tomlMultilineString,
} from "../src/lib/automation/install";
import { parseWorkspaceConfig, loadWorkspaceConfig } from "../src/lib/workspace/config";
import { runWorkerScaffold } from "../src/lib/workspace/init";
import { workspaceConfigPath } from "../src/lib/workspace/paths";

function fakePack(overrides: Partial<CatalogPack> = {}): CatalogPack {
  return {
    id: "fake-pack",
    name: "Fake pack",
    description: "A test pack",
    schedule: { cron: "0 1 * * *" },
    openPr: true,
    version: 1,
    allowNoChanges: true,
    prompt: "Do one safe thing.\n",
    promptFile: "prompt.md",
    dir: "/tmp",
    ...overrides,
  };
}

describe("installCatalogPack", () => {
  let rootDir: string;
  let workspaceDir: string;
  let previousOverride: string | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "pack-install-"));
    workspaceDir = join(rootDir, "workspace");
    previousOverride = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    runWorkerScaffold();
  });

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = previousOverride;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("installs a bundled pack as a valid, runnable automation", () => {
    const pack = loadCatalogPack("dependency-security");
    const result = installCatalogPack({ workspaceDir, pack });

    expect(result.added).toBe(true);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    const automation = config.automations.find((entry) => entry.id === "dependency-security");
    expect(automation).toBeDefined();
    expect(automation?.enabled).toBe(true);
    expect(automation?.cron).toBe("0 8 * * 1");
    expect(automation?.openPr).toBe(true);
    expect(automation?.allowNoChanges).toBe(true);
    // The prompt round-trips exactly through the multi-line TOML string.
    expect(automation?.prompt).toBe(pack.prompt.trimEnd());
  });

  test("installs every bundled pack into one workspace", () => {
    const { packs, issues } = listCatalogPacks();
    expect(issues).toEqual([]);
    for (const summary of packs) {
      expect(installCatalogPack({ workspaceDir, pack: loadCatalogPack(summary.id) }).added).toBe(
        true,
      );
    }
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations.map((entry) => entry.id)).toEqual(packs.map((pack) => pack.id));
  });

  test("writes a readable multi-line prompt and a pack version marker", () => {
    installCatalogPack({
      workspaceDir,
      pack: fakePack({ prompt: 'Search "my-pack in:title".\n\nThen report.\n', version: 3 }),
    });
    const text = readFileSync(workspaceConfigPath(workspaceDir), "utf8");
    expect(text).toContain('# Installed from automation pack "fake-pack" (version 3).');
    expect(text).toContain('prompt = """\nSearch "my-pack in:title".\n\nThen report."""');
    expect(text).toContain("allow_no_changes = true");
  });

  test("is idempotent for an identical install", () => {
    const pack = loadCatalogPack("docs-drift");
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(true);
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(false);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations.filter((entry) => entry.id === "docs-drift")).toHaveLength(1);
  });

  test("supports an id override and installing disabled", () => {
    installCatalogPack({
      workspaceDir,
      pack: loadCatalogPack("flaky-test-finder"),
      id: "flaky-web",
      disabled: true,
    });
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    const automation = config.automations.find((entry) => entry.id === "flaky-web");
    expect(automation?.enabled).toBe(false);
  });

  test("refuses a conflicting existing id", () => {
    installCatalogPack({ workspaceDir, pack: loadCatalogPack("docs-drift") });
    expect(() =>
      installCatalogPack({
        workspaceDir,
        pack: loadCatalogPack("ci-red-fixer"),
        id: "docs-drift",
      }),
    ).toThrow(/already exists/);
  });

  test("reports a conflict when a repeat install changes enabled", () => {
    const pack = loadCatalogPack("docs-drift");
    installCatalogPack({ workspaceDir, pack, disabled: true });
    expect(() => installCatalogPack({ workspaceDir, pack })).toThrow(/already exists/);
  });

  test("reports a conflict when the installed prompt was edited", () => {
    installCatalogPack({ workspaceDir, pack: fakePack() });
    expect(() =>
      installCatalogPack({ workspaceDir, pack: fakePack({ prompt: "Do another thing.\n" }) }),
    ).toThrow(/already exists/);
  });

  test("requires --repo in a multi-repo workspace and validates the name", () => {
    writeFileSync(
      workspaceConfigPath(workspaceDir),
      `[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
`,
    );
    const pack = loadCatalogPack("ci-red-fixer");
    expect(() => installCatalogPack({ workspaceDir, pack })).toThrow(/multiple repositories/);
    expect(() => installCatalogPack({ workspaceDir, pack, repo: "nope" })).toThrow(
      /does not match any/,
    );

    installCatalogPack({ workspaceDir, pack, repo: "backend" });
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations[0]?.repo).toBe("backend");
  });

  test("rejects an unsafe id override before writing", () => {
    expect(() => installCatalogPack({ workspaceDir, pack: fakePack(), id: "../escape" })).toThrow(
      /Invalid automation id/,
    );
    expect(loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).automations).toHaveLength(0);
  });

  test("fails without a workspace.toml", () => {
    const emptyDir = join(rootDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    expect(() => installCatalogPack({ workspaceDir: emptyDir, pack: fakePack() })).toThrow(
      /No workspace.toml/,
    );
  });
});

describe("tomlBasicString", () => {
  test("escapes quotes, backslashes, and newlines", () => {
    expect(tomlBasicString('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
  });
});

describe("tomlMultilineString", () => {
  const roundTrip = (value: string): string => {
    const config = parseWorkspaceConfig(
      `[defaults]\ntracker = "jira"\n\n[[automations]]\nid = "x"\nenabled = true\ninterval = "1d"\nprompt = ${tomlMultilineString(value)}\n`,
      "test.toml",
    );
    return config.automations[0]?.prompt ?? "";
  };

  test.each([
    "plain text",
    'quoted "word" and a "trailing quote"',
    'triple """ quotes and """" more',
    'ends with two quotes ""',
    "back\\slash and \\n literal",
    "tab\tand\nnewlines\n\nkept",
    "bell\u0007 and escape\u001b",
  ])("round-trips %p", (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  test("normalizes CRLF to LF", () => {
    expect(roundTrip("a\r\nb")).toBe("a\nb");
  });
});
