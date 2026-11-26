import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { probeGitHubCiPermissions } from "../src/lib/code-host/github/ci-permission-probe";
import type {
  CiProbeCredential,
  CiProbeFetch,
} from "../src/lib/code-host/github/ci-permission-probe";
import type { ReadinessCheck } from "../src/lib/observability/readiness";
import { collectWorkerDoctorChecks } from "../src/lib/observability/worker-readiness";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";
import { warnOnCiPermissionIssues } from "../src/lib/workspace/ci-permission-check";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

/** Placeholder credential; asserted never to appear in any output. */
const TOKEN = "placeholder-token-value";

type Route = number | "network";

/** Fake GitHub API: status code (or a thrown network error) per endpoint. */
function fakeGitHub(routes: { statuses?: Route; checks?: Route; actions?: Route; repo?: Route }): {
  fetch: CiProbeFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: CiProbeFetch = async (url, init) => {
    urls.push(url);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const route = url.endsWith("/status")
      ? routes.statuses
      : url.includes("/check-runs")
        ? routes.checks
        : url.includes("/actions/runs")
          ? routes.actions
          : routes.repo;
    if (route === "network") throw new TypeError("fetch failed: ECONNREFUSED");
    const status = route ?? 200;
    const body = url.endsWith("/repos/acme/app") ? { default_branch: "main" } : {};
    return new Response(JSON.stringify(status < 300 ? body : { message: "denied" }), { status });
  };
  return { fetch, urls };
}

const token: CiProbeCredential = { kind: "token", token: TOKEN, source: "GITHUB_TOKEN in .env" };
const app: CiProbeCredential = { kind: "app", getToken: async () => TOKEN };

describe("probeGitHubCiPermissions", () => {
  test("all readable is ok", async () => {
    const { fetch, urls } = fakeGitHub({});
    const result = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: token,
      ciFailureFix: true,
      fetch,
    });
    expect(result.status).toBe("ok");
    expect(urls).toContain("https://api.github.com/repos/acme/app/commits/main/status");
    expect(urls).toContain("https://api.github.com/repos/acme/app/actions/runs?per_page=1");
  });

  test("statuses 403 fails and names Commit statuses: Read and the token source", async () => {
    const { fetch } = fakeGitHub({ statuses: 403 });
    const result = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: token,
      ciFailureFix: false,
      fetch,
    });
    expect(result.status).toBe("fail");
    const failed = result.findings.find((finding) => finding.status === "fail");
    expect(failed?.hint).toContain("Commit statuses: Read");
    expect(failed?.hint).toContain("GITHUB_TOKEN in .env");
    expect(failed?.hint).toContain("configuration.md#github-authentication");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("check-runs 403 with a token is info, not a warning", async () => {
    const { fetch } = fakeGitHub({ checks: 403 });
    const result = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: token,
      ciFailureFix: false,
      fetch,
    });
    expect(result.status).toBe("info");
    expect(result.findings.map((finding) => finding.detail).join()).toContain(
      "fine-grained tokens can't be granted Checks",
    );
  });

  test("check-runs 403 with a GitHub App warns with Checks: Read", async () => {
    const { fetch } = fakeGitHub({ checks: 403 });
    const result = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: app,
      ciFailureFix: false,
      fetch,
    });
    expect(result.status).toBe("warn");
    expect(result.findings.find((finding) => finding.status === "warn")?.hint).toContain(
      "Checks: Read",
    );
  });

  test("Actions 403 fails only when ci_failure_fix is on", async () => {
    const { fetch } = fakeGitHub({ actions: 403 });
    const on = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: token,
      ciFailureFix: true,
      fetch,
    });
    expect(on.status).toBe("fail");
    expect(on.findings.find((finding) => finding.status === "fail")?.hint).toContain(
      "Actions: Read",
    );
    const { fetch: offFetch, urls } = fakeGitHub({ actions: 403 });
    const off = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: token,
      ciFailureFix: false,
      fetch: offFetch,
    });
    expect(off.status).toBe("ok");
    expect(urls.some((url) => url.includes("/actions/runs"))).toBe(false);
  });

  test("network errors, 5xx and rate limits warn, never fail", async () => {
    for (const routes of [
      { repo: "network" as const },
      { statuses: "network" as const },
      { statuses: 502 },
    ]) {
      const { fetch } = fakeGitHub(routes);
      const result = await probeGitHubCiPermissions({
        slug: "acme/app",
        credential: token,
        ciFailureFix: true,
        fetch,
      });
      expect(result.status).toBe("warn");
      expect(result.findings.some((finding) => finding.detail.includes("couldn't verify"))).toBe(
        true,
      );
    }
    const rateLimited: CiProbeFetch = async (url) =>
      url.endsWith("/repos/acme/app")
        ? new Response(JSON.stringify({ default_branch: "main" }))
        : new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const result = await probeGitHubCiPermissions({
      slug: "acme/app",
      credential: token,
      ciFailureFix: true,
      fetch: rateLimited,
    });
    expect(result.status).toBe("warn");
  });
});

