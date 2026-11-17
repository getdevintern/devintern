import { describe, expect, test } from "bun:test";
import type { SupabaseAuthConfig } from "@devintern/auth";
import {
  agentChainCheck,
  defaultAgentChainProbe,
  collectReadinessChecks,
  renderReadinessReport,
} from "../src/lib/observability/readiness";
import type {
  AgentChainEntryReport,
  AgentChainProbeResult,
} from "../src/lib/observability/readiness";

const authConfig = {
  url: "https://example.supabase.co",
  publishableKey: "test-key",
  sessionFilePath: "/tmp/readiness-test/.auth-session.json",
} satisfies SupabaseAuthConfig;

function entry(
  name: string,
  overrides: Partial<AgentChainEntryReport> = {},
): AgentChainEntryReport {
  return {
    name,
    path: `/usr/local/bin/${name}`,
    sandbox: "none (sandboxing off)",
    model: "default",
    status: "ready",
    retained: true,
    ...overrides,
  };
}

function chainProbe(
  entries: AgentChainEntryReport[],
  overrides: Partial<AgentChainProbeResult> = {},
): AgentChainProbeResult {
  return { sandbox: "none", entries, unknown: [], alternatives: [], ...overrides };
}

function baseDeps() {
  return {
    bunVersion: () => "1.3.2",
    gitVersion: () => "git version 2.45.0",
    probeAgentChain: () => chainProbe([entry("claude-code")]),
    env: {
      TASK_TRACKER: "jira",
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "dev@acme.com",
      JIRA_API_TOKEN: "secret",
    },
    envPath: "/proj/.devintern-code/.env",
  };
}

describe("collectReadinessChecks", () => {
  test("all-ok project reports no failures or warnings", async () => {
    const checks = await collectReadinessChecks({
      ...baseDeps(),
      getUser: () => Promise.resolve({ id: "u1", email: "dev@acme.com" }),
      getLicense: () => Promise.resolve({ valid: true, source: "entitlement", message: "" }),
    });

    expect(checks.map((c) => c.status)).toEqual(Array.from({ length: checks.length }, () => "ok"));
    const tracker = checks.find((c) => c.id === "tracker");
    expect(tracker?.detail).toContain("JIRA");
    expect(tracker?.detail).toContain("/proj/.devintern-code/.env");
  });

  test("missing tracker credentials fail with an init hint", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      env: { TASK_TRACKER: "jira" },
    });

    const tracker = checks.find((c) => c.id === "tracker");
    expect(tracker?.status).toBe("fail");
    expect(tracker?.detail).toContain("JIRA_EMAIL");
    expect(tracker?.hint).toContain("devintern init");
  });

  test("unknown tracker id fails with supported values", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      env: { TASK_TRACKER: "not-a-tracker" },
    });

    const tracker = checks.find((c) => c.id === "tracker");
    expect(tracker?.status).toBe("fail");
    expect(tracker?.detail).toContain("not-a-tracker");
  });

  test("uninstalled chain with an installed alternative fails with a switch hint", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      probeAgentChain: () =>
        chainProbe(
          [entry("claude-code", { status: "not-ready", retained: false, reason: "CLI not found" })],
          { alternatives: [{ name: "opencode", displayName: "OpenCode" }] },
        ),
    });

    const agent = checks.find((c) => c.id === "agent");
    expect(agent?.status).toBe("fail");
    expect(agent?.hint).toContain("AGENT_HARNESS=opencode");
  });

  test("no agent CLI anywhere fails with an install hint", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      probeAgentChain: () =>
        chainProbe([entry("claude-code", { status: "not-ready", retained: false })]),
    });

    const agent = checks.find((c) => c.id === "agent");
    expect(agent?.status).toBe("fail");
    expect(agent?.hint).toContain("_CLI_PATH");
  });

  test("missing git and bun fail", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      bunVersion: () => null,
      gitVersion: () => null,
    });

    expect(checks.find((c) => c.id === "runtime")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "git")?.status).toBe("fail");
  });

  test("auth and license checks are skipped without a Supabase config", async () => {
    const checks = await collectReadinessChecks(baseDeps());
    expect(checks.some((c) => c.id === "auth")).toBe(false);
    expect(checks.some((c) => c.id === "license")).toBe(false);
  });

  test("signed-in user gets license reporting; anonymous gets a login hint", async () => {
    const signedOut = await collectReadinessChecks({
      ...baseDeps(),
      supabaseConfig: authConfig,
      getUser: () => Promise.resolve(null),
    });
    const auth = signedOut.find((c) => c.id === "auth");
    expect(auth?.status).toBe("warn");
    expect(auth?.hint).toContain("devintern login");
    expect(signedOut.some((c) => c.id === "license")).toBe(false);

    const licensed = await collectReadinessChecks({
      ...baseDeps(),
      supabaseConfig: authConfig,
      getUser: () => Promise.resolve({ id: "u1", email: null }),
      getLicense: () =>
        Promise.resolve({ valid: false, source: "none", message: "no entitlement" }),
    });
    expect(licensed.find((c) => c.id === "auth")?.status).toBe("ok");
    // License is informational for interactive use, so absence stays a warning
    expect(licensed.find((c) => c.id === "license")?.status).toBe("warn");
  });
});

