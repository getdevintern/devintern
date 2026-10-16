import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  applyAgentSelectionEnv,
  parseAgentSelection,
  pickAgentSelection,
} from "../src/lib/agent/selection";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { buildRepoEnv, buildWorkspaceContextEnv } from "../src/lib/workspace/env";
import { automationRunEnv } from "../src/lib/automation/acquirer";
import { estimationRunEnv } from "../src/lib/automation/estimation-acquirer";
import type { AutomationConfig } from "../src/lib/automation/config";
import type { EstimationConfig } from "../src/lib/automation/estimation-config";

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newWorkspaceDir(env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "devintern-agent-selection-"));
  temporaryDirs.push(dir);
  if (env) writeFileSync(join(dir, ".env"), env);
  return dir;
}

const BASE_CONFIG = `
[defaults]
tracker = "jira"
`;

describe("parseAgentSelection", () => {
  test("accepts harness, model, and effort and canonicalizes aliases", () => {
    const errors: string[] = [];
    const selection = parseAgentSelection(
      { harness: "agy", model: "gemini-2.5-pro", effort: "high" },
      { label: "[[automations]][0]", id: "daily" },
      errors,
    );
    expect(errors).toEqual([]);
    expect(selection).toEqual({
      harness: "antigravity",
      model: "gemini-2.5-pro",
      effort: "high",
    });
  });

  test("omits unset fields entirely", () => {
    const errors: string[] = [];
    expect(parseAgentSelection({}, { label: "[x]" }, errors)).toEqual({});
    expect(errors).toEqual([]);
  });

  test("rejects an unknown harness with the field and entry id", () => {
    const errors: string[] = [];
    parseAgentSelection(
      { harness: "not-real" },
      { label: "[[automations]][0]", id: "daily" },
      errors,
    );
    expect(errors.join("\n")).toContain('[[automations]][0].harness "not-real"');
    expect(errors.join("\n")).toContain('entry "daily"');
  });

  test("rejects a harness chain — an entry names one agent", () => {
    const errors: string[] = [];
    parseAgentSelection(
      { harness: "codex,grok" },
      { label: "[[estimations]][1]", id: "groom" },
      errors,
    );
    expect(errors.join("\n")).toContain("must name a single agent harness");
    expect(errors.join("\n")).toContain('entry "groom"');
  });

  test("rejects an invalid effort with the field and entry id", () => {
    const errors: string[] = [];
    parseAgentSelection(
      { effort: "ultra" },
      { label: "[[automations]][2]", id: "release" },
      errors,
    );
    expect(errors.join("\n")).toContain('[[automations]][2].effort "ultra"');
    expect(errors.join("\n")).toContain('entry "release"');
  });

  test("accepts effort on a harness that ignores it (validated at spawn, not parse)", () => {
    const errors: string[] = [];
    const selection = parseAgentSelection(
      { harness: "cursor", effort: "low" },
      { label: "[x]" },
      errors,
    );
    expect(errors).toEqual([]);
    expect(selection).toEqual({ harness: "cursor", effort: "low" });
  });
});

describe("applyAgentSelectionEnv", () => {
  test("overlays only the selected fields over the layered env", () => {
    const env = applyAgentSelectionEnv(
      { AGENT_HARNESS: "claude-code", AGENT_MODEL: "workspace-model", KEEP: "1" },
      { harness: "codex", effort: "medium" },
    );
    expect(env).toEqual({
      AGENT_HARNESS: "codex",
      AGENT_MODEL: "workspace-model",
      AGENT_EFFORT: "medium",
      KEEP: "1",
    });
  });

  test("is a no-op for an empty selection", () => {
    const env = { AGENT_MODEL: "workspace-model" };
    applyAgentSelectionEnv(env, {});
    expect(env).toEqual({ AGENT_MODEL: "workspace-model" });
  });
});

describe("pickAgentSelection", () => {
  test("copies only set fields", () => {
    expect(pickAgentSelection({ model: "m" })).toEqual({ model: "m" });
    expect(pickAgentSelection({})).toEqual({});
  });
});

