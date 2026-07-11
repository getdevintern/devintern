import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveHarness,
  findInPath,
  resolveExecutablePath,
  resolveExecutablePathStrict,
  resolveExecutablePathWithRetry,
} from "../src/resolver.js";

describe("resolveHarness", () => {
  const originalEnv = { ...process.env };
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    delete process.env.AGENT_HARNESS;
    delete process.env.AGENT_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.OPENCODE_CLI_PATH;
    delete process.env.ANTIGRAVITY_CLI_PATH;
    delete process.env.AGY_CLI_PATH;
    delete process.env.GEMINI_CLI_PATH;
    warnings = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    // Restore env without leaking deletes from beforeEach across tests.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("uses options.harnessName", () => {
    const result = resolveHarness({ harnessName: "opencode" });
    expect(result.harness.name).toBe("opencode");
    expect(result.path).toBe("opencode");
  });

  test("uses AGENT_HARNESS env var", () => {
    process.env.AGENT_HARNESS = "codex";
    const result = resolveHarness();
    expect(result.harness.name).toBe("codex");
  });

  test("defaults to claude-code when no hint is given", () => {
    const result = resolveHarness();
    expect(result.harness.name).toBe("claude-code");
  });

  test("throws for unknown harness name", () => {
    expect(() => resolveHarness({ harnessName: "unknown" })).toThrow("Unknown agent harness");
    expect(() => resolveHarness({ harnessName: "unknown" })).toThrow("Available harnesses:");
    expect(() => resolveHarness({ harnessName: "unknown" })).toThrow('"grok"');
    expect(() => resolveHarness({ harnessName: "unknown" })).toThrow('"deepseek"');
    expect(() => resolveHarness({ harnessName: "unknown" })).toThrow('"antigravity"');
  });

  test("uses options.cliPath", () => {
    const result = resolveHarness({ harnessName: "claude-code", cliPath: "/custom/claude" });
    expect(result.path).toBe("/custom/claude");
  });

  test("uses AGENT_CLI_PATH env var", () => {
    process.env.AGENT_CLI_PATH = "/global/agent";
    const result = resolveHarness();
    expect(result.path).toBe("/global/agent");
  });

  test("uses harness-specific env var", () => {
    process.env.OPENCODE_CLI_PATH = "/opencode/path";
    const result = resolveHarness({ harnessName: "opencode" });
    expect(result.path).toBe("/opencode/path");
  });

  test("falls back to CLAUDE_CLI_PATH for non-claude harnesses", () => {
    process.env.CLAUDE_CLI_PATH = "/claude/fallback";
    const result = resolveHarness({ harnessName: "kimi" });
    expect(result.path).toBe("/claude/fallback");
  });

  test("falls back to harness defaultPath", () => {
    const result = resolveHarness({ harnessName: "opencode" });
    expect(result.path).toBe("opencode");
  });

  test("uses envPrefix when provided", () => {
    process.env.MY_CUSTOM_PREFIX_CLI_PATH = "/custom/path";
    const result = resolveHarness({ harnessName: "opencode", envPrefix: "MY_CUSTOM_PREFIX" });
    expect(result.path).toBe("/custom/path");
    delete process.env.MY_CUSTOM_PREFIX_CLI_PATH;
  });

  test("resolves antigravity with defaultPath agy", () => {
    const result = resolveHarness({ harnessName: "antigravity" });
    expect(result.harness.name).toBe("antigravity");
    expect(result.path).toBe("agy");
    expect(warnings).toHaveLength(0);
  });

  test("resolves agy alias to antigravity without deprecation warning", () => {
    const result = resolveHarness({ harnessName: "agy" });
    expect(result.harness.name).toBe("antigravity");
    expect(result.path).toBe("agy");
    expect(warnings).toHaveLength(0);
  });

  test("resolves deprecated gemini alias to antigravity and warns once", () => {
    const result = resolveHarness({ harnessName: "gemini" });
    expect(result.harness.name).toBe("antigravity");
    expect(result.path).toBe("agy");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AGENT_HARNESS=gemini is deprecated");
    expect(warnings[0]).toContain("antigravity");
  });

  test("gemini alias via AGENT_HARNESS env still works and warns", () => {
    process.env.AGENT_HARNESS = "gemini";
    const result = resolveHarness();
    expect(result.harness.name).toBe("antigravity");
    expect(result.path).toBe("agy");
    expect(warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  test("uses ANTIGRAVITY_CLI_PATH for antigravity harness", () => {
    process.env.ANTIGRAVITY_CLI_PATH = "/opt/agy";
    const result = resolveHarness({ harnessName: "antigravity" });
    expect(result.path).toBe("/opt/agy");
  });

  test("uses AGY_CLI_PATH for antigravity harness", () => {
    process.env.AGY_CLI_PATH = "/usr/local/bin/agy";
    const result = resolveHarness({ harnessName: "antigravity" });
    expect(result.path).toBe("/usr/local/bin/agy");
  });

  test("ignores bare GEMINI_CLI_PATH=gemini and falls back to agy with warning", () => {
    process.env.GEMINI_CLI_PATH = "gemini";
    const result = resolveHarness({ harnessName: "antigravity" });
    expect(result.path).toBe("agy");
    expect(warnings.some((w) => w.includes("GEMINI_CLI_PATH is deprecated"))).toBe(true);
  });

  test("does not use retired gemini binary even when cliPath is gemini", () => {
    const result = resolveHarness({ harnessName: "antigravity", cliPath: "gemini" });
    expect(result.path).toBe("agy");
    expect(warnings.some((w) => w.includes("retired Gemini CLI"))).toBe(true);
  });

  test("warnDeprecated=false suppresses gemini deprecation warning", () => {
    const result = resolveHarness({ harnessName: "gemini", warnDeprecated: false });
    expect(result.harness.name).toBe("antigravity");
    expect(warnings).toHaveLength(0);
  });
});

describe("findInPath", () => {
  test("returns path when command exists", () => {
    const command = process.platform === "win32" ? "cmd" : "node";
    const result = findInPath(command);
    expect(result).not.toBeNull();
    expect(result).toContain(command);
  });

  test("returns null when command does not exist", () => {
    const result = findInPath("definitely-not-a-real-command-12345");
    expect(result).toBeNull();
  });
});

describe("resolveExecutablePath", () => {
  test("returns absolute path as-is", () => {
    expect(resolveExecutablePath("/usr/bin/claude")).toBe("/usr/bin/claude");
  });

  test("resolves relative path when it exists", () => {
    const result = resolveExecutablePath("./package.json");
    expect(result.endsWith("package.json")).toBe(true);
  });

  test("returns relative path unchanged when it does not exist", () => {
    const result = resolveExecutablePath("./does-not-exist-12345.json");
    expect(result).toBe("./does-not-exist-12345.json");
  });

  test("finds command in PATH", () => {
    const result = resolveExecutablePath("node");
    expect(result).not.toBe("node");
    expect(result.includes("node") || result.includes("bin")).toBe(true);
  });

  test("falls back to command name when not found anywhere", () => {
    const result = resolveExecutablePath("definitely-not-real-12345");
    expect(result).toBe("definitely-not-real-12345");
  });
});

describe("resolveExecutablePathStrict", () => {
  test("resolves a command found in PATH", () => {
    const result = resolveExecutablePathStrict("node", "Node");
    expect(result).not.toBe("node");
  });

  test("returns absolute paths as-is without PATH lookup", () => {
    expect(resolveExecutablePathStrict("/usr/bin/claude", "Claude Code")).toBe("/usr/bin/claude");
  });

  test("throws an actionable error when a bare command is not on PATH", () => {
    expect(() => resolveExecutablePathStrict("definitely-not-real-12345", "Claude Code")).toThrow(
      /Claude Code CLI not found.*not on your PATH.*AGENT_CLI_PATH/s,
    );
  });
});

describe("resolveExecutablePathWithRetry", () => {
  // Silence the retry warnings during these tests while still letting us assert
  // on them.
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    warnings = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("returns an existing absolute path immediately without retrying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolver-retry-"));
    const file = join(dir, "claude");
    writeFileSync(file, "");
    try {
      const result = await resolveExecutablePathWithRetry(file, { retries: 3, backoffMs: 5 });
      expect(result).toBe(file);
      expect(warnings).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves a bare command found on PATH", async () => {
    const result = await resolveExecutablePathWithRetry("node", { retries: 2, backoffMs: 5 });
    expect(result).not.toBe("node");
    expect(result.includes("node") || result.includes("bin")).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  test("returns best-effort path after exhausting retries when never found", async () => {
    const result = await resolveExecutablePathWithRetry("definitely-not-real-12345", {
      retries: 2,
      backoffMs: 1,
    });
    expect(result).toBe("definitely-not-real-12345");
    // One warning per attempt that failed.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("likely mid auto-update");
  });

  test("recovers once the executable appears mid-retry (the auto-update swap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolver-retry-"));
    const file = join(dir, "claude");
    // Create the file shortly after resolution starts, simulating an auto-update
    // finishing its symlink swap while we poll.
    setTimeout(() => writeFileSync(file, ""), 15);
    try {
      const result = await resolveExecutablePathWithRetry(file, { retries: 6, backoffMs: 10 });
      expect(result).toBe(file);
      // It had to wait at least one attempt, so at least one warning was emitted.
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honours AGENT_SPAWN_ENOENT_RETRIES env default", async () => {
    const original = process.env.AGENT_SPAWN_ENOENT_RETRIES;
    process.env.AGENT_SPAWN_ENOENT_RETRIES = "3";
    try {
      const result = await resolveExecutablePathWithRetry("definitely-not-real-12345", {
        backoffMs: 1,
      });
      expect(result).toBe("definitely-not-real-12345");
      expect(warnings).toHaveLength(3);
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_SPAWN_ENOENT_RETRIES;
      } else {
        process.env.AGENT_SPAWN_ENOENT_RETRIES = original;
      }
    }
  });
});