describe("worker doctor CI status access rows", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "ci-permission-doctor-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeWorkspace(workspaceKeys: string): string {
    const configPath = join(workspaceDir, "workspace.toml");
    writeFileSync(
      configPath,
      `[workspace]\n${workspaceKeys}\n\n[defaults]\ntracker = "jira"\ntask_query = "project = APP"\n\n[[repos]]\nname = "app"\nremote = "https://github.com/acme/app.git"\n`,
    );
    writeFileSync(
      join(workspaceDir, ".env"),
      `JIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=bot@acme.com\nJIRA_API_TOKEN=x\nGITHUB_TOKEN=${TOKEN}\n`,
    );
    return configPath;
  }

  function deps(fetch: CiProbeFetch, overrides: Partial<WorkerDoctorDeps> = {}): WorkerDoctorDeps {
    const ok = (id: string): ReadinessCheck => ({ id, label: id, status: "ok" });
    return {
      processEnv: {},
      probeCredentials: async () => {},
      dryRunQuery: async () => 3,
      checkRepoAccess: async () => ({ ok: true }),
      checkEntitlement: async () => ({ valid: true, source: "entitlement", message: "" }),
      checkHarness: async () => ok("harness"),
      checkSandbox: async () => ok("sandbox"),
      checkGitIdentity: async () => ok("git-identity"),
      isPortInUse: async () => false,
      workerStatus: () => ({ status: "stopped" }),
      usesHostedGitHubApp: async () => true,
      ciProbeFetch: fetch,
      ...overrides,
    };
  }

  test("statuses 403 is a failing row naming the permission and env file", async () => {
    const workspacePath = writeWorkspace("auto_merge = true");
    const { fetch } = fakeGitHub({ statuses: 403 });
    const checks = await collectWorkerDoctorChecks({ workspacePath }, deps(fetch));
    const rows = checks.filter((check) => check.id === "ci-permissions");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("fail");
    expect(rows[0]?.hint).toContain("Commit statuses: Read");
    expect(rows[0]?.hint).toContain(join(workspaceDir, ".env"));
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });

  test("check-runs 403 for a token is an ok row", async () => {
    const workspacePath = writeWorkspace("ci_failure_fix = true");
    const { fetch } = fakeGitHub({ checks: 403 });
    const checks = await collectWorkerDoctorChecks({ workspacePath }, deps(fetch));
    const [row] = checks.filter((check) => check.id === "ci-permissions");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("check-run names hidden");
  });

  test("no row and no probe when auto-merge and CI fixes are off", async () => {
    const workspacePath = writeWorkspace("");
    const { fetch, urls } = fakeGitHub({});
    const checks = await collectWorkerDoctorChecks({ workspacePath }, deps(fetch));
    expect(checks.filter((check) => check.id === "ci-permissions")).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });

  test("--offline skips the probe with a warning", async () => {
    const workspacePath = writeWorkspace("auto_merge = true");
    const { fetch, urls } = fakeGitHub({});
    const checks = await collectWorkerDoctorChecks(
      { workspacePath, offline: true },
      deps(fetch, {
        usesHostedGitHubApp: async () => {
          throw new Error("must not run offline");
        },
      }),
    );
    const [row] = checks.filter((check) => check.id === "ci-permissions");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("skipped (--offline)");
    expect(urls).toHaveLength(0);
  });
});

describe("warnOnCiPermissionIssues", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "ci-permission-startup-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function config(workspaceKeys: string) {
    return parseWorkspaceConfig(
      `[workspace]\n${workspaceKeys}\n\n[defaults]\ntracker = "jira"\n\n[[repos]]\nname = "app"\nremote = "https://github.com/acme/app.git"\n`,
    );
  }

  test("prints one warning line for a failing repo, without the token", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fetch } = fakeGitHub({ statuses: 403, checks: 403 });
      await warnOnCiPermissionIssues(config("auto_merge = true"), workspaceDir, {
        processEnv: { GITHUB_TOKEN: TOKEN },
        usesHostedApp: true,
        fetch,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("app");
      expect(line).toContain("Commit statuses: Read");
      expect(line).not.toContain("\n");
      expect(line).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  test("stays quiet for network errors and when the features are off", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fetch } = fakeGitHub({ repo: "network" });
      await warnOnCiPermissionIssues(config("ci_failure_fix = true"), workspaceDir, {
        processEnv: { GITHUB_TOKEN: TOKEN },
        usesHostedApp: true,
        fetch,
      });
      const off = fakeGitHub({ statuses: 403 });
      await warnOnCiPermissionIssues(config(""), workspaceDir, {
        processEnv: { GITHUB_TOKEN: TOKEN },
        usesHostedApp: true,
        fetch: off.fetch,
      });
      expect(off.urls).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
