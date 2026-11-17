import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DashboardData } from "../src/lib/observability/dashboard-api";
import {
  buildWorkspaceResponse,
  deriveConfigSync,
  redactUrlCredentials,
} from "../src/lib/observability/dashboard-workspace";
import {
  fingerprintConfigFile,
  recordConfigApplied,
  recordConfigRejected,
} from "../src/lib/workspace/config-reload";
import type { WorkspaceResponse } from "../src/lib/observability/dashboard-workspace";
import { startDashboardServer } from "../src/dashboard-server";

const SECRET_VALUES = [
  "inline-team-secret",
  "team-file-secret",
  "repo-inline-secret",
  "shared-env-secret",
  "remote-password",
];

const WORKSPACE_TOML = `
[workspace]
ci_failure_fix = true

[workspace.execution]
isolation = "best_effort_host"
max_concurrency = 3
max_concurrency_per_repo = 2

[defaults]
tracker = "jira"
task_query = "project = DEV"

[[teams]]
name = "platform"
task_query = "project = PLAT"
env_file = "env/platform.env"
  [teams.env]
  JIRA_API_TOKEN = "inline-team-secret"

[[teams]]
name = "web"
tracker = "github"
task_query = "is:open"
repo = "web"
env_file = "env/missing.env"

[[repos]]
name = "web"
remote = "https://bot:remote-password@github.com/acme/web.git"
  [repos.env]
  GITHUB_TOKEN = "repo-inline-secret"

[[routing.rules]]
repo = "web"
team = "platform"
labels = ["frontend"]

[[automations]]
id = "nightly"
enabled = true
interval = "6h"
repo = "web"
open_pr = true
prompt = "Tidy up."

[[estimations]]
id = "groom"
enabled = false
cron = "0 9 * * 1-5"
query = "status = 'To Do'"
`;

