import { describe, expect, test } from "bun:test";
import type { AgentHarness } from "@devintern/agent-harness";
import { validateRequiredTools } from "./validate-tools.ts";

function fakeHarness(name: string, displayName: string, defaultPath: string): AgentHarness {
  return {
    name,
    displayName,
    defaultPath,
    buildArgs: () => [],
  };
}

const claude = fakeHarness("claude-code", "Claude Code", "claude");
const opencode = fakeHarness("opencode", "OpenCode", "opencode");

describe("validateRequiredTools", () => {
  test("re-applies PATH augmentation before probing", () => {
    let augmented = false;
    validateRequiredTools({
      augmentPath: () => {
        augmented = true;
      },
      findGit: () => "/usr/bin/git",
      probeGit: () => true,
      listInstalled: () => [claude],
      listAll: () => [claude, opencode],
    });
    expect(augmented).toBe(true);
  });

  test("is ok when git and at least one harness CLI are present", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => "/usr/bin/git",
      probeGit: () => true,
      listInstalled: () => [claude, opencode],
      listAll: () => [claude, opencode],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.installedHarnesses).toEqual([
      { name: "claude-code", displayName: "Claude Code" },
      { name: "opencode", displayName: "OpenCode" },
    ]);
    const git = result.tools.find((t) => t.id === "git");
    const harness = result.tools.find((t) => t.id === "agent-harness");
    expect(git).toMatchObject({ required: true, found: true, detail: "/usr/bin/git" });
    expect(git?.hint).toBeUndefined();
    expect(harness).toMatchObject({
      required: true,
      found: true,
      detail: "Claude Code, OpenCode",
    });
    expect(harness?.hint).toBeUndefined();
  });

  test("fails with a Git install hint when git is missing", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => null,
      listInstalled: () => [claude],
      listAll: () => [claude],
      platform: "darwin",
    });
    expect(result.ok).toBe(false);
    const git = result.tools.find((t) => t.id === "git");
    expect(git?.found).toBe(false);
    expect(git?.hint).toContain("xcode-select --install");
    expect(git?.docsUrl).toContain("git-scm.com");
    expect(result.tools.find((t) => t.id === "agent-harness")?.found).toBe(true);
  });

  test("fails when no harness CLI is installed, even if git is present", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => "/usr/bin/git",
      probeGit: () => true,
      listInstalled: () => [],
      listAll: () => [claude, opencode],
    });
    expect(result.ok).toBe(false);
    const harness = result.tools.find((t) => t.id === "agent-harness");
    expect(harness?.found).toBe(false);
    expect(harness?.hint).toContain("Claude Code (`claude`)");
    expect(harness?.hint).toContain("OpenCode (`opencode`)");
    expect(result.installedHarnesses).toEqual([]);
  });

  test("one installed harness satisfies the agent requirement", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => "/opt/homebrew/bin/git",
      probeGit: () => true,
      listInstalled: () => [opencode],
      listAll: () => [claude, opencode],
    });
    expect(result.ok).toBe(true);
    expect(result.tools.every((t) => t.found)).toBe(true);
    expect(result.installedHarnesses).toEqual([{ name: "opencode", displayName: "OpenCode" }]);
  });

  test("default probe returns a structured result against the real PATH", () => {
    const original = process.env.PATH;
    try {
      const result = validateRequiredTools();
      expect(result.tools.map((t) => t.id)).toEqual(["git", "agent-harness"]);
      expect(typeof result.ok).toBe("boolean");
      expect(Array.isArray(result.warnings)).toBe(true);
    } finally {
      process.env.PATH = original;
    }
  });

  test("fails when Git resolves on PATH but cannot be invoked", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => "/usr/bin/git",
      probeGit: () => false,
      listInstalled: () => [claude],
      listAll: () => [claude],
      platform: "darwin",
    });

    expect(result.ok).toBe(false);
    expect(result.tools.find((tool) => tool.id === "git")?.found).toBe(false);
  });

  test.each([
    ["global", { AGENT_HARNESS: "opencode", AGENT_CLI_PATH: "/custom/global-agent" }],
    ["harness-specific", { AGENT_HARNESS: "opencode", OPENCODE_CLI_PATH: "/custom/opencode" }],
  ])("honors a process-level %s CLI override for the active harness", (_kind, env) => {
    const previousHarness = process.env.AGENT_HARNESS;
    const previousGlobalPath = process.env.AGENT_CLI_PATH;
    const previousHarnessPath = process.env.OPENCODE_CLI_PATH;
    delete process.env.AGENT_CLI_PATH;
    delete process.env.OPENCODE_CLI_PATH;
    Object.assign(process.env, env);
    try {
      const result = validateRequiredTools({
        augmentPath: () => {},
        findGit: () => "/usr/bin/git",
        probeGit: () => true,
        listInstalled: ({ currentHarnessName } = {}) =>
          currentHarnessName === "opencode" &&
          (process.env.AGENT_CLI_PATH || process.env.OPENCODE_CLI_PATH)
            ? [opencode]
            : [],
        listAll: () => [claude, opencode],
      });

      expect(result.ok).toBe(true);
      expect(result.installedHarnesses).toContainEqual({
        name: "opencode",
        displayName: "OpenCode",
      });
    } finally {
      if (previousHarness === undefined) delete process.env.AGENT_HARNESS;
      else process.env.AGENT_HARNESS = previousHarness;
      if (previousGlobalPath === undefined) delete process.env.AGENT_CLI_PATH;
      else process.env.AGENT_CLI_PATH = previousGlobalPath;
      if (previousHarnessPath === undefined) delete process.env.OPENCODE_CLI_PATH;
      else process.env.OPENCODE_CLI_PATH = previousHarnessPath;
    }
  });

  test("honors project-local active harness and CLI path overrides", () => {
    const originalHarness = process.env.AGENT_HARNESS;
    const originalPath = process.env.AGENT_CLI_PATH;
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => "/usr/bin/git",
      probeGit: () => true,
      envOverrides: {
        AGENT_HARNESS: "opencode",
        AGENT_CLI_PATH: "/project/local-agent",
      },
      listInstalled: ({ currentHarnessName } = {}) =>
        currentHarnessName === "opencode" && process.env.AGENT_CLI_PATH === "/project/local-agent"
          ? [opencode]
          : [],
      listAll: () => [claude, opencode],
    });

    expect(result.ok).toBe(true);
    expect(result.installedHarnesses).toEqual([{ name: "opencode", displayName: "OpenCode" }]);
    expect(process.env.AGENT_HARNESS).toBe(originalHarness);
    expect(process.env.AGENT_CLI_PATH).toBe(originalPath);
  });

  test("reports both required tools missing without a stack trace", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => null,
      listInstalled: () => [],
      listAll: () => [claude],
      platform: "linux",
    });
    expect(result.ok).toBe(false);
    expect(result.tools.filter((t) => t.required && !t.found)).toHaveLength(2);
    for (const tool of result.tools) {
      expect(tool.hint).toBeTruthy();
      expect(tool.hint).not.toMatch(/Error:|ENOENT|spawn /);
    }
  });
});
