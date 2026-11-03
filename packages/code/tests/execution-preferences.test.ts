import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getHarness } from "@devintern/agent-harness";
import type { ResolvedHarness } from "@devintern/agent-harness";
import { extractTextFromADF } from "@devintern/task-trackers";
import type { AtlassianDocument } from "@devintern/task-trackers";

import {
  ExecutionPreferencesError,
  resolveExecutionPreferences,
} from "../src/lib/agent/execution-preferences";
import type { EffectiveExecutionPreferences } from "../src/lib/agent/execution-preferences";
import { resolveAgentEffort, resolveAgentModel } from "../src/lib/agent/model";
import {
  clearAgentRuntimeOverrides,
  getAgentRuntimeOverrides,
  setAgentRuntimeOverrides,
} from "../src/lib/agent/runtime-overrides";
import { runContext } from "../src/lib/cli/context";
import { applyExecutionSelection } from "../src/lib/task/pipeline";
import { Utils } from "../src/lib/utils";

const ENV_KEYS = [
  "AGENT_CLI_PATH",
  "AGENT_HARNESS",
  "AGENT_MODEL",
  "AGENT_EFFORT",
  "DEVINTERN_HARNESS_CHAIN",
  "DEVINTERN_WORKER_CHILD",
  "OPENCODE_CLI_PATH",
  "CURSOR_CLI_PATH",
  "CLAUDE_CODE_MODEL",
  "OPENCODE_MODEL",
  "GROK_MODEL",
  "KIMI_CLI_PATH",
  "GOOSE_CLI_PATH",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  clearAgentRuntimeOverrides();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function agent(name: string, path = "/bin/true"): ResolvedHarness {
  const harness = getHarness(name);
  if (!harness) {
    throw new Error(`test harness not registered: ${name}`);
  }
  return { harness, path };
}

/** Wrap preference lines in the explicit heading block the parser requires. */
function withPreferences(body: string): string {
  return `## Execution preferences\n${body}`;
}

describe("extractExecutionPreferences", () => {
  test("extracts harness, model, and effort from a description", () => {
    const { preferences, conflicts } = Utils.extractExecutionPreferences(
      `Fix the bug\n${withPreferences("Harness: opencode\nModel: astra\nEffort: high")}`,
    );
    expect(preferences).toEqual({ harness: "opencode", model: "astra", effort: "high" });
    expect(conflicts).toEqual([]);
  });

  test("tolerates markdown formatting and an HTML comment marker", () => {
    const { preferences } = Utils.extractExecutionPreferences(
      "<!-- devintern: **Harness**: codex -->\n<!-- devintern\n- **Model**: gpt-5.2\n*Effort*: low\n-->",
    );
    expect(preferences).toEqual({ harness: "codex", model: "gpt-5.2", effort: "low" });
  });

  test("ignores ordinary prose that merely contains the words", () => {
    const { preferences } = Utils.extractExecutionPreferences(
      "The model should be chosen by the harness. No preference here.",
    );
    expect(preferences).toEqual({});
  });

  test("ignores colon-containing prose outside an explicit block", () => {
    const description = [
      "Harness: the model to the database layer",
      "Model: gpt-4 returns a blank page",
      "Effort: high CPU usage was observed",
    ].join("\n");
    expect(Utils.extractExecutionPreferences(description)).toEqual({
      preferences: {},
      conflicts: [],
    });
  });

  test("does not let a dangling label consume the next line", () => {
    const { preferences } = Utils.extractExecutionPreferences(
      withPreferences("Model:\nHarness: codex"),
    );
    expect(preferences).toEqual({ harness: "codex" });
  });

  test("stops a heading section at the next heading", () => {
    const description = [
      "## Execution preferences",
      "Harness: codex",
      "## Notes",
      "Model: gpt-4 returns a blank page",
    ].join("\n");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
    });
  });

  test("reads a preference block from Jira ADF text whose heading lost its markup", () => {
    const adf: AtlassianDocument = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Execution preferences" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Harness: codex" }] },
        { type: "paragraph", content: [{ type: "text", text: "Model: astra" }] },
      ],
    };
    const description = extractTextFromADF(adf);
    expect(description).not.toContain("#");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
      model: "astra",
    });
  });

  test("ends a flattened heading block at a blank line", () => {
    const description = [
      "Execution preferences",
      "Harness: codex",
      "",
      "Model: gpt-4 returns a blank page",
    ].join("\n");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
    });
  });

  test("accepts a blank line between a flattened heading and the first field", () => {
    // Azure DevOps HTML flattening preserves the newline after </h2>, so the
    // heading and its first field are commonly separated by a blank line.
    const description = ["Execution preferences", "", "Harness: codex"].join("\n");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
    });
  });

  test("accepts blank lines between fields of a flattened block", () => {
    const description = [
      "Execution preferences",
      "",
      "Harness: codex",
      "",
      "Model: astra",
      "",
      "Effort: high",
      "",
      "Thanks for taking this on.",
    ].join("\n");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
      model: "astra",
      effort: "high",
    });
  });

  test("ignores a preference example inside a fenced code block", () => {
    const description = [
      "```markdown",
      "## Execution preferences",
      "Harness: codex",
      "Model: astra",
      "```",
    ].join("\n");
    expect(Utils.extractExecutionPreferences(description)).toEqual({
      preferences: {},
      conflicts: [],
    });
  });

  test("ignores a preference example inside HTML pre/code", () => {
    const description =
      "<pre><code>## Execution preferences\nHarness: codex\nModel: astra</code></pre>";
    expect(Utils.extractExecutionPreferences(description)).toEqual({
      preferences: {},
      conflicts: [],
    });
  });

  test("treats case-only repeats as the same preference", () => {
    const { preferences, conflicts } = Utils.extractExecutionPreferences(
      withPreferences(
        "Harness: opencode\nHarness: OpenCode\nModel: astra\nModel: Astra\nEffort: High\nEffort: high",
      ),
    );
    expect(conflicts).toEqual([]);
    expect(preferences).toEqual({ harness: "opencode", model: "astra", effort: "High" });
  });

  test("returns empty preferences for an undefined description", () => {
    expect(Utils.extractExecutionPreferences(undefined)).toEqual({
      preferences: {},
      conflicts: [],
    });
  });

  test("collapses repeated identical values without a conflict", () => {
    const { preferences, conflicts } = Utils.extractExecutionPreferences(
      withPreferences("Harness: opencode\nHarness: opencode"),
    );
    expect(preferences.harness).toBe("opencode");
    expect(conflicts).toEqual([]);
  });

  test("reports conflicting values for the same field", () => {
    const { conflicts } = Utils.extractExecutionPreferences(
      withPreferences("Harness: opencode\nHarness: codex"),
    );
    expect(conflicts).toEqual([{ field: "harness", values: ["opencode", "codex"] }]);
  });

  test("coexists with target-branch selection", () => {
    const description = `Implement the thing\nTarget branch: develop\n${withPreferences(
      "Harness: codex\nModel: gpt\nEffort: low",
    )}`;
    expect(Utils.extractTargetBranch(description)).toBe("develop");
    expect(Utils.extractExecutionPreferences(description).preferences).toEqual({
      harness: "codex",
      model: "gpt",
      effort: "low",
    });
  });

  test("preserves an OpenCode v2 model variant suffix", () => {
    const { preferences } = Utils.extractExecutionPreferences(
      withPreferences("Model: opencode-go/deepseek-v4.1-flash#high"),
    );
    expect(preferences.model).toBe("opencode-go/deepseek-v4.1-flash#high");
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
      description: withPreferences("Harness: opencode"),
      currentAgent: agent("claude-code"),
    });
    expect(result.agent.harness.name).toBe("opencode");
    expect(result.notes.join("\n")).toContain("Harness: Opencode (opencode)");
  });

  test("fails with the available harnesses for an unknown name", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: withPreferences("Harness: not-a-harness"),
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(ExecutionPreferencesError);
    expect(() =>
      resolveExecutionPreferences({
        description: withPreferences("Harness: not-a-harness"),
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/Unknown agent harness "not-a-harness".*Available harnesses:/);
  });

  test("suppresses the harness-specific AGENT_MODEL when only the harness changes", () => {
    process.env.AGENT_MODEL = "sonnet";
    process.env.OPENCODE_CLI_PATH = "/bin/true";
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: opencode"),
      currentAgent: agent("claude-code"),
    });
    expect(result.modelOverride).toBeNull();
    expect(result.displayModel).toBeUndefined();
  });

  test("keeps the switched harness's own <HARNESS>_MODEL", () => {
    process.env.AGENT_MODEL = "sonnet";
    process.env.OPENCODE_CLI_PATH = "/bin/true";
    process.env.OPENCODE_MODEL = "opencode-special";
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: opencode"),
      currentAgent: agent("claude-code"),
    });
    expect(result.modelOverride).toBeNull();
    expect(result.displayModel).toBe("opencode-special");
    expect(result.notes.join("\n")).toContain("Model: opencode-special");
  });

  test("wraps a missing task-selected CLI in ExecutionPreferencesError and points at <HARNESS>_CLI_PATH", () => {
    process.env.AGENT_CLI_PATH = "/bin/true";
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      let thrown: unknown;
      try {
        resolveExecutionPreferences({
          description: withPreferences("Harness: kimi"),
          currentAgent: agent("claude-code"),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExecutionPreferencesError);
      const message = (thrown as Error).message;
      expect(message).toContain("KIMI_CLI_PATH");
      expect(message).not.toContain("Kimi CLI CLI");
      expect(message).toContain("AGENT_CLI_PATH applies only");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("resolveExecutionPreferences — model", () => {
  test("resolves a family alias to a concrete model", () => {
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: astra"),
      currentAgent: agent("claude-code"),
    });
    expect(result.modelOverride).toBe("claude-opus-4-6");
    expect(result.modelAlias).toBe("astra");
    expect(result.notes.join("\n")).toContain('Model: claude-opus-4-6 (alias "astra")');
  });

  test("passes an exact model identifier through", () => {
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: gpt-5.2-codex"),
      currentAgent: agent("codex"),
    });
    expect(result.modelOverride).toBe("gpt-5.2-codex");
    expect(result.modelAlias).toBeUndefined();
  });

  test("does not leak a per-task model onto a fallback harness", () => {
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.GROK_MODEL = "grok-4.7";
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: claude-opus-4-6"),
      currentAgent: agent("opencode"),
    });
    expect(result.modelOverride).toBe("claude-opus-4-6");

    setAgentRuntimeOverrides({
      model: result.modelOverride,
      harness: result.agent.harness.name,
    });
    expect(resolveAgentModel("opencode")).toBe("claude-opus-4-6");
    expect(resolveAgentModel("grok")).toBe("grok-4.7");
  });

  test("passes an unmapped family through when the environment selected the harness", () => {
    // The built-in catalog does not model every harness. Without an explicit
    // `Harness:` the value may still be a native alias, so it is not a task
    // error; the CLI gets the final say.
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: astra"),
      currentAgent: agent("goose"),
    });
    expect(result.modelOverride).toBe("astra");
    expect(result.displayModel).toBe("astra");
    expect(result.modelAlias).toBeUndefined();
    expect(result.notes.join("\n")).toContain('"astra" is not a known family for harness "goose"');
  });

  test("fails when the task names a harness incompatible with the family", () => {
    process.env.GOOSE_CLI_PATH = "/bin/true";
    expect(() =>
      resolveExecutionPreferences({
        description: withPreferences("Harness: goose\nModel: astra"),
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/not available for harness "goose"/);
  });
});