describe("GET /api/workspace", () => {
  let workspaceDir: string;
  let data: DashboardData;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "dash-workspace-"));
    data = new DashboardData({
      dbPath: join(workspaceDir, "queue.db"),
      workingDir: workspaceDir,
      workspaceDir,
      logDirs: [],
    });
  });

  afterEach(() => {
    data.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeWorkspace(toml: string = WORKSPACE_TOML): void {
    writeFileSync(join(workspaceDir, "workspace.toml"), toml);
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "env", "platform.env"),
      "# team creds\nJIRA_EMAIL=bot@example.com\nJIRA_BASE_URL='team-file-secret'\n",
    );
    writeFileSync(join(workspaceDir, ".env"), "LICENSE_KEY=shared-env-secret\n");
  }

  test("serves env key names but never env values or URL credentials", () => {
    writeWorkspace();
    const body = buildWorkspaceResponse(data);
    const serialized = JSON.stringify(body);
    for (const secret of SECRET_VALUES) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("bot@example.com");

    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;
    const [platform, web] = body.config.teams;
    expect(platform).toMatchObject({
      name: "platform",
      tracker: "jira", // inherited from [defaults], like the worker
      envKeys: ["JIRA_API_TOKEN"],
      envFile: {
        path: "env/platform.env",
        resolvedPath: join(workspaceDir, "env", "platform.env"),
        exists: true,
        keys: ["JIRA_BASE_URL", "JIRA_EMAIL"],
      },
    });
    expect(web?.envFile).toMatchObject({ exists: false, keys: [] });
    expect(body.config.sharedEnv).toMatchObject({ exists: true, keys: ["LICENSE_KEY"] });
    expect(body.config.repos[0]).toMatchObject({
      name: "web",
      remote: "https://github.com/acme/web.git",
      envKeys: ["GITHUB_TOKEN"],
    });
  });

  test("returns validated settings, routing, automations, and estimations", () => {
    writeWorkspace();
    const body = buildWorkspaceResponse(data);
    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;
    expect(body.config.workspace.execution).toEqual({
      isolation: "best_effort_host",
      maxConcurrency: 3,
      maxConcurrencyPerRepo: 2,
    });
    expect(body.config.workspace.ciFailureFix).toBe(true);
    expect(body.config.workspace.conflictResolution).toBe("auto");
    expect(body.config.defaults.pollIntervalSeconds).toBe(60);
    expect(body.config.routing).toEqual([
      { repo: "web", team: "platform", components: [], labels: ["frontend"] },
    ]);
    expect(body.config.automations).toEqual([
      {
        id: "nightly",
        enabled: true,
        cron: undefined,
        interval: "6h",
        repo: "web",
        openPr: true,
        allowNoChanges: false,
        prompt: "Tidy up.",
      },
    ]);
    expect(body.config.estimations).toEqual([
      { id: "groom", enabled: false, query: "status = 'To Do'", cron: "0 9 * * 1-5" },
    ]);
    expect(body.configPath).toBe(join(workspaceDir, "workspace.toml"));
    expect(typeof body.fileModifiedAt).toBe("number");
  });

  test("a missing config is a typed state, not an error", () => {
    const body = buildWorkspaceResponse(data);
    expect(body.status).toBe("missing");
    expect(body.fileModifiedAt).toBeUndefined();
    if (body.status === "missing") expect(body.error).toContain("devintern worker scaffold");
  });

  test("validation problems are listed individually", () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "jira"\n[[repos]]\nname = "a"\n',
    );
    const body = buildWorkspaceResponse(data);
    expect(body.status).toBe("invalid");
    if (body.status !== "invalid") return;
    expect(body.error).toStartWith("Invalid ");
    expect(body.problems.length).toBeGreaterThan(0);
  });

  test("TOML syntax errors do not echo the offending value", () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      '[[teams]]\nname = "a"\n[teams.env]\nTOKEN = ghp_unquotedsecret\n',
    );
    const body = buildWorkspaceResponse(data);
    expect(body.status).toBe("invalid");
    expect(JSON.stringify(body)).not.toContain("ghp_unquotedsecret");
  });

  test("flags a config edited after the running worker started", () => {
    writeWorkspace();
    const startedAt = new Date(Date.now() - 60_000);
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: startedAt.toISOString() }),
    );
    const before = buildWorkspaceResponse(data);
    expect(before.workerStartedAt).toBe(startedAt.getTime());
    expect(before.staleSinceWorkerStart).toBe(true);

    const older = new Date(startedAt.getTime() - 60_000);
    utimesSync(join(workspaceDir, "workspace.toml"), older, older);
    expect(buildWorkspaceResponse(data).staleSinceWorkerStart).toBe(false);
  });

  describe("configSync", () => {
    const configPath = () => join(workspaceDir, "workspace.toml");
    function runWorker(startedAt = new Date(Date.now() - 60_000)): void {
      writeFileSync(
        join(workspaceDir, ".worker.lock"),
        JSON.stringify({ pid: process.pid, timestamp: startedAt.toISOString() }),
      );
    }

    test("applied after a hot reload even though the file is newer than the worker", () => {
      writeWorkspace();
      runWorker();
      recordConfigApplied(workspaceDir, configPath());
      const body = buildWorkspaceResponse(data);
      expect(body.staleSinceWorkerStart).toBe(true);
      expect(body.configSync).toBe("applied");
      expect(body.appliedConfig?.fileModifiedAt).toBe(
        fingerprintConfigFile(configPath())?.fileModifiedAt,
      );
      expect(body.appliedConfig?.rejectedReason).toBeUndefined();
    });

    test("pending when the file changed after the last applied version", () => {
      writeWorkspace();
      runWorker();
      recordConfigApplied(workspaceDir, configPath());
      writeFileSync(configPath(), `${WORKSPACE_TOML}\n# tweak\n`);
      expect(buildWorkspaceResponse(data).configSync).toBe("pending");
    });

    test("rejected with a redacted reason when this file version was refused", () => {
      writeWorkspace();
      runWorker();
      recordConfigApplied(workspaceDir, configPath());
      writeFileSync(configPath(), WORKSPACE_TOML.replace('tracker = "jira"', 'tracker = "linear"'));
      recordConfigRejected(
        workspaceDir,
        configPath(),
        '[defaults].tracker is startup-only; token "ghp_secretvalue" at https://u:pw@host/x',
      );
      const body = buildWorkspaceResponse(data);
      expect(body.configSync).toBe("rejected");
      expect(body.appliedConfig?.rejectedReason).toContain("[defaults].tracker is startup-only");
      expect(body.appliedConfig?.rejectedReason).not.toContain("ghp_secretvalue");
      expect(body.appliedConfig?.rejectedReason).not.toContain("pw@");
      expect(body.appliedConfig?.rejectedAt).toBeNumber();
    });

    test("an older worker without a record is unconfirmed only when the file is newer", () => {
      writeWorkspace();
      runWorker();
      expect(buildWorkspaceResponse(data).configSync).toBe("unconfirmed");
      const older = new Date(Date.now() - 120_000);
      utimesSync(configPath(), older, older);
      const body = buildWorkspaceResponse(data);
      expect(body.configSync).toBe("applied");
      expect(body.appliedConfig).toBeUndefined();
    });

    test("a record from another process is ignored", () => {
      const file = { fileModifiedAt: 2_000, contentHash: "abc" };
      const record = { pid: 999_999, appliedAt: 1_500, ...file };
      expect(deriveConfigSync(record, file, { pid: 1, startedAt: 1_000 })).toEqual({
        configSync: "unconfirmed",
      });
      expect(deriveConfigSync(record, file, { pid: 999_999, startedAt: 1_000 }).configSync).toBe(
        "applied",
      );
    });

    test("absent without a running worker", () => {
      writeWorkspace();
      recordConfigApplied(workspaceDir, configPath());
      const body = buildWorkspaceResponse(data);
      expect(body.configSync).toBeUndefined();
      expect(body.appliedConfig).toBeUndefined();
    });
  });

  test("without a running worker the stale flag is absent", () => {
    writeWorkspace();
    expect(buildWorkspaceResponse(data).staleSinceWorkerStart).toBeUndefined();
  });

  test("redactUrlCredentials strips userinfo only", () => {
    expect(redactUrlCredentials("https://u:p@host/x and https://tok@host/z")).toBe(
      "https://host/x and https://host/z",
    );
    expect(redactUrlCredentials("ssh://git@host/y")).toBe("ssh://git@host/y");
    expect(redactUrlCredentials("ssh://git:pw@host/y")).toBe("ssh://host/y");
    expect(redactUrlCredentials("git@github.com:acme/api.git")).toBe("git@github.com:acme/api.git");
  });

  test("the server routes /api/workspace", async () => {
    writeWorkspace();
    const server = startDashboardServer({
      port: 0,
      dbPath: join(workspaceDir, "queue.db"),
      workingDir: workspaceDir,
      workspaceDir,
      logDirs: [],
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/workspace`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as WorkspaceResponse;
      expect(body.status).toBe("ok");
      expect(JSON.stringify(body)).not.toContain("inline-team-secret");
    } finally {
      server.stop(true);
    }
  });
});
