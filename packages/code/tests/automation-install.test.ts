import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import type { CatalogPack } from "../src/lib/automation/catalog";
import { loadCatalogPack } from "../src/lib/automation/catalog";
import { installCatalogPack, tomlBasicString } from "../src/lib/automation/install";
import { loadPipelineConfigFile, selectPipelineConfig } from "../src/lib/task/pipeline-selection";
import {
  WORKSPACE_PIPELINE_AUTOMATION_ENV,
  WORKSPACE_PIPELINE_DEFAULT_ENV,
} from "../src/lib/workspace/env";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import { runWorkerScaffold } from "../src/lib/workspace/init";
import { workspaceConfigPath } from "../src/lib/workspace/paths";

function fakePack(overrides: Partial<CatalogPack> = {}): CatalogPack {
  return {
    id: "fake-pack",
    name: "Fake pack",
    description: "A test pack",
    schedule: { cron: "0 1 * * *" },
    openPr: true,
    prompt: "Do one safe thing.\n",
    promptFile: "prompt.md",
    references: [],
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
    const result = installCatalogPack({
      workspaceDir,
      pack: loadCatalogPack("dependency-health"),
    });

    expect(result.added).toBe(true);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    const automation = config.automations.find((entry) => entry.id === "dependency-health");
    expect(automation).toBeDefined();
    expect(automation?.enabled).toBe(true);
    expect(automation?.cron).toBe("0 8 * * 1");
    expect(automation?.openPr).toBe(true);
    expect(automation?.prompt).toContain("dependency");
    // Newlines round-trip through the single-line TOML string.
    expect(automation?.prompt).toContain("\n");
  });

  test("is idempotent for an identical install", () => {
    const pack = loadCatalogPack("log-triage");
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(true);
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(false);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations.filter((entry) => entry.id === "log-triage")).toHaveLength(1);
  });

  test("supports an id override and installing disabled", () => {
    installCatalogPack({
      workspaceDir,
      pack: loadCatalogPack("log-triage"),
      id: "nightly-log-triage",
      disabled: true,
    });
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    const automation = config.automations.find((entry) => entry.id === "nightly-log-triage");
    expect(automation?.enabled).toBe(false);
  });

  test("refuses a conflicting existing id", () => {
    installCatalogPack({ workspaceDir, pack: loadCatalogPack("log-triage") });
    expect(() =>
      installCatalogPack({
        workspaceDir,
        pack: loadCatalogPack("dependency-health"),
        id: "log-triage",
      }),
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
    expect(() => installCatalogPack({ workspaceDir, pack: loadCatalogPack("log-triage") })).toThrow(
      /multiple repositories/,
    );
    expect(() =>
      installCatalogPack({ workspaceDir, pack: loadCatalogPack("log-triage"), repo: "nope" }),
    ).toThrow(/does not match any/);

    installCatalogPack({ workspaceDir, pack: loadCatalogPack("log-triage"), repo: "backend" });
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations[0]?.repo).toBe("backend");
  });

  test("writes a bundled pipeline scoped to the installed automation", () => {
    const result = installCatalogPack({
      workspaceDir,
      pack: fakePack({
        id: "with-pipeline",
        pipeline: {
          steps: [{ use: "implement" }, { use: "finalize" }],
          plugins: ["./steps/check.ts"],
        },
      }),
    });

    expect(result.pipelineFile).toBe(join("pipelines", "with-pipeline.json"));
    const pipelinePath = join(workspaceDir, result.pipelineFile as string);
    expect(existsSync(pipelinePath)).toBe(true);

    // Read the written file through the real loader the task path uses.
    const loaded = loadPipelineConfigFile(pipelinePath);
    expect(loaded.plugins).toEqual(["./steps/check.ts"]);
    expect(loaded.steps).toHaveLength(2);

    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    // The pipeline is scoped to the automation entry, never to the fleet default.
    expect(config.defaults.pipelineFile).toBeUndefined();
    expect(config.automations[0]?.pipelineFile).toBe("pipelines/with-pipeline.json");

    // End to end: an automation-scoped selection returns the steps and wins
    // over the workspace default.
    const defaultPath = join(workspaceDir, "pipelines", "default.json");
    writeFileSync(defaultPath, JSON.stringify({ steps: [{ use: "commit" }] }));
    const selected = selectPipelineConfig({
      settings: null,
      cwd: workspaceDir,
      env: {
        [WORKSPACE_PIPELINE_AUTOMATION_ENV]: pipelinePath,
        [WORKSPACE_PIPELINE_DEFAULT_ENV]: defaultPath,
      },
    });
    expect(selected.scope).toBe("automation");
    expect(selected.config?.steps).toHaveLength(2);
    expect(selected.config?.plugins).toEqual([resolve(dirname(pipelinePath), "./steps/check.ts")]);
  });

  test("leaves an existing workspace default pipeline untouched", () => {
    writeFileSync(
      workspaceConfigPath(workspaceDir),
      `[defaults]
tracker = "jira"
pipeline_file = "pipelines/fleet.json"
`,
    );
    const result = installCatalogPack({
      workspaceDir,
      pack: fakePack({
        id: "with-pipeline",
        pipeline: { steps: [{ use: "implement" }, { use: "finalize" }] },
      }),
    });

    expect(result.warnings).toEqual([]);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.defaults.pipelineFile).toBe("pipelines/fleet.json");
    expect(config.automations[0]?.pipelineFile).toBe("pipelines/with-pipeline.json");
  });

  test("is idempotent for a repeat install of a pack with a pipeline", () => {
    const pack = fakePack({
      id: "pipeline-idempotent",
      pipeline: { steps: [{ use: "implement" }, { use: "finalize" }] },
    });
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(true);
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(false);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations.filter((entry) => entry.id === "pipeline-idempotent")).toHaveLength(
      1,
    );
  });

  test("re-materializes a missing bundled pipeline on a repeat install", () => {
    const pack = fakePack({
      id: "pipeline-repair",
      pipeline: { steps: [{ use: "implement" }, { use: "finalize" }] },
    });
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(true);
    const pipelinePath = join(workspaceDir, "pipelines", "pipeline-repair.json");
    expect(existsSync(pipelinePath)).toBe(true);

    rmSync(pipelinePath);
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(false);
    expect(existsSync(pipelinePath)).toBe(true);
  });

  test("re-copies a missing reference file on a repeat install", () => {
    const packDir = join(rootDir, "repairpack");
    mkdirSync(join(packDir, "references"), { recursive: true });
    writeFileSync(join(packDir, "references", "notes.md"), "# Notes\n");
    const pack = fakePack({
      id: "ref-repair",
      dir: packDir,
      references: ["references/notes.md"],
    });
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(true);
    const copied = join(workspaceDir, "automation-packs", "ref-repair", "references", "notes.md");
    expect(existsSync(copied)).toBe(true);

    rmSync(copied);
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(false);
    expect(existsSync(copied)).toBe(true);
  });

  test("copies pack references and points the prompt at them", () => {
    const packDir = join(rootDir, "pack");
    mkdirSync(join(packDir, "references"), { recursive: true });
    writeFileSync(join(packDir, "references", "notes.md"), "# Notes\n");
    const result = installCatalogPack({
      workspaceDir,
      pack: fakePack({
        id: "with-refs",
        dir: packDir,
        references: ["references/notes.md"],
      }),
    });

    expect(result.referencesDir).toBeTruthy();
    // Declared references are pack-relative ("references/notes.md"); the copy
    // lands directly under the references dir, not a doubled references/ path.
    expect(existsSync(join(result.referencesDir as string, "notes.md"))).toBe(true);
    expect(existsSync(join(result.referencesDir as string, "references"))).toBe(false);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations[0]?.prompt).toContain(result.referencesDir as string);
  });

  test("treats a repeat install of a pack with references as idempotent", () => {
    const packDir = join(rootDir, "refpack");
    mkdirSync(join(packDir, "references"), { recursive: true });
    writeFileSync(join(packDir, "references", "notes.md"), "# Notes\n");
    const pack = fakePack({
      id: "ref-idempotent",
      dir: packDir,
      references: ["references/notes.md"],
    });

    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(true);
    expect(installCatalogPack({ workspaceDir, pack }).added).toBe(false);
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    expect(config.automations.filter((entry) => entry.id === "ref-idempotent")).toHaveLength(1);
  });

  test("reports a conflict when a repeat install changes enabled", () => {
    const pack = loadCatalogPack("log-triage");
    installCatalogPack({ workspaceDir, pack, disabled: true });
    expect(() => installCatalogPack({ workspaceDir, pack })).toThrow(/already exists/);
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
