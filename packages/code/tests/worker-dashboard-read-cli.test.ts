import { Database } from "bun:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AutomationStateStore } from "../src/lib/automation/state";
import type { AutomationConfig } from "../src/lib/automation/config";
import { loadWorkspaceAutomationActions } from "../src/lib/automation/workspace-dashboard";
import {
  DashboardData,
  handleAgentPrs,
  handleAutomations,
  handleLogs,
  handleRunArtifacts,
  handleRunDetail,
  handleRunHarnessLog,
  handleRunHarnessLogs,
  handleRuns,
  handleStats,
  handleWorkerStatus,
} from "../src/lib/observability/dashboard-api";
import type { ApiResponse } from "../src/lib/observability/dashboard-api";
import { handleOverview } from "../src/lib/observability/dashboard-overview";
import { harnessLogFileName, harnessLogsDir } from "../src/lib/observability/harness-logs";
import { handleQueuedWork } from "../src/lib/observability/queued-work";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { WorkerState } from "../src/lib/state/worker-state";
import { renderStats, runWorkerReadCommand } from "../src/lib/worker/dashboard-read-cli";
import type { WorkerReadCommand } from "../src/lib/worker/dashboard-read-cli";
import { workspaceDbPath, workspaceStateDir } from "../src/lib/workspace/paths";

setDefaultTimeout(30_000);

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

