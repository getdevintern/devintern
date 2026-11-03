import { afterEach, describe, expect, test } from "bun:test";

import { getHarness } from "@devintern/agent-harness";
import type { ResolvedHarness } from "@devintern/agent-harness";

import {
  ExecutionPreferencesError,
  resolveExecutionPreferences,
} from "../src/lib/agent/execution-preferences";
import { resolveAgentEffort, resolveAgentModel } from "../src/lib/agent/model";
import {
  clearAgentRuntimeOverrides,
  setAgentRuntimeOverrides,
} from "../src/lib/agent/runtime-overrides";
import { Utils } from "../src/lib/utils";

const ENV_KEYS = [
  "AGENT_MODEL",
  "AGENT_EFFORT",
  "OPENCODE_CLI_PATH",
  "CURSOR_CLI_PATH",
  "CLAUDE_CODE_MODEL",
] as const;

afterEach(() => {
  clearAgentRuntimeOverrides();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

function agent(name: string, path = "/bin/true"): ResolvedHarness {
  const harness = getHarness(name);
  if (!harness) {
    throw new Error(`test harness not registered: ${name}`);
  }
  return { harness, path };
}

describe("extractExecutionPreferences", () => {
  test("extracts harness, model, and effort from a description", () => {
    const { preferences, conflicts } = Utils.extractExecutionPreferences(
      "Fix the bug\nHarness: opencode\nModel: astra\nEffort: high",
    );
    expect(preferences).toEqual({ harness: "opencode", model: "astra", effort: "high" });
    expect(conflicts).toEqual([]);
  });

  test("tolerates markdown formatting and headings", () => {
    const { preferences } = Utils.extractExecutionPreferences(
      "## **Harness**: codex\n- **Model**: gpt-5.2\n*Effort*: low",
    );
    expect(preferences).toEqual({ harness: "codex", model: "gpt-5.2", effort: "low" });
  });

  test("ignores ordinary prose that merely contains the words", () => {
    const { preferences } = Utils.extractExecutionPreferences(
      "The model should be chosen by the harness. No preference here.",
    );
    expect(preferences).toEqual({});
  });

  test("returns empty preferences for an undefined description", () => {
    expect(Utils.extractExecutionPreferences(undefined)).toEqual({
      preferences: {},
      conflicts: [],
    });
  });

  test("collapses repeated identical values without a conflict", () => {
    const { preferences, conflicts } = Utils.extractExecutionPreferences(
      "Harness: opencode\nHarness: opencode",
    );
    expect(preferences.harness).toBe("opencode");
    expect(conflicts).toEqual([]);
  });

  test("reports conflicting values for the same field", () => {
    const { conflicts } = Utils.extractExecutionPreferences("Harness: opencode\nHarness: codex");
    expect(conflicts).toEqual([{ field: "harness", values: ["opencode", "codex"] }]);
  });

  test("coexists with target-branch selection", () => {
    const description =
      "Implement the thing\nTarget branch: develop\nHarness: codex\nModel: gpt\nEffort: low";
    expect(Utils.extractTargetBranch(description)).toBe("develop");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
      model: "gpt",
      effort: "low",
    });
  });
});

describe("resolveExecutionPreferences — no preferences", () => {
  test("returns the current agent unchanged", () => {
    const current = agent("claude-code");
    const result = resolveExecutionPreferences({
      description: "Just a task",
      currentAgent: current,
    });
    expect(result.agent).toBe(current);
    expect(result.modelOverride).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.effortIgnored).toBe(false);
    expect(result.notes).toEqual([]);
  });
});

