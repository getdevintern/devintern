import { describe, expect, test } from "bun:test";
import type { SupabaseAuthConfig } from "@devintern/auth";
import { activeSandboxName, resolveHarness } from "@devintern/agent-harness";
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
    probeCatalog: () => ({ packCount: 4, errors: [], warnings: [] }),
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

  test("a clean catalog reports ok", async () => {
    const checks = await collectReadinessChecks(baseDeps());
    const catalog = checks.find((c) => c.id === "catalog");
    expect(catalog?.status).toBe("ok");
    expect(catalog?.detail).toBe("4 pack(s)");
  });

  test("broken catalog entries fail with a hint", async () => {
    const checks = await collectReadinessChecks({
      ...baseDeps(),
      probeCatalog: () => ({
        packCount: 3,
        errors: ['Pack "alpha": prompt file "prompt.md" does not exist.'],
        warnings: [],
      }),
    });
    const catalog = checks.find((c) => c.id === "catalog");
    expect(catalog?.status).toBe("fail");
    expect(catalog?.detail).toContain("broken");
    expect(catalog?.hint).toContain("automations list");
  });

  test("orphaned catalog directories warn", async () => {
    const checks = await collectReadinessChecks({
      ...baseDeps(),
      probeCatalog: () => ({
        packCount: 4,
        errors: [],
        warnings: ['Pack directory "stale" is not listed (orphaned).'],
      }),
    });
    const catalog = checks.find((c) => c.id === "catalog");
    expect(catalog?.status).toBe("warn");
    expect(catalog?.detail).toContain("orphaned");
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
    expect(auth?.hint).toMatch(/`devintern worker login( --workspace \S+)? github`/);
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

  test("a non-ready primary fails even when a fallback is usable (matches devintern sandbox)", () => {
    const check = agentChainCheck(
      chainProbe([
        entry("opencode", { status: "not-ready", retained: false, reason: "cannot start" }),
        entry("grok"),
      ]),
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("primary opencode cannot start");
    expect(check.detail).toContain("interactive and PR-review runs use the primary and fail");
    expect((check.items ?? []).join("\n")).toContain("excluded: cannot start");
  });

  test("only a non-ready fallback is degraded (warn), not failed and not ok", () => {
    const check = agentChainCheck(
      chainProbe([
        entry("opencode"),
        entry("grok", { status: "not-ready", retained: false, reason: "cannot start" }),
      ]),
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 of 2");
  });

  test("unknown entries degrade the chain and are listed", () => {
    const check = agentChainCheck(chainProbe([entry("codex")], { unknown: ["nope"] }));
    expect(check.status).toBe("warn");
    expect((check.items ?? []).join("\n")).toContain("nope — unknown harness; excluded");
  });

  test("an unknown primary fails in AGENT_HARNESS order even when a fallback is ready", () => {
    const check = agentChainCheck(
      chainProbe([entry("codex")], { unknown: ["foo"], requested: ["foo", "codex"] }),
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("primary foo is not a registered harness");
    expect(check.items?.[0]).toBe("1. ❌ foo — unknown harness; excluded");
    expect(check.items?.[1]).toStartWith("2. ✅ codex");
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

describe("defaultAgentChainProbe with an unknown primary", () => {
  test("foo,codex fails the agent check, matching resolveHarness()", async () => {
    const probe = await defaultAgentChainProbe({
      AGENT_HARNESS: "foo,codex",
      AGENT_SANDBOX: "none",
      CODEX_CLI_PATH: process.execPath,
    });
    expect(probe.requested).toEqual(["foo", "codex"]);
    const check = agentChainCheck(probe);
    expect(check.status).toBe("fail");
    expect(check.items?.[0]).toBe("1. ❌ foo — unknown harness; excluded");
    const previous = process.env.AGENT_HARNESS;
    try {
      process.env.AGENT_HARNESS = "foo,codex";
      expect(() => resolveHarness()).toThrow('Unknown agent harness: "foo"');
    } finally {
      if (previous === undefined) delete process.env.AGENT_HARNESS;
      else process.env.AGENT_HARNESS = previous;
    }
  });
});

describe("defaultAgentChainProbe with a provider-level AGENT_SANDBOX error", () => {
  for (const sandbox of ["srt", "bogus-provider"]) {
    test(`AGENT_SANDBOX=${sandbox} names the sandbox, not another harness`, async () => {
      const probe = await defaultAgentChainProbe({
        AGENT_HARNESS: "claude-code",
        AGENT_SANDBOX: sandbox,
      });
      expect(probe.entries.every((e) => e.status === "not-ready")).toBe(true);
      expect(probe.sandboxError).toBeDefined();
      expect(probe.alternatives).toEqual([]);
      const check = agentChainCheck(probe);
      expect(check.status).toBe("fail");
      expect(check.detail).toContain(`AGENT_SANDBOX=${sandbox}`);
      expect(check.detail).toContain(probe.sandboxError!);
      expect(check.hint).toContain("Fix AGENT_SANDBOX");
      expect(check.hint).not.toContain("set AGENT_HARNESS=");
    });
  }

  test("an installed alternative is not offered when the sandbox is the problem", () => {
    const check = agentChainCheck(
      chainProbe([entry("claude-code", { status: "not-ready", retained: false })], {
        sandbox: "srt",
        sandboxError: 'AGENT_SANDBOX="srt" has been removed',
        alternatives: [{ name: "codex", displayName: "Codex" }],
      }),
    );
    expect(check.status).toBe("fail");
    expect(check.hint).not.toContain("Codex");
    expect(check.hint).toContain("AGENT_SANDBOX=auto");
  });

  test("an incompatible-only error still offers alternatives", () => {
    const check = agentChainCheck(
      chainProbe([entry("claude-code", { status: "not-ready", retained: false })], {
        alternatives: [{ name: "codex", displayName: "Codex" }],
      }),
    );
    expect(check.hint).toContain("set AGENT_HARNESS=codex");
  });
});

describe("defaultAgentChainProbe env snapshot", () => {
  const keys = [
    "AGENT_HARNESS",
    "AGENT_SANDBOX",
    "AGENT_MODEL",
    "AGENT_CLI_PATH",
    "OPENCODE_MODEL",
    "OPENCODE_CLI_PATH",
    "DEVINTERN_HARNESS_CHAIN",
  ];

  test("reads CLI path and model overrides from the passed env only, then restores process.env", async () => {
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      const probe = await defaultAgentChainProbe({
        ...process.env,
        AGENT_HARNESS: "opencode",
        AGENT_SANDBOX: "none",
        OPENCODE_CLI_PATH: process.execPath,
        OPENCODE_MODEL: "x/y",
      });
      expect(probe.entries.map((e) => [e.name, e.path, e.model, e.status])).toEqual([
        ["opencode", process.execPath, "x/y (OPENCODE_MODEL)", "ready"],
      ]);
      for (const key of keys) expect(process.env[key]).toBeUndefined();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("defaultAgentChainProbe enclosing-sandbox detection", () => {
  test("a sandbox marker in the probed env (e.g. from a repo .env) does not fake an inherited sandbox", async () => {
    const base = {
      ...process.env,
      AGENT_HARNESS: "claude-code",
      AGENT_SANDBOX: "auto",
      CLAUDE_CLI_PATH: process.execPath,
    };
    const clean = await defaultAgentChainProbe(base);
    const injected = await defaultAgentChainProbe({
      ...base,
      NONO_CAP_FILE: "/etc/hostname",
      SANDBOX_RUNTIME: "1",
    });
    expect(injected.entries.map((e) => e.sandbox)).toEqual(clean.entries.map((e) => e.sandbox));
    const trustedActive = activeSandboxName();
    expect(injected.entries.some((e) => e.sandbox?.includes("(inherited)"))).toBe(
      trustedActive !== undefined,
    );
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