const WORKSPACE_TOML = `
[defaults]
tracker = "markdown"

[[repos]]
name = "web"
remote = "https://github.com/acme/web.git"

[[automations]]
id = "execution-retro"
enabled = true
cron = "0 3 * * *"
repo = "web"
prompt = "Review yesterday's runs."
`;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: WorkerReadCommand, args: string[]): Captured {
  let stdout = "";
  let stderr = "";
  const code = runWorkerReadCommand(command, args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

/** The response body as it travels over HTTP (`undefined` fields dropped). */
function wire(response: ApiResponse): unknown {
  expect(response.status).toBe(200);
  return JSON.parse(JSON.stringify(response.body));
}

/**
 * Drop busy time accrued by the in-progress `local` fixture run: it counts up
 * to "now", so the CLI subprocess and the in-process handler see different
 * values milliseconds apart. Everything else in the body must match exactly.
 */
function withoutLiveBusyTime(body: unknown): unknown {
  const activity = (
    body as { stats?: { activity?: { cells?: { origin: string; busyMs?: number }[] } } }
  )?.stats?.activity;
  for (const cell of activity?.cells ?? []) {
    if (cell.origin === "local") delete cell.busyMs;
  }
  return body;
}

/** Hash every file in the state dir so any write (DB, WAL, new file) shows up. */
function snapshotStateDir(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    result[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return result;
}

describe("devintern worker read-only dashboard commands", () => {
  let workspaceDir: string;
  let dbPath: string;
  let runIds: { retro: number; failed: number };
  let logName: string;
  let savedWorkspaceEnv: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worker-read-cli-"));
    savedWorkspaceEnv = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    writeFileSync(join(workspaceDir, "workspace.toml"), WORKSPACE_TOML);
    dbPath = workspaceDbPath(workspaceDir);
    mkdirSync(workspaceStateDir(workspaceDir), { recursive: true });

    const runs = new RunStore(dbPath);
    const retro = runs.createRun({
      origin: "scheduled",
      automationId: "execution-retro",
      taskKey: "execution-retro-2026-11-17",
      repo: "web",
      harness: "claude-code",
    });
    runs.addStage(retro, "implementation", "succeeded", "agent ran", JSON.stringify({ turns: 3 }));
    runs.finishRun(retro, "succeeded");
    const failed = runs.createRun({ origin: "task", taskKey: "PROJ-1", repo: "web" });
    runs.finishRun(failed, "failed", "tests failed");
    runs.createRun({ origin: "local", taskKey: "local-active", repo: "web" });
    runs.close();
    runIds = { retro, failed };

    const state = new WorkerState(dbPath);
    state.recordAgentPr({
      repo: "acme/web",
      prNumber: 7,
      branch: "feature/proj-1",
      taskKey: "PROJ-1",
    });
    state.recordAgentPr({ repo: "acme/web", prNumber: 6, taskKey: "PROJ-0" });
    state.markAgentPrClosed("acme/web", 6, "merged");
    state.setCursor("markdown", "cursor-1");
    state.close();

    const injected = new InjectedTaskStore(dbPath);
    injected.enqueue({
      taskKey: "local-queued",
      repo: "web",
      title: "Queued work",
      body: "Do the thing",
      taskFile: join(workspaceDir, "local-queued.md"),
    });
    injected.close();
    const retries = new ScheduledRetryStore(dbPath);
    retries.schedule({ taskKey: "PROJ-1", runId: failed, repo: "web", actor: "tester" });
    retries.close();
    const schedules = new AutomationStateStore(dbPath);
    schedules.register(
      { id: "execution-retro", cron: "0 3 * * *" } as AutomationConfig,
      1_800_000_000_000,
    );
    schedules.close();

    logName = harnessLogFileName({
      startedAt: new Date(),
      origin: "scheduled",
      runId: retro,
      taskKey: "execution-retro-2026-11-17",
      label: "implementation",
    });
    mkdirSync(harnessLogsDir(workspaceDir), { recursive: true });
    writeFileSync(
      join(harnessLogsDir(workspaceDir), logName),
      "=== devintern harness run ===\nhello\n",
    );
    writeFileSync(
      join(workspaceDir, "worker.stdout.log"),
      "2026-11-17T07:00:00.000Z 🔄 Processing PROJ-1\n2026-11-17T07:00:01.000Z ✅ done\n",
    );
  });

  afterEach(() => {
    if (savedWorkspaceEnv === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceEnv;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  /** The data source the worker-embedded dashboard serves for this workspace. */
  function embeddedDashboardData(): DashboardData {
    return new DashboardData({
      dbPath,
      queueDbPath: dbPath,
      workingDir: workspaceDir,
      workspaceDir,
      retryMode: "schedule",
      automationActions: loadWorkspaceAutomationActions(workspaceDir),
    });
  }

  test("--json prints exactly the dashboard handler body for every command", () => {
    // Freeze the clock: the in-progress fixture run's busy time counts up to
    // `now`, so CLI and handler output would otherwise differ by a millisecond.
    setSystemTime(new Date());
    const data = embeddedDashboardData();
    try {
      const cases: [WorkerReadCommand, string[], () => ApiResponse][] = [
        ["runs", [], () => handleRuns(data, new URLSearchParams())],
        [
          "runs",
          ["--automation", "execution-retro", "--status", "succeeded", "--limit", "5"],
          () =>
            handleRuns(
              data,
              new URLSearchParams({
                automationId: "execution-retro",
                status: "succeeded",
                limit: "5",
              }),
            ),
        ],
        [
          "runs",
          ["--origin", "task", "--task-key", "PROJ-1", "--offset", "0"],
          () =>
            handleRuns(
              data,
              new URLSearchParams({ origin: "task", taskKey: "PROJ-1", offset: "0" }),
            ),
        ],
        [
          "runs",
          ["show", String(runIds.failed)],
          () => handleRunDetail(data, String(runIds.failed)),
        ],
        ["runs", ["show", String(runIds.retro)], () => handleRunDetail(data, String(runIds.retro))],
        [
          "runs",
          ["logs", String(runIds.retro)],
          () => handleRunHarnessLogs(data, String(runIds.retro)),
        ],
        [
          "runs",
          ["logs", String(runIds.retro), logName],
          () => handleRunHarnessLog(data, String(runIds.retro), logName),
        ],
        [
          "runs",
          ["artifacts", String(runIds.retro)],
          () => handleRunArtifacts(data, String(runIds.retro)),
        ],
        ["stats", [], () => handleStats(data, new URLSearchParams())],
        [
          "stats",
          ["--window", "7d"],
          () => handleStats(data, new URLSearchParams({ window: "7d" })),
        ],
        ["automations", [], () => handleAutomations(data)],
        ["prs", [], () => handleAgentPrs(data)],
        ["queue", [], () => handleQueuedWork(data)],
        ["status", [], () => handleWorkerStatus(data)],
        ["logs", [], () => handleLogs(data, new URLSearchParams())],
        [
          "logs",
          ["--lines", "1", "--level", "info"],
          () => handleLogs(data, new URLSearchParams({ limit: "1", level: "info" })),
        ],
      ];
      // The in-progress "local-active" run counts busy time up to `now`, so the
      // CLI call and the reference handler call must see the same clock.
      setSystemTime(Date.now());
      for (const [command, args, handler] of cases) {
        const result = run(command, [...args, "--json"]);
        expect({ args: [command, ...args], stderr: result.stderr, code: result.code }).toEqual({
          args: [command, ...args],
          stderr: "",
          code: 0,
        });
        expect(withoutLiveBusyTime(JSON.parse(result.stdout))).toEqual(
          withoutLiveBusyTime(wire(handler())),
        );
      }

      // Overview carries a generation timestamp; everything else must match.
      const overview = run("overview", ["--json"]);
      expect(overview.code).toBe(0);
      const { generatedAt: _cli, ...cliOverview } = JSON.parse(overview.stdout);
      const { generatedAt: _api, ...apiOverview } = wire(handleOverview(data)) as Record<
        string,
        unknown
      >;
      expect(cliOverview).toEqual(apiOverview);
    } finally {
      setSystemTime();
      data.close();
      setSystemTime();
    }
  });

  test("fixture data is actually served (not an empty fallback)", () => {
    const runs = JSON.parse(run("runs", ["--automation", "execution-retro", "--json"]).stdout);
    expect(runs.total).toBe(1);
    expect(runs.runs[0].id).toBe(runIds.retro);

    const detail = JSON.parse(run("runs", ["show", String(runIds.retro), "--json"]).stdout);
    expect(detail.stages[0].detail).toBe(JSON.stringify({ turns: 3 }));
    expect(detail.harnessLogs.map((log: { name: string }) => log.name)).toEqual([logName]);

    const automations = JSON.parse(run("automations", ["--json"]).stdout).automations;
    expect(automations[0]).toMatchObject({
      id: "execution-retro",
      nextDueAt: 1_800_000_000_000,
      lastRun: { id: runIds.retro },
    });
    expect(JSON.parse(run("prs", ["--json"]).stdout).prs[0].prNumber).toBe(7);
    const merged = JSON.parse(run("prs", ["--state", "merged", "--json"]).stdout).prs;
    expect(merged.map((pr: { prNumber: number }) => pr.prNumber)).toEqual([6]);
    const queue = JSON.parse(run("queue", ["--json"]).stdout);
    expect(queue.items.map((item: { kind: string }) => item.kind).sort()).toEqual([
      "ad-hoc",
      "retry",
    ]);
    const status = JSON.parse(run("status", ["--json"]).stdout);
    expect(status.dbPath).toBe(dbPath);
    expect(status.queue.injected.pending).toBe(1);
  });

  test("human output summarizes the data", () => {
    const runs = run("runs", []);
    expect(runs.code).toBe(0);
    expect(runs.stdout).toContain("execution-retro");
    expect(runs.stdout).toContain("Showing 3 of 3 run(s).");
    const detail = run("runs", ["show", String(runIds.retro)]);
    expect(detail.stdout).toContain("implementation [succeeded] agent ran");
    expect(detail.stdout).toContain('"turns": 3');
    expect(run("stats", ["--window", "all"]).stdout).toContain(
      "Success rate:     50% (excludes auto-merge)",
    );
    expect(run("status", []).stdout).toContain("Ad-hoc:     1 pending, 0 running");
    expect(run("logs", []).stdout).toContain("Processing PROJ-1");
    const merged = run("prs", ["--state", "merged"]);
    expect(merged.stdout).toContain("MERGED");
    expect(merged.stdout).toContain("PROJ-0");
    expect(run("prs", ["--state", "closed"]).code).not.toBe(0);
  });

  test("status says unknown when the worker lock is from another PID namespace", () => {
    writeFileSync(
      join(workspaceDir, ".worker.lock"),
      JSON.stringify({
        pid: 999_999_999,
        timestamp: "2026-11-17T10:11:59.687Z",
        heartbeatAt: new Date().toISOString(),
        pidNamespace: "pid:[foreign-test-namespace]",
      }),
    );
    const text = run("status", []).stdout;
    expect(text).toContain(
      "Worker:     unknown (cannot verify from this sandbox; pid 999999999) since 2026-11-17T10:11:59.687Z",
    );
    expect(JSON.parse(run("status", ["--json"]).stdout).worker).toMatchObject({
      status: "unknown",
      reason: "pid-namespace",
    });
  });

  test("--workspace accepts the workspace dir or its workspace.toml", () => {
    process.env.DEVINTERN_WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "worker-read-other-"));
    try {
      for (const arg of [workspaceDir, join(workspaceDir, "workspace.toml")]) {
        const result = run("runs", ["--workspace", arg, "--json"]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).total).toBe(3);
      }
      // Without the flag the (empty) DEVINTERN_WORKSPACE_DIR is used.
      expect(run("runs", ["--json"]).code).toBe(1);
    } finally {
      rmSync(process.env.DEVINTERN_WORKSPACE_DIR, { recursive: true, force: true });
    }
  });

  test("never writes the database or its state directory", () => {
    const stateDir = workspaceStateDir(workspaceDir);
    // A first read may leave SQLite's empty WAL sidecars; after that the
    // directory must be byte-for-byte unchanged by any command.
    run("status", ["--json"]);
    const before = snapshotStateDir(stateDir);
    for (const [command, args] of [
      ["runs", []],
      ["runs", ["show", String(runIds.failed)]],
      ["runs", ["logs", String(runIds.retro)]],
      ["runs", ["artifacts", String(runIds.retro)]],
      ["stats", []],
      ["automations", []],
      ["prs", []],
      ["queue", []],
      ["status", []],
      ["overview", []],
      ["logs", []],
    ] as [WorkerReadCommand, string[]][]) {
      expect(run(command, [...args, "--json"]).code).toBe(0);
    }
    expect(snapshotStateDir(stateDir)).toEqual(before);
  });

  test("missing database exits non-zero with a clear message and creates nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "worker-read-empty-"));
    try {
      writeFileSync(join(empty, "workspace.toml"), WORKSPACE_TOML);
      const result = run("runs", ["--workspace", empty, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`No worker database at ${workspaceDbPath(empty)}`);
      expect(existsSync(workspaceStateDir(empty))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("unreadable database exits non-zero", () => {
    const broken = mkdtempSync(join(tmpdir(), "worker-read-broken-"));
    try {
      writeFileSync(join(broken, "workspace.toml"), WORKSPACE_TOML);
      mkdirSync(workspaceStateDir(broken), { recursive: true });
      writeFileSync(workspaceDbPath(broken), "this is not a sqlite database at all, just text");
      const result = run("stats", ["--workspace", broken]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Cannot read the worker database");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("API errors and bad arguments exit non-zero on stderr", () => {
    for (const [command, args, message] of [
      ["runs", ["show", "99999"], "run 99999 not found"],
      ["runs", ["show", "abc"], "run id must be an integer"],
      ["runs", ["--limit", "500"], "limit must be between 1 and 200"],
      ["runs", ["--status", "nope"], "status must be one of"],
      ["stats", ["--window", "3d"], "window must be one of"],
      ["logs", ["--level", "debug"], "level must be one of"],
      ["runs", ["--bogus"], "Unknown option"],
      ["runs", ["show"], "Usage: devintern worker runs show <id>"],
      ["prs", ["extra"], "Usage: devintern worker prs"],
    ] as [WorkerReadCommand, string[], string][]) {
      const result = run(command, [...args, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    }
  });

  test("--help describes each command without touching the database", () => {
    rmSync(workspaceStateDir(workspaceDir), { recursive: true, force: true });
    for (const [command, args, route] of [
      ["runs", [], "GET /api/runs"],
      ["runs", ["show"], "GET /api/runs/:id"],
      ["runs", ["logs"], "harness-logs"],
      ["runs", ["artifacts"], "artifacts"],
      ["stats", [], "GET /api/stats"],
      ["automations", [], "GET /api/automations"],
      ["prs", [], "GET /api/agent-prs"],
      ["queue", [], "GET /api/queue"],
      ["status", [], "GET /api/worker"],
      ["overview", [], "GET /api/overview"],
      ["logs", [], "GET /api/logs"],
    ] as [WorkerReadCommand, string[], string][]) {
      const result = run(command, [...args, "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage: devintern worker");
      expect(result.stdout).toContain(route);
      expect(result.stdout).toContain("--json");
    }
    expect(existsSync(workspaceStateDir(workspaceDir))).toBe(false);
  });
});

describe("devintern worker runs on a read-only state directory", () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worker-read-ro-"));
    stateDir = workspaceStateDir(workspaceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(workspaceDir, "workspace.toml"), WORKSPACE_TOML);
  });

  afterEach(() => {
    chmodSync(stateDir, 0o755);
    for (const name of readdirSync(stateDir)) chmodSync(join(stateDir, name), 0o644);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function cli(args: string[]): Promise<Captured> {
    const proc = Bun.spawn({
      cmd: ["bun", CLI_PATH, "worker", ...args],
      cwd: workspaceDir,
      env: {
        ...process.env,
        DEVINTERN_WORKSPACE_DIR: workspaceDir,
        DEVINTERN_NO_UPDATE: "1",
        SENTRY_DISABLED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("reads rows that exist only in a live WAL, without writing anything", async () => {
    const dbPath = workspaceDbPath(workspaceDir);
    const store = new RunStore(dbPath);
    store.close();
    // The "worker": a writer that keeps its connection (and the WAL) open and
    // never checkpoints, so the new rows live only in the -wal file.
    const writer = new Database(dbPath);
    try {
      writer.run("PRAGMA journal_mode = WAL");
      writer.run("PRAGMA wal_autocheckpoint = 0");
      const recorder = new RunStore(dbPath);
      for (let i = 0; i < 3; i++) {
        const id = recorder.createRun({ origin: "scheduled", automationId: "execution-retro" });
        recorder.finishRun(id, "succeeded");
      }
      // RunStore.close() would checkpoint only as the last connection; the
      // writer above stays open, so the WAL keeps the rows.
      recorder.close();
      expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0);

      // Simulate the sandbox's read-only mount.
      for (const name of readdirSync(stateDir)) chmodSync(join(stateDir, name), 0o444);
      chmodSync(stateDir, 0o555);
      let writable = true;
      try {
        writeFileSync(join(stateDir, "probe"), "x");
      } catch {
        writable = false;
      }
      if (writable) {
        // Running as root: permissions are not enforced, nothing to verify.
        rmSync(join(stateDir, "probe"), { force: true });
        return;
      }
      const before = snapshotStateDir(stateDir);

      const result = await cli([
        "runs",
        "--automation",
        "execution-retro",
        "--limit",
        "3",
        "--json",
      ]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.total).toBe(3);
      expect(body.runs).toHaveLength(3);

      const stats = await cli(["stats", "--window", "7d", "--json"]);
      expect(stats.code).toBe(0);
      expect(JSON.parse(stats.stdout).stats.totals.runs).toBe(3);

      expect(snapshotStateDir(stateDir)).toEqual(before);
    } finally {
      // Let the writer checkpoint and clean up its WAL on close.
      chmodSync(stateDir, 0o755);
      for (const name of readdirSync(stateDir)) chmodSync(join(stateDir, name), 0o644);
      writer.close();
    }
  });
});

test("the worker dispatcher routes exactly the read-only command names", async () => {
  const cliSource = readFileSync(join(__dirname, "..", "src", "lib", "worker", "cli.ts"), "utf8");
  const listed = cliSource.match(/WORKER_READ_SUBCOMMANDS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  const names = [...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  const { WORKER_READ_COMMANDS } = await import("../src/lib/worker/dashboard-read-cli");
  expect(names).toEqual([...WORKER_READ_COMMANDS].sort());
});

describe("worker stats formatter", () => {
  function statsFor(
    runs: { origin: "task" | "auto_merge"; status: "succeeded" | "failed" | "escalated" }[],
  ) {
    const dir = mkdtempSync(join(tmpdir(), "stats-format-"));
    const store = new RunStore(join(dir, "queue.db"));
    try {
      for (const entry of runs) {
        const id = store.createRun({ origin: entry.origin, harness: "claude-code" });
        store.finishRun(id, entry.status);
      }
      return store.getStats(null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("labels the headline scope and reports auto-merge outcomes on their own line", () => {
    const stats = statsFor([
      { origin: "task", status: "succeeded" },
      { origin: "task", status: "escalated" },
      { origin: "auto_merge", status: "succeeded" },
      { origin: "auto_merge", status: "escalated" },
      { origin: "auto_merge", status: "escalated" },
      { origin: "auto_merge", status: "failed" },
    ]);
    const out = renderStats({ window: "all", stats });
    expect(out).toContain("Success rate:     50% (excludes auto-merge)");
    expect(out).toContain("Escalation rate:  50% (excludes auto-merge)");
    expect(out).toContain("Auto-merge:       1 merged, 2 left for review, 1 failed");
  });

  test("omits the auto-merge line when the window has no auto-merge runs", () => {
    const out = renderStats({
      window: "all",
      stats: statsFor([{ origin: "task", status: "succeeded" }]),
    });
    expect(out).toContain("Success rate:     100% (excludes auto-merge)");
    expect(out).not.toContain("Auto-merge:");
  });

  test("shows no headline rates when only auto-merge runs finished", () => {
    const out = renderStats({
      window: "all",
      stats: statsFor([{ origin: "auto_merge", status: "escalated" }]),
    });
    expect(out).toContain("Success rate:     - (excludes auto-merge)");
    expect(out).toContain("Escalation rate:  - (excludes auto-merge)");
    expect(out).toContain("Auto-merge:       0 merged, 1 left for review");
  });
});
