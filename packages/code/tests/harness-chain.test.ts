import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  HarnessChainValidationError,
  parseHarnessChain,
  resolveHarnessCandidates,
  warnDeprecatedChainAliases,
} from "../src/lib/harness-chain";
import { getHarness } from "@devintern/agent-harness";

describe("parseHarnessChain", () => {
  test("unset value defaults to claude-code", () => {
    expect(parseHarnessChain(undefined)).toEqual([
      { raw: "claude-code", canonical: "claude-code" },
    ]);
    expect(parseHarnessChain("")).toEqual([{ raw: "claude-code", canonical: "claude-code" }]);
    expect(parseHarnessChain("   ")).toEqual([{ raw: "claude-code", canonical: "claude-code" }]);
  });

  test("single value keeps its configured spelling and resolves to itself", () => {
    expect(parseHarnessChain("codex")).toEqual([{ raw: "codex", canonical: "codex" }]);
  });

  test("whitespace around comma-separated entries is ignored", () => {
    const entries = parseHarnessChain("  claude-code ,  codex ,opencode  ");
    expect(entries.map((e) => e.raw)).toEqual(["claude-code", "codex", "opencode"]);
    expect(entries.map((e) => e.canonical)).toEqual(["claude-code", "codex", "opencode"]);
  });

  test("preserves configured order", () => {
    const entries = parseHarnessChain("opencode,claude-code,codex");
    expect(entries.map((e) => e.canonical)).toEqual(["opencode", "claude-code", "codex"]);
  });

  test("resolves aliases consistently with the registry", () => {
    const entries = parseHarnessChain("agy,codex");
    expect(entries.map((e) => e.raw)).toEqual(["agy", "codex"]);
    expect(entries.map((e) => e.canonical)).toEqual(["antigravity", "codex"]);
  });

  test("deduplicates canonical names keeping the first occurrence", () => {
    const entries = parseHarnessChain("claude-code,agy,codex,antigravity,claude-code");
    expect(entries.map((e) => e.raw)).toEqual(["claude-code", "agy", "codex"]);
    expect(entries.map((e) => e.canonical)).toEqual(["claude-code", "antigravity", "codex"]);
  });

  test("unknown harness fails validation identifying the value and supported list", () => {
    let error: HarnessChainValidationError | undefined;
    try {
      parseHarnessChain("claude-code,nope-cli,codex");
    } catch (err) {
      error = err as HarnessChainValidationError;
    }
    expect(error).toBeInstanceOf(HarnessChainValidationError);
    expect(error?.invalidValue).toBe("nope-cli");
    expect(error?.message).toContain('Unknown agent harness: "nope-cli"');
    expect(error?.message).toContain('"claude-code"');
    expect(error?.message).toContain('"codex"');
  });

  test("empty entries fail validation before execution, quoting the value", () => {
    for (const bad of [",", " , ", "claude-code,,codex", "codex,"]) {
      let error: HarnessChainValidationError | undefined;
      try {
        parseHarnessChain(bad);
      } catch (err) {
        error = err as HarnessChainValidationError;
      }
      expect(error).toBeInstanceOf(HarnessChainValidationError);
      expect(error?.message).toContain("empty entry");
      expect(error?.message).toContain('"claude-code"');
    }
  });
});

describe("resolveHarnessCandidates", () => {
  const savedEnv = new Map<string, string | undefined>();
  const managedKeys = [
    "AGENT_CLI_PATH",
    "CLAUDE_CLI_PATH",
    "CODEX_CLI_PATH",
    "OPENCODE_CLI_PATH",
    "ANTIGRAVITY_CLI_PATH",
    "AGY_CLI_PATH",
    "GEMINI_CLI_PATH",
  ];

  beforeEach(() => {
    for (const key of managedKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("single candidate falls back to the harness default command", () => {
    const [candidate] = resolveHarnessCandidates(parseHarnessChain("codex"));
    expect(candidate?.isPrimary).toBe(true);
    expect(candidate?.resolved.harness.name).toBe("codex");
    expect(candidate?.resolved.path).toBe(getHarness("codex")!.defaultPath);
  });

  test("AGENT_CLI_PATH applies to the primary only", () => {
    process.env.AGENT_CLI_PATH = "/global/primary-cli";

    const candidates = resolveHarnessCandidates(parseHarnessChain("codex,opencode"));
    expect(candidates[0]?.resolved.path).toBe("/global/primary-cli");
    expect(candidates[1]?.resolved.path).toBe(getHarness("opencode")!.defaultPath);
  });

  test("harness-specific path variables resolve each candidate independently", () => {
    process.env.CLAUDE_CLI_PATH = "/custom/claude";
    process.env.OPENCODE_CLI_PATH = "/custom/opencode";

    const candidates = resolveHarnessCandidates(parseHarnessChain("claude-code,opencode"));
    expect(candidates[0]?.resolved.path).toBe("/custom/claude");
    expect(candidates[1]?.resolved.path).toBe("/custom/opencode");
  });

  test("AGENT_CLI_PATH takes precedence over harness-specific variables (primary)", () => {
    process.env.AGENT_CLI_PATH = "/global/primary-cli";
    process.env.CLAUDE_CLI_PATH = "/custom/claude";

    const candidates = resolveHarnessCandidates(parseHarnessChain("claude-code,codex"));
    // Same precedence as the historical single-value resolver.
    expect(candidates[0]?.resolved.path).toBe("/global/primary-cli");
    expect(candidates[1]?.resolved.path).toBe(getHarness("codex")!.defaultPath);
  });

  test("an explicit cliPath override wins for the primary and never leaks to fallbacks", () => {
    process.env.OPENCODE_CLI_PATH = "/custom/opencode";

    const candidates = resolveHarnessCandidates(parseHarnessChain("claude-code,opencode"), {
      cliPath: "/flag/claude",
    });
    expect(candidates[0]?.resolved.path).toBe("/flag/claude");
    expect(candidates[1]?.resolved.path).toBe("/custom/opencode");
  });

  test("a primary-specific path is not reused by fallback candidates", () => {
    process.env.CLAUDE_CLI_PATH = "/only/claude-installed-here";

    const candidates = resolveHarnessCandidates(parseHarnessChain("claude-code,codex"));
    expect(candidates[0]?.resolved.path).toBe("/only/claude-installed-here");
    expect(candidates[1]?.resolved.path).not.toBe("/only/claude-installed-here");
    expect(candidates[1]?.resolved.path).toBe(getHarness("codex")!.defaultPath);
  });

  test("positions and primary flags follow configured order", () => {
    const candidates = resolveHarnessCandidates(parseHarnessChain("codex, opencode , codex"));
    expect(candidates.map((c) => c.position)).toEqual([0, 1]);
    expect(candidates.map((c) => c.isPrimary)).toEqual([true, false]);
    expect(candidates.every((c) => getHarness(c.entry.canonical))).toBe(true);
  });
});

describe("deprecated alias warnings", () => {
  test("warnDeprecatedChainAliases warns once per alias per process", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const entries = parseHarnessChain("gemini,gemini", { warnDeprecated: false });
      warnDeprecatedChainAliases(entries);
      warnDeprecatedChainAliases(entries);
    } finally {
      console.warn = originalWarn;
    }
    const geminiWarnings = warnings.filter((w) => w.includes("gemini is deprecated"));
    // Once per process even across duplicate entries and repeated calls.
    expect(geminiWarnings.length).toBeLessThanOrEqual(1);
  });
});