describe("resolveExecutionPreferences — harness", () => {
  test("switches harness and resolves its executable", () => {
    process.env.OPENCODE_CLI_PATH = "/bin/true";
    const result = resolveExecutionPreferences({
      description: "Harness: opencode",
      currentAgent: agent("claude-code"),
    });
    expect(result.agent.harness.name).toBe("opencode");
    expect(result.notes.join("\n")).toContain("Harness: Opencode (opencode)");
  });

  test("fails with the available harnesses for an unknown name", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: "Harness: not-a-harness",
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(ExecutionPreferencesError);
    expect(() =>
      resolveExecutionPreferences({
        description: "Harness: not-a-harness",
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/Unknown agent harness "not-a-harness".*Available harnesses:/);
  });

  test("suppresses the harness-specific AGENT_MODEL when only the harness changes", () => {
    process.env.AGENT_MODEL = "sonnet";
    process.env.OPENCODE_CLI_PATH = "/bin/true";
    const result = resolveExecutionPreferences({
      description: "Harness: opencode",
      currentAgent: agent("claude-code"),
    });
    expect(result.modelOverride).toBeNull();
    expect(result.displayModel).toBeUndefined();
  });
});

describe("resolveExecutionPreferences — model", () => {
  test("resolves a family alias to a concrete model", () => {
    const result = resolveExecutionPreferences({
      description: "Model: astra",
      currentAgent: agent("claude-code"),
    });
    expect(result.modelOverride).toBe("claude-opus-4-6");
    expect(result.modelAlias).toBe("astra");
    expect(result.notes.join("\n")).toContain('Model: claude-opus-4-6 (alias "astra")');
  });

  test("passes an exact model identifier through", () => {
    const result = resolveExecutionPreferences({
      description: "Model: gpt-5.2-codex",
      currentAgent: agent("codex"),
    });
    expect(result.modelOverride).toBe("gpt-5.2-codex");
    expect(result.modelAlias).toBeUndefined();
  });

  test("fails when the model family is incompatible with the harness", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: "Model: astra",
        currentAgent: agent("goose"),
      }),
    ).toThrow(/not available for harness "goose"/);
  });
});

describe("resolveExecutionPreferences — effort", () => {
  test("applies effort when the harness supports it", () => {
    const result = resolveExecutionPreferences({
      description: "Effort: high",
      currentAgent: agent("claude-code"),
    });
    expect(result.effort).toBe("high");
    expect(result.effortIgnored).toBe(false);
    expect(result.notes.join("\n")).toContain("Effort: high");
  });

  test("ignores effort when the harness does not support it", () => {
    const result = resolveExecutionPreferences({
      description: "Effort: high",
      currentAgent: agent("cursor"),
    });
    expect(result.effort).toBeUndefined();
    expect(result.effortIgnored).toBe(true);
    expect(result.notes.join("\n")).toContain("does not support reasoning effort");
  });

  test("ignores an invalid effort on a harness that does not support it", () => {
    const result = resolveExecutionPreferences({
      description: "Effort: turbo",
      currentAgent: agent("cursor"),
    });
    expect(result.effort).toBeUndefined();
    expect(result.effortIgnored).toBe(true);
    expect(result.notes.join("\n")).toContain('Effort "turbo" ignored');
  });

  test("fails on an invalid effort value", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: "Effort: turbo",
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/Invalid effort "turbo"/);
  });
});

describe("resolveExecutionPreferences — conflicts", () => {
  test("fails with actionable feedback on conflicting values", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: "Harness: opencode\nHarness: codex",
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/Conflicting execution preferences/);
  });
});

describe("resolveAgentModel / resolveAgentEffort runtime overrides", () => {
  test("a per-task model override wins over AGENT_MODEL", () => {
    process.env.AGENT_MODEL = "sonnet";
    setAgentRuntimeOverrides({ model: "claude-opus-4-6" });
    expect(resolveAgentModel()).toBe("claude-opus-4-6");
  });

  test("a null model override suppresses AGENT_MODEL", () => {
    process.env.AGENT_MODEL = "sonnet";
    setAgentRuntimeOverrides({ model: null });
    expect(resolveAgentModel()).toBeUndefined();
  });

  test("a per-task effort override wins over AGENT_EFFORT", () => {
    process.env.AGENT_EFFORT = "low";
    setAgentRuntimeOverrides({ effort: "high" });
    expect(resolveAgentEffort()).toBe("high");
  });

  test("clearing overrides restores the environment defaults", () => {
    process.env.AGENT_MODEL = "sonnet";
    setAgentRuntimeOverrides({ model: "claude-opus-4-6" });
    clearAgentRuntimeOverrides();
    expect(resolveAgentModel("claude-code")).toBe("sonnet");
  });
});
