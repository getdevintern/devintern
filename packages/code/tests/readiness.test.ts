import { describe, expect, test } from "bun:test";
import type { SupabaseAuthConfig } from "@devintern/auth";
import { collectReadinessChecks, renderReadinessReport } from "../src/lib/readiness";

const authConfig = {
  url: "https://example.supabase.co",
  publishableKey: "test-key",
  sessionFilePath: "/tmp/readiness-test/.auth-session.json",
} satisfies SupabaseAuthConfig;

function baseDeps() {
  return {
    bunVersion: () => "1.3.2",
    gitVersion: () => "git version 2.45.0",
    probeAgent: () => ({
      resolved: true,
      displayName: "Claude Code",
      command: "claude",
      installed: true,
      alternatives: [],
    }),
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

  test("uninstalled agent with installed alternative warns with a switch hint", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      probeAgent: () => ({
        resolved: true,
        displayName: "Claude Code",
        command: "claude",
        installed: false,
        alternatives: [{ name: "opencode", displayName: "OpenCode" }],
      }),
    });

    const agent = checks.find((c) => c.id === "agent");
    expect(agent?.status).toBe("warn");
    expect(agent?.hint).toContain("AGENT_HARNESS=opencode");
  });

  test("no agent CLI anywhere fails with an install hint", async () => {
    const deps = baseDeps();
    const checks = await collectReadinessChecks({
      ...deps,
      probeAgent: () => ({
        resolved: true,
        displayName: "Claude Code",
        command: "claude",
        installed: false,
        alternatives: [],
      }),
    });

    const agent = checks.find((c) => c.id === "agent");
    expect(agent?.status).toBe("fail");
    expect(agent?.hint).toContain("AGENT_CLI_PATH");
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
