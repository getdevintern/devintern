import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InvalidAgentEffortError } from "@devintern/agent-harness";

import { harnessModelEnvKey, resolveAgentEffort, resolveAgentModel } from "../src/lib/agent/model";

const TOUCHED_ENV = [
  "AGENT_MODEL",
  "AGENT_EFFORT",
  "AGENT_HARNESS",
  "DEVINTERN_HARNESS_CHAIN",
  "OPENCODE_MODEL",
  "GROK_MODEL",
  "CLAUDE_CODE_MODEL",
  "ANTIGRAVITY_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveAgentModel", () => {
  test("returns undefined when AGENT_MODEL is unset", () => {
    expect(resolveAgentModel()).toBeUndefined();
  });

  test("returns the configured model", () => {
    process.env.AGENT_MODEL = "sonnet";
    expect(resolveAgentModel()).toBe("sonnet");
  });

  test("trims whitespace", () => {
    process.env.AGENT_MODEL = "  qwen3-coder-plus  ";
    expect(resolveAgentModel()).toBe("qwen3-coder-plus");
  });

  test("treats whitespace-only values as unset", () => {
    process.env.AGENT_MODEL = "   ";
    expect(resolveAgentModel()).toBeUndefined();
  });
});

describe("harnessModelEnvKey", () => {
  test("derives the per-harness model variable from the canonical name", () => {
    expect(harnessModelEnvKey("opencode")).toBe("OPENCODE_MODEL");
    expect(harnessModelEnvKey("claude-code")).toBe("CLAUDE_CODE_MODEL");
    expect(harnessModelEnvKey("kilo-code")).toBe("KILO_CODE_MODEL");
  });
});

describe("resolveAgentModel with a failover chain", () => {
  test("applies AGENT_MODEL to the primary harness", () => {
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    expect(resolveAgentModel("opencode")).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("does not leak AGENT_MODEL onto a fallback harness", () => {
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    expect(resolveAgentModel("grok")).toBeUndefined();
  });

  test("uses a per-harness model for a fallback", () => {
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    process.env.GROK_MODEL = "grok-4.7";
    expect(resolveAgentModel("grok")).toBe("grok-4.7");
    expect(resolveAgentModel("opencode")).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("lets a per-harness model override AGENT_MODEL on the primary", () => {
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    process.env.OPENCODE_MODEL = "opencode-go/deepseek-v4-pro";
    expect(resolveAgentModel("opencode")).toBe("opencode-go/deepseek-v4-pro");
  });

  test("worker child: a pinned fallback ignores AGENT_MODEL but honours its own override", () => {
    // runWithFailover pins AGENT_HARNESS to the active entry and passes the
    // original chain separately, because the child cannot see the chain.
    process.env.AGENT_HARNESS = "grok";
    process.env.DEVINTERN_HARNESS_CHAIN = "opencode,grok";
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    expect(resolveAgentModel()).toBeUndefined();

    process.env.GROK_MODEL = "grok-4.7";
    expect(resolveAgentModel()).toBe("grok-4.7");
  });

  test("worker child: the pinned primary still receives AGENT_MODEL", () => {
    process.env.AGENT_HARNESS = "opencode";
    process.env.DEVINTERN_HARNESS_CHAIN = "opencode,grok";
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    expect(resolveAgentModel()).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("canonicalizes alias names when comparing against the chain", () => {
    process.env.AGENT_HARNESS = "agy,codex";
    process.env.AGENT_MODEL = "gemini-4-argon-contributor";
    expect(resolveAgentModel("antigravity")).toBe("gemini-4-argon-contributor");
    expect(resolveAgentModel("codex")).toBeUndefined();
  });

  test("accepts an explicit chain for callers that resolved it already", () => {
    process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
    expect(resolveAgentModel("opencode", ["opencode", "grok"])).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );
    expect(resolveAgentModel("grok", ["opencode", "grok"])).toBeUndefined();
  });

  test("applies AGENT_MODEL to a single-entry chain", () => {
    process.env.AGENT_HARNESS = "codex";
    process.env.AGENT_MODEL = "gpt-5.6-luna";
    expect(resolveAgentModel("codex")).toBe("gpt-5.6-luna");
  });
});

describe("resolveAgentEffort", () => {
  test("returns undefined when AGENT_EFFORT is unset", () => {
    expect(resolveAgentEffort()).toBeUndefined();
  });

  test("returns the configured effort", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      process.env.AGENT_EFFORT = effort;
      expect(resolveAgentEffort()).toBe(effort);
    }
  });

  test("trims whitespace", () => {
    process.env.AGENT_EFFORT = "  high  ";
    expect(resolveAgentEffort()).toBe("high");
  });

  test("treats whitespace-only values as unset", () => {
    process.env.AGENT_EFFORT = "   ";
    expect(resolveAgentEffort()).toBeUndefined();
  });

  test("throws a clear error for invalid values", () => {
    process.env.AGENT_EFFORT = "ultra";
    expect(() => resolveAgentEffort()).toThrow(InvalidAgentEffortError);
    expect(() => resolveAgentEffort()).toThrow(
      /Invalid agent effort "ultra". Valid values: low, medium, high/,
    );
  });
});