describe("resolveExecutionPreferences — effort", () => {
  test("applies effort when the harness supports it", () => {
    const result = resolveExecutionPreferences({
      description: withPreferences("Effort: high"),
      currentAgent: agent("claude-code"),
    });
    expect(result.effort).toBe("high");
    expect(result.effortIgnored).toBe(false);
    expect(result.notes.join("\n")).toContain("Effort: high");
  });

  test("ignores effort when the harness does not support it", () => {
    const result = resolveExecutionPreferences({
      description: withPreferences("Effort: high"),
      currentAgent: agent("cursor"),
    });
    expect(result.effort).toBeUndefined();
    expect(result.effortIgnored).toBe(true);
    expect(result.notes.join("\n")).toContain("does not support reasoning effort");
  });

  test("ignores an invalid effort on a harness that does not support it", () => {
    const result = resolveExecutionPreferences({
      description: withPreferences("Effort: turbo"),
      currentAgent: agent("cursor"),
    });
    expect(result.effort).toBeUndefined();
    expect(result.effortIgnored).toBe(true);
    expect(result.notes.join("\n")).toContain('Effort "turbo" ignored');
  });

  test("fails on an invalid effort value", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: withPreferences("Effort: turbo"),
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/Invalid effort "turbo"/);
  });
});

