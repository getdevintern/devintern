import { describe, expect, test } from "bun:test";
import {
  EXAMPLE_HARNESS_IDS,
  GIT_DOWNLOAD_URL,
  gitInstallHint,
  harnessInstallHint,
  isToolValidationBlocking,
} from "./tool-validation.ts";
import type { HarnessHintSource, ToolValidation } from "./tool-validation.ts";

const registry: HarnessHintSource[] = [
  { name: "claude-code", displayName: "Claude Code", defaultPath: "claude" },
  { name: "opencode", displayName: "OpenCode", defaultPath: "opencode" },
  { name: "codex", displayName: "Codex", defaultPath: "codex" },
  { name: "cursor", displayName: "Cursor", defaultPath: "cursor-agent" },
  { name: "grok", displayName: "Grok", defaultPath: "grok" },
];

describe("gitInstallHint", () => {
  test("macOS mentions Xcode tools and Homebrew", () => {
    const hint = gitInstallHint("darwin");
    expect(hint).toContain("xcode-select --install");
    expect(hint).toContain("brew install git");
  });

  test("Linux mentions apt and dnf", () => {
    const hint = gitInstallHint("linux");
    expect(hint).toContain("sudo apt install git");
    expect(hint).toContain("sudo dnf install git");
  });

  test("Windows points at the official downloads page", () => {
    const hint = gitInstallHint("win32");
    expect(hint).toContain(GIT_DOWNLOAD_URL);
  });
});

describe("harnessInstallHint", () => {
  test("names well-known CLIs that exist in the registry", () => {
    const hint = harnessInstallHint(registry);
    expect(hint).toContain("Claude Code (`claude`)");
    expect(hint).toContain("OpenCode (`opencode`)");
    expect(hint).toContain("Codex (`codex`)");
    expect(hint).toContain("Cursor (`cursor-agent`)");
    expect(hint).toContain("AGENT_CLI_PATH");
    expect(hint).toContain("~/.local/bin");
    expect(hint).toContain("and others");
  });

  test("falls back to the provided list when examples are absent", () => {
    const hint = harnessInstallHint([
      { name: "grok", displayName: "Grok", defaultPath: "grok" },
      { name: "pi", displayName: "Pi", defaultPath: "pi" },
    ]);
    expect(hint).toContain("Grok (`grok`)");
    expect(hint).toContain("Pi (`pi`)");
    expect(hint).not.toContain("Claude Code");
  });

  test("example ids stay a short curated set", () => {
    expect(EXAMPLE_HARNESS_IDS).toEqual(["claude-code", "opencode", "codex", "cursor"]);
  });
});

describe("isToolValidationBlocking", () => {
  const ok: ToolValidation = {
    ok: true,
    tools: [],
    warnings: [],
    installedHarnesses: [],
  };

  test("blocks only a completed failed check", () => {
    expect(isToolValidationBlocking(undefined)).toBe(false);
    expect(isToolValidationBlocking(null)).toBe(false);
    expect(isToolValidationBlocking(ok)).toBe(false);
    expect(isToolValidationBlocking({ ...ok, ok: false })).toBe(true);
  });
});