describe("workspace config entry selection", () => {
  test("parses automation harness/model/effort", () => {
    const config = parseWorkspaceConfig(`${BASE_CONFIG}
[[automations]]
id = "daily"
enabled = true
interval = "15m"
prompt = "triage"
harness = "codex"
model = "gpt-5-codex"
effort = "low"
`);
    expect(config.automations[0]).toMatchObject({
      id: "daily",
      harness: "codex",
      model: "gpt-5-codex",
      effort: "low",
    });
  });

  test("parses estimation harness/model/effort (no repo required)", () => {
    const config = parseWorkspaceConfig(`${BASE_CONFIG}
[[estimations]]
id = "groom"
enabled = true
cron = "0 9 * * 1-5"
query = "status = 'To Do'"
harness = "claude-code"
effort = "high"
`);
    expect(config.estimations[0]).toMatchObject({
      id: "groom",
      harness: "claude-code",
      effort: "high",
    });
    expect(config.estimations[0]?.model).toBeUndefined();
  });

  test("entries with no selection fields load unchanged", () => {
    const config = parseWorkspaceConfig(`${BASE_CONFIG}
[[automations]]
id = "daily"
enabled = true
interval = "1h"
prompt = "work"

[[estimations]]
id = "groom"
enabled = true
interval = "6h"
query = "q"
`);
    expect(config.automations[0]?.harness).toBeUndefined();
    expect(config.automations[0]?.model).toBeUndefined();
    expect(config.automations[0]?.effort).toBeUndefined();
    expect(config.estimations[0]?.harness).toBeUndefined();
  });

  test("unknown automation harness fails validation naming id and field", () => {
    expect(() =>
      parseWorkspaceConfig(`${BASE_CONFIG}
[[automations]]
id = "release"
enabled = true
interval = "1h"
prompt = "work"
harness = "bogus"
`),
    ).toThrow(/release[\s\S]*harness|harness[\s\S]*release/);
  });

  test("invalid estimation effort fails validation naming id and field", () => {
    expect(() =>
      parseWorkspaceConfig(`${BASE_CONFIG}
[[estimations]]
id = "groom"
enabled = true
interval = "1h"
query = "q"
effort = "extreme"
`),
    ).toThrow(/groom[\s\S]*effort|effort[\s\S]*groom/);
  });
});

describe("entry selection precedence in run env", () => {
  test("automationRunEnv overrides workspace env values", () => {
    const automation: AutomationConfig = {
      id: "daily",
      enabled: true,
      prompt: "p",
      interval: "1h",
      intervalMs: 3_600_000,
      harness: "codex",
      model: "gpt-5-codex",
      effort: "high",
    };
    const env = automationRunEnv(automation, {
      AGENT_HARNESS: "claude-code",
      AGENT_MODEL: "workspace-model",
      AGENT_EFFORT: "low",
    });
    expect(env.AGENT_HARNESS).toBe("codex");
    expect(env.AGENT_MODEL).toBe("gpt-5-codex");
    expect(env.AGENT_EFFORT).toBe("high");
  });

  test("automationRunEnv keeps inherited model when the entry omits it", () => {
    const automation: AutomationConfig = {
      id: "daily",
      enabled: true,
      prompt: "p",
      interval: "1h",
      intervalMs: 3_600_000,
      harness: "codex",
    };
    const env = automationRunEnv(automation, { AGENT_MODEL: "workspace-model" });
    expect(env.AGENT_HARNESS).toBe("codex");
    expect(env.AGENT_MODEL).toBe("workspace-model");
  });

  test("estimationRunEnv overrides workspace env values", () => {
    const estimation: EstimationConfig = {
      id: "groom",
      enabled: true,
      query: "q",
      interval: "6h",
      intervalMs: 21_600_000,
      harness: "claude-code",
      effort: "medium",
    };
    const env = estimationRunEnv(estimation, { AGENT_HARNESS: "codex" });
    expect(env.AGENT_HARNESS).toBe("claude-code");
    expect(env.AGENT_EFFORT).toBe("medium");
  });
});

describe("env builder selection precedence", () => {
  test("workspace-context selection overrides the workspace process env", () => {
    const workspaceDir = newWorkspaceDir();
    const previousHarness = process.env.AGENT_HARNESS;
    const previousModel = process.env.AGENT_MODEL;
    process.env.AGENT_HARNESS = "claude-code";
    process.env.AGENT_MODEL = "workspace-model";
    try {
      const env = buildWorkspaceContextEnv(workspaceDir, {
        agentSelection: { harness: "codex", effort: "high" },
      });
      expect(env.AGENT_HARNESS).toBe("codex");
      expect(env.AGENT_MODEL).toBe("workspace-model");
      expect(env.AGENT_EFFORT).toBe("high");
    } finally {
      if (previousHarness === undefined) delete process.env.AGENT_HARNESS;
      else process.env.AGENT_HARNESS = previousHarness;
      if (previousModel === undefined) delete process.env.AGENT_MODEL;
      else process.env.AGENT_MODEL = previousModel;
    }
  });

  test("repo selection overrides workspace .env and inline repo env", () => {
    const workspaceDir = newWorkspaceDir(
      "AGENT_HARNESS=claude-code\nAGENT_MODEL=workspace-model\n",
    );
    const env = buildRepoEnv(
      {
        name: "api",
        remote: "https://github.com/acme/api.git",
        env: { AGENT_HARNESS: "grok", AGENT_MODEL: "repo-model" },
      },
      workspaceDir,
      { agentSelection: { harness: "codex", model: "entry-model" } },
    );
    expect(env.AGENT_HARNESS).toBe("codex");
    expect(env.AGENT_MODEL).toBe("entry-model");
  });
});
