import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHarnessList, resolveHarnessChain } from "../src/harness-chain.js";
import { resolveHarness } from "../src/resolver.js";
import { getHarness } from "../src/registry.js";

describe("parseHarnessList", () => {
  test("defaults to claude-code when raw is undefined", () => {
    expect(parseHarnessList(undefined)).toEqual(["claude-code"]);
  });

  test("defaults to claude-code when raw is empty or only separators", () => {
    expect(parseHarnessList("")).toEqual(["claude-code"]);
    expect(parseHarnessList(" , ,")).toEqual(["claude-code"]);
  });

  test("parses a single name", () => {
    expect(parseHarnessList("codex")).toEqual(["codex"]);
  });

  test("splits on commas, trims, and drops empty entries", () => {
    expect(parseHarnessList(" claude-code , codex ,, grok ")).toEqual([
      "claude-code",
      "codex",
      "grok",
    ]);
  });

  test("applies aliases to canonical names", () => {
    expect(parseHarnessList("agy")).toEqual(["antigravity"]);
    expect(parseHarnessList("gemini,codex")).toEqual(["antigravity", "codex"]);
  });

  test("de-duplicates canonical names keeping the first occurrence", () => {
    expect(parseHarnessList("codex, codex")).toEqual(["codex"]);
    expect(parseHarnessList("gemini, antigravity")).toEqual(["antigravity"]);
    expect(parseHarnessList("claude-code, agy, antigravity")).toEqual(["claude-code", "antigravity"]);
  });

  test("keeps unknown names so callers can warn about them", () => {
    expect(parseHarnessList("nope")).toEqual(["nope"]);
  });
});

describe("resolveHarness with comma-separated AGENT_HARNESS", () => {
  const originalEnv = { ...process.env };
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    delete process.env.AGENT_HARNESS;
    delete process.env.AGENT_CLI_PATH;
    warnings = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("uses the first (priority) entry of the list", () => {
    process.env.AGENT_HARNESS = "codex,claude-code";
    const result = resolveHarness();
    expect(result.harness.name).toBe("codex");
    expect(result.path).toBe("codex");
  });

  test("still warns when the first entry is a deprecated alias", () => {
    process.env.AGENT_HARNESS = "gemini,codex";
    const result = resolveHarness();
    expect(result.harness.name).toBe("antigravity");
    expect(warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  test("single value behaves exactly as before", () => {
    process.env.AGENT_HARNESS = "codex";
    expect(resolveHarness().harness.name).toBe("codex");
  });
});

describe("resolveHarnessChain", () => {
  const originalEnv = { ...process.env };
  let warnings: string[];
  const originalWarn = console.warn;

  const alwaysInstalled = () => true;

  beforeEach(() => {
    delete process.env.AGENT_HARNESS;
    delete process.env.AGENT_CLI_PATH;
    warnings = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("returns a single entry for a single-harness value", () => {
    const chain = resolveHarnessChain({ raw: "codex", isInstalled: alwaysInstalled });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex"]);
    expect(chain.multiHarness).toBe(false);
    expect(chain.issues).toEqual([]);
  });

  test("defaults to claude-code when raw is undefined", () => {
    const chain = resolveHarnessChain({ isInstalled: alwaysInstalled });
    expect(chain.entries.map((e) => e.name)).toEqual(["claude-code"]);
    expect(chain.parsed).toEqual(["claude-code"]);
  });

  test("keeps priority order and flags multi-harness chains", () => {
    const chain = resolveHarnessChain({
      raw: "codex, claude-code , grok",
      isInstalled: alwaysInstalled,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex", "claude-code", "grok"]);
    expect(chain.multiHarness).toBe(true);
  });

  test("skips unknown entries with a warning", () => {
    const chain = resolveHarnessChain({
      raw: "does-not-exist,codex",
      isInstalled: alwaysInstalled,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex"]);
    expect(chain.issues).toHaveLength(1);
    expect(chain.issues[0]!.reason).toBe("unknown");
    expect(chain.issues[0]!.requested).toBe("does-not-exist");
    expect(chain.issues[0]!.message).toContain("Available harnesses");
    expect(warnings).toEqual([]);
  });

  test("skips not-installed entries with a warning", () => {
    const chain = resolveHarnessChain({
      raw: "codex,grok",
      isInstalled: ({ name }) => name !== "codex",
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["grok"]);
    expect(chain.issues).toHaveLength(1);
    expect(chain.issues[0]!.reason).toBe("not-installed");
    expect(chain.issues[0]!.message).toContain("CODEX_CLI_PATH");
  });

  test("throws when every entry is unknown", () => {
    expect(() =>
      resolveHarnessChain({ raw: "nope, also-nope", isInstalled: alwaysInstalled }),
    ).toThrow("Unknown agent harness");
  });

  test("keeps the full list when everything is not installed", () => {
    const chain = resolveHarnessChain({
      raw: "codex,grok",
      isInstalled: () => false,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex", "grok"]);
    expect(chain.entries.every((e) => e.installed === false)).toBe(true);
  });

  test("checkInstalled=false skips installability probing", () => {
    const chain = resolveHarnessChain({ raw: "codex,grok", checkInstalled: false });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex", "grok"]);
    expect(chain.issues).toEqual([]);
  });

  test("AGENT_CLI_PATH applies to the primary entry only", () => {
    process.env.AGENT_CLI_PATH = "/custom/agent";
    const chain = resolveHarnessChain({ raw: "codex,grok", isInstalled: alwaysInstalled });
    expect(chain.entries[0]!.path).toBe("/custom/agent");
    expect(chain.entries[1]!.path).toBe("grok");
  });

  test("harness-specific env overrides resolve per entry", () => {
    process.env.GROK_CLI_PATH = "/custom/grok";
    const chain = resolveHarnessChain({ raw: "codex,grok", isInstalled: alwaysInstalled });
    expect(chain.entries[0]!.path).toBe("codex");
    expect(chain.entries[1]!.path).toBe("/custom/grok");
  });

  test("resolves registry harness objects on each entry", () => {
    const chain = resolveHarnessChain({ raw: "codex", isInstalled: alwaysInstalled });
    expect(chain.entries[0]!.harness).toBe(getHarness("codex"));
  });

  test("warns once for a deprecated alias inside the list", () => {
    const chain = resolveHarnessChain({ raw: "gemini,codex", isInstalled: alwaysInstalled });
    expect(chain.entries.map((e) => e.name)).toEqual(["antigravity", "codex"]);
    expect(warnings.filter((w) => w.includes("deprecated"))).toHaveLength(1);
  });

  test("warnDeprecated=false suppresses deprecation warnings", () => {
    resolveHarnessChain({
      raw: "gemini",
      warnDeprecated: false,
      isInstalled: alwaysInstalled,
    });
    expect(warnings).toEqual([]);
  });
});