describe("resolveExecutionPreferences — conflicts", () => {
  test("fails with actionable feedback on conflicting values", () => {
    expect(() =>
      resolveExecutionPreferences({
        description: withPreferences("Harness: opencode\nHarness: codex"),
        currentAgent: agent("claude-code"),
      }),
    ).toThrow(/Conflicting execution preferences/);
  });
});

describe("resolveExecutionPreferences — failover child", () => {
  test("ignores a harness that differs from the worker's pinned active entry", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const pinned = agent("grok");
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: codex"),
      currentAgent: pinned,
    });
    expect(result.agent).toBe(pinned);
    expect(result.modelOverride).toBeUndefined();
    expect(result.notes.join("\n")).toContain('Harness "codex" ignored');
    expect(result.notes.join("\n")).toContain('pinned to "grok"');
  });

  test("honours a harness that matches the pinned active entry", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: grok"),
      currentAgent: agent("grok"),
    });
    expect(result.agent.harness.name).toBe("grok");
    expect(result.notes.join("\n")).not.toContain("ignored");
  });

  test("ignores a model that was written for the ignored harness", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const pinned = agent("grok");
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: codex\nModel: gpt"),
      currentAgent: pinned,
    });
    expect(result.agent).toBe(pinned);
    expect(result.modelOverride).toBeUndefined();
    expect(result.displayModel).not.toBe("gpt-5.2");
    expect(result.notes.join("\n")).toContain('Model "gpt" ignored');
    expect(result.notes.join("\n")).toContain('belongs to the ignored harness "codex"');
  });

  test("does not resolve an alias for the ignored harness onto the pinned harness", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const pinned = agent("claude-code");
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: codex\nModel: astra"),
      currentAgent: pinned,
    });
    expect(result.agent).toBe(pinned);
    expect(result.modelOverride).toBeUndefined();
    expect(result.displayModel).not.toBe("claude-opus-4-6");
    expect(result.notes.join("\n")).toContain('Model "astra" ignored');
  });

  test("still resolves a model when the requested harness matches the pinned entry", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: grok\nModel: astra"),
      currentAgent: agent("grok"),
    });
    expect(result.modelOverride).toBe("grok-4");
    expect(result.modelAlias).toBe("astra");
  });

  test("ignores a model-only exact id on a fallback attempt", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    process.env.GROK_MODEL = "grok-4.7";
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: claude-opus-4-6"),
      currentAgent: agent("grok"),
    });
    expect(result.agent.harness.name).toBe("grok");
    expect(result.modelOverride).toBeUndefined();
    expect(result.displayModel).toBe("grok-4.7");
    expect(result.notes.join("\n")).toContain('Model "claude-opus-4-6" ignored');
    expect(result.notes.join("\n")).toContain('pinned to fallback harness "grok"');
  });

  test("ignores a model-only alias that only the primary chain entry supports", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "codex,opencode";
    process.env.OPENCODE_MODEL = "opencode/fallback-default";
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: gpt"),
      currentAgent: agent("opencode"),
    });
    expect(result.agent.harness.name).toBe("opencode");
    expect(result.modelOverride).toBeUndefined();
    expect(result.displayModel).toBe("opencode/fallback-default");
    expect(result.notes.join("\n")).toContain('Model "gpt" ignored');
    expect(result.notes.join("\n")).toContain('pinned to fallback harness "opencode"');
  });

  test("applies a model-only exact id on the primary attempt", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const result = resolveExecutionPreferences({
      description: withPreferences("Model: claude-opus-4-6"),
      currentAgent: agent("claude-code"),
    });
    expect(result.modelOverride).toBe("claude-opus-4-6");
    expect(result.notes.join("\n")).not.toContain("ignored");
  });

  test("applies an exact id when the task explicitly names the pinned fallback harness", () => {
    process.env.DEVINTERN_WORKER_CHILD = "1";
    process.env.DEVINTERN_HARNESS_CHAIN = "claude-code,grok";
    const result = resolveExecutionPreferences({
      description: withPreferences("Harness: grok\nModel: grok-4.7"),
      currentAgent: agent("grok"),
    });
    expect(result.modelOverride).toBe("grok-4.7");
    expect(result.notes.join("\n")).not.toContain("ignored");
  });
});

describe("applyExecutionSelection", () => {
  test("restores the previous agent and overrides after the task scope", () => {
    const previousAgent = agent("claude-code");
    const previousOverrides = { effort: "low" as const };
    const originalAgent = runContext.resolvedAgent;
    runContext.resolvedAgent = previousAgent;
    setAgentRuntimeOverrides(previousOverrides);
    try {
      const execution = {
        agent: agent("opencode"),
        modelOverride: "opencode-special",
        effortIgnored: false,
        notes: [],
      } satisfies EffectiveExecutionPreferences;

      const restore = applyExecutionSelection(execution);
      expect(runContext.resolvedAgent).toBe(execution.agent);
      expect(getAgentRuntimeOverrides()).toEqual({
        model: "opencode-special",
        harness: "opencode",
      });

      restore();
      expect(runContext.resolvedAgent).toBe(previousAgent);
      expect(getAgentRuntimeOverrides()).toEqual(previousOverrides);
    } finally {
      runContext.resolvedAgent = originalAgent;
    }
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