describe("renderReadinessReport", () => {
  test("renders icons, hints, and aggregate flags", () => {
    const report = renderReadinessReport([
      { id: "git", label: "Git", status: "ok", detail: "2.45.0" },
      {
        id: "agent",
        label: "AI agent CLI",
        status: "warn",
        detail: "not installed",
        hint: "Install Claude Code",
      },
      {
        id: "tracker",
        label: "Task tracker",
        status: "fail",
        detail: "missing JIRA_API_TOKEN",
        hint: "Run 'devintern init'",
      },
    ]);

    expect(report.hasFailures).toBe(true);
    expect(report.hasWarnings).toBe(true);
    expect(report.lines).toEqual([
      "✅ Git — 2.45.0",
      "⚠️  AI agent CLI — not installed",
      "     💡 Install Claude Code",
      "❌ Task tracker — missing JIRA_API_TOKEN",
      "     💡 Run 'devintern init'",
    ]);
  });

  test("clean report has neither failures nor warnings", () => {
    const report = renderReadinessReport([{ id: "git", label: "Git", status: "ok" }]);
    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(report.lines).toEqual(["✅ Git"]);
  });
});

describe("agentChainCheck", () => {
  test("reports every entry with path, sandbox, model, status, and reason", () => {
    const check = agentChainCheck(
      chainProbe(
        [
          entry("opencode", { sandbox: "nono", model: "opencode-go/x (OPENCODE_MODEL)" }),
          entry("codex", {
            path: "/home/u/.local/share/mise/shims/codex",
            sandbox: "native",
            status: "warning",
            reason: "resolves to a mise shim (/home/u/.local/share/mise/shims/codex)",
            hint: "CODEX_CLI_PATH=/path/to/codex (the real executable, not the mise shim)",
          }),
          entry("grok", {
            sandbox: "nono",
            notes: ['nono has no pack profile for "grok"; using linux-host-compat'],
          }),
        ],
        { sandbox: "auto" },
      ),
    );
    const text = (check.items ?? []).join("\n");
    expect(check.status).toBe("warn");
    expect(text).toContain(
      "opencode — /usr/local/bin/opencode · sandbox: nono · model: opencode-go/x (OPENCODE_MODEL) · ready",
    );
    expect(text).toContain(
      "codex — /home/u/.local/share/mise/shims/codex · sandbox: native · model: default · warning: resolves to a mise shim",
    );
    expect(text).toContain("CODEX_CLI_PATH=/path/to/codex");
    expect(text).toContain('no pack profile for "grok"');
    // Model isolation: OPENCODE_MODEL is only shown on the opencode row.
    expect(text.split("\n").filter((line) => line.includes("OPENCODE_MODEL"))).toHaveLength(1);
  });

  test("only later entries ready is degraded (warn), not failed and not ok", () => {
    const check = agentChainCheck(
      chainProbe([
        entry("opencode", { status: "not-ready", retained: false, reason: "cannot start" }),
        entry("grok"),
      ]),
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 of 2");
    expect((check.items ?? []).join("\n")).toContain("excluded: cannot start");
  });

  test("unknown entries degrade the chain and are listed", () => {
    const check = agentChainCheck(chainProbe([entry("codex")], { unknown: ["nope"] }));
    expect(check.status).toBe("warn");
    expect((check.items ?? []).join("\n")).toContain("nope — unknown harness; excluded");
  });

  test("a fully ready chain is ok", () => {
    const check = agentChainCheck(chainProbe([entry("opencode"), entry("codex")]));
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("opencode → codex ready");
  });

  test("a resolution error fails", () => {
    const check = agentChainCheck(chainProbe([], { error: "Unknown agent harness" }));
    expect(check.status).toBe("fail");
  });

  test("rendered report lists the entry lines under the agent check", () => {
    const check = agentChainCheck(chainProbe([entry("opencode"), entry("codex")]));
    const { lines } = renderReadinessReport([check]);
    expect(lines.some((line) => line.includes("1. ✅ opencode"))).toBe(true);
    expect(lines.some((line) => line.includes("2. ✅ codex"))).toBe(true);
  });
});

describe("defaultAgentChainProbe", () => {
  const keys = [
    "OPENCODE_MODEL",
    "CODEX_MODEL",
    "AGENT_MODEL",
    "OPENCODE_CLI_PATH",
    "CODEX_CLI_PATH",
    "AGENT_CLI_PATH",
    "DEVINTERN_HARNESS_CHAIN",
  ];

  test("keeps OPENCODE_MODEL scoped to opencode and reports every entry", async () => {
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      process.env.OPENCODE_MODEL = "opencode-go/deepseek";
      process.env.OPENCODE_CLI_PATH = process.execPath;
      process.env.CODEX_CLI_PATH = process.execPath;
      const probe = await defaultAgentChainProbe({
        AGENT_HARNESS: "opencode,codex",
        AGENT_SANDBOX: "none",
      });
      expect(probe.entries.map((e) => [e.name, e.model, e.status])).toEqual([
        ["opencode", "opencode-go/deepseek (OPENCODE_MODEL)", "ready"],
        ["codex", "default", "ready"],
      ]);
      expect(probe.entries[1]?.path).toBe(process.execPath);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("doctorExitCode", () => {
  test("documented contract: 0 ready, 1 not ready, 2 degraded only with --strict", async () => {
    const { doctorExitCode } = await import("../src/lib/observability/cli");
    expect(doctorExitCode({ hasFailures: false, hasWarnings: false })).toBe(0);
    expect(doctorExitCode({ hasFailures: false, hasWarnings: true })).toBe(0);
    expect(doctorExitCode({ hasFailures: false, hasWarnings: true }, true)).toBe(2);
    expect(doctorExitCode({ hasFailures: true, hasWarnings: true }, true)).toBe(1);
    expect(doctorExitCode({ hasFailures: true, hasWarnings: false })).toBe(1);
  });
});
