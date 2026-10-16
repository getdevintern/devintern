import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveHarness } from "@devintern/agent-harness";
import {
  applyAgentSelectionEnv,
  parseAgentSelection,
  pickAgentSelection,
  warnUninstalledHarnessPins,
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
      { harness: "codex", model: "gpt-5-codex", effort: "medium" },
    );
    expect(env).toEqual({
      AGENT_HARNESS: "codex",
      AGENT_MODEL: "gpt-5-codex",
      AGENT_EFFORT: "medium",
      KEEP: "1",
    });
  });

  test("drops an inherited model/effort when the pin changes the harness", () => {
    // The inherited model/effort were chosen for the env's primary harness, so
    // sending them to a different pinned harness is the cross-harness leak this
    // module deliberately prevents.
    const env = applyAgentSelectionEnv(
      {
        AGENT_HARNESS: "claude-code",
        AGENT_MODEL: "claude-sonnet",
        AGENT_EFFORT: "low",
        KEEP: "1",
      },
      { harness: "codex" },
    );
    expect(env).toEqual({ AGENT_HARNESS: "codex", KEEP: "1" });
  });

  test("keeps an inherited model/effort when the pin keeps the primary harness", () => {
    const env = applyAgentSelectionEnv(
      { AGENT_HARNESS: "claude-code", AGENT_MODEL: "claude-sonnet", AGENT_EFFORT: "low" },
      { harness: "claude-code" },
    );
    expect(env).toEqual({
      AGENT_HARNESS: "claude-code",
      AGENT_MODEL: "claude-sonnet",
      AGENT_EFFORT: "low",
    });
  });

  test("is a no-op for an empty selection", () => {
    const env = { AGENT_MODEL: "workspace-model" };
    applyAgentSelectionEnv(env, {});
    expect(env).toEqual({ AGENT_MODEL: "workspace-model" });
  });

  test("ignores model and effort when the entry does not pin a harness", () => {
    // A model-only entry keeps the workspace failover chain, so writing a
    // harness-specific model would leak it onto whichever fallback runs.
    const env = applyAgentSelectionEnv(
      { AGENT_HARNESS: "codex,grok", AGENT_MODEL: "workspace-model", KEEP: "1" },
      { model: "gpt-5-codex", effort: "high" },
    );
    expect(env).toEqual({
      AGENT_HARNESS: "codex,grok",
      AGENT_MODEL: "workspace-model",
      KEEP: "1",
    });
  });

  test("drops a stale AGENT_CLI_PATH when pinning a non-primary harness", () => {
    const env = applyAgentSelectionEnv(
      { AGENT_HARNESS: "claude-code", AGENT_CLI_PATH: "/opt/custom/claude" },
      { harness: "codex" },
    );
    expect(env.AGENT_HARNESS).toBe("codex");
    expect(env.AGENT_CLI_PATH).toBeUndefined();
  });

  test("keeps AGENT_CLI_PATH when the pin is the env's primary harness", () => {
    const env = applyAgentSelectionEnv(
      { AGENT_HARNESS: "claude-code", AGENT_CLI_PATH: "/opt/custom/claude" },
      { harness: "claude-code" },
    );
    expect(env.AGENT_HARNESS).toBe("claude-code");
    expect(env.AGENT_CLI_PATH).toBe("/opt/custom/claude");
  });

  test("a non-claude pin does not resolve to the inherited CLAUDE_CLI_PATH", () => {
    // `CLAUDE_CLI_PATH` is the resolver's backward-compat fallback for ANY
    // harness, so a pin to codex must drop it or the child spawns the claude
    // binary for the pinned harness.
    const composed = applyAgentSelectionEnv(
      {
        AGENT_HARNESS: "claude-code",
        AGENT_CLI_PATH: "/opt/custom/claude",
        CLAUDE_CLI_PATH: "/opt/custom/claude",
      },
      { harness: "codex" },
    );
    expect(composed.CLAUDE_CLI_PATH).toBeUndefined();
    expect(composed.AGENT_CLI_PATH).toBeUndefined();

    const previous = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("AGENT_") || key === "CLAUDE_CLI_PATH") delete process.env[key];
      }
      Object.assign(process.env, composed);
      const resolved = resolveHarness();
      expect(resolved.harness.name).toBe("codex");
      expect(resolved.path).not.toBe("/opt/custom/claude");
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  test("pinning claude-code keeps the inherited CLAUDE_CLI_PATH", () => {
    const env = applyAgentSelectionEnv(
      { AGENT_HARNESS: "claude-code", CLAUDE_CLI_PATH: "/opt/custom/claude" },
      { harness: "claude-code" },
    );
    expect(env.CLAUDE_CLI_PATH).toBe("/opt/custom/claude");
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

  test("automationRunEnv drops the inherited model when the pin changes the harness", () => {
    const automation: AutomationConfig = {
      id: "daily",
      enabled: true,
      prompt: "p",
      interval: "1h",
      intervalMs: 3_600_000,
      harness: "codex",
    };
    const env = automationRunEnv(automation, {
      AGENT_HARNESS: "claude-code",
      AGENT_MODEL: "claude-sonnet",
    });
    expect(env.AGENT_HARNESS).toBe("codex");
    expect(env.AGENT_MODEL).toBeUndefined();
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
      // The workspace model was chosen for the claude-code primary, so it must
      // not leak onto the codex pin the entry selected.
      expect(env.AGENT_MODEL).toBeUndefined();
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

describe("warnUninstalledHarnessPins", () => {
  const KEYS = ["AGENT_HARNESS", "AGENT_CLI_PATH", "CODEX_CLI_PATH", "CLAUDE_CLI_PATH"] as const;

  /** Run `fn` with only the listed AGENT_* keys set, restoring on exit. */
  function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
    const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const key of KEYS) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("warns when a pinned non-primary harness CLI is missing", () => {
    withEnv({ AGENT_HARNESS: "claude-code", CODEX_CLI_PATH: "/nonexistent/codex" }, () => {
      const warnings: string[] = [];
      warnUninstalledHarnessPins([{ id: "dep", harness: "codex" }], (m) => warnings.push(m));
      expect(warnings.some((w) => w.includes('"codex"') && w.includes('"dep"'))).toBe(true);
      expect(warnings.some((w) => w.includes("CODEX_CLI_PATH"))).toBe(true);
    });
  });

  test("stays silent when the pinned harness resolves to an executable", () => {
    withEnv({ AGENT_HARNESS: "claude-code", CODEX_CLI_PATH: process.execPath }, () => {
      const warnings: string[] = [];
      warnUninstalledHarnessPins([{ id: "dep", harness: "codex" }], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
    });
  });

  test("honours AGENT_CLI_PATH only when the pin is the env primary", () => {
    withEnv(
      {
        AGENT_HARNESS: "claude-code",
        AGENT_CLI_PATH: process.execPath,
        CLAUDE_CLI_PATH: "/nonexistent/claude",
      },
      () => {
        const warnings: string[] = [];
        warnUninstalledHarnessPins([{ id: "dep", harness: "claude-code" }], (m) =>
          warnings.push(m),
        );
        expect(warnings).toEqual([]);
      },
    );

    withEnv(
      {
        AGENT_HARNESS: "codex",
        AGENT_CLI_PATH: process.execPath,
        CLAUDE_CLI_PATH: "/nonexistent/claude",
      },
      () => {
        const warnings: string[] = [];
        warnUninstalledHarnessPins([{ id: "dep", harness: "claude-code" }], (m) =>
          warnings.push(m),
        );
        expect(warnings.some((w) => w.includes('"claude-code"'))).toBe(true);
      },
    );
  });

  test("ignores entries without a pinned harness", () => {
    withEnv({ AGENT_HARNESS: "claude-code" }, () => {
      const warnings: string[] = [];
      warnUninstalledHarnessPins([{ id: "dep" }], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
    });
  });
});
