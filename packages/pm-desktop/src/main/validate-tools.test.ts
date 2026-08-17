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
      listInstalled: () => [claude],
      listAll: () => [claude, opencode],
    });
    expect(augmented).toBe(true);
  });

  test("is ok when git and at least one harness CLI are present", () => {
    const result = validateRequiredTools({
      augmentPath: () => {},
      findGit: () => "/usr/bin/git",
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
