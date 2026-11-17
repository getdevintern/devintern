/**
 * Read-only `devintern worker <runs|stats|automations|prs|queue|status|overview|logs>`
 * commands: the dashboard's GET API without HTTP.
 *
 * Sandboxed agents cannot reach the worker dashboard on `localhost:4400` (a
 * bubblewrap network namespace has its own loopback), but they can read the
 * workspace state directory. These commands build the same
 * {@link DashboardData} the dashboard server uses and call its handlers
 * directly, so `--json` prints exactly the body of the matching `GET /api/...`
 * route and no query logic is duplicated.
 *
 * Strictly read-only: every store `DashboardData` opens for GET handlers uses
 * `bun:sqlite` `{ readonly: true }`, which reads committed rows still in the
 * WAL even when the state directory is mounted read-only (the native sandbox
 * does that). Nothing here creates, migrates, or writes the database, takes a
 * worker lock, opens a port, or touches the network.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { parseArgs } from "util";

import { loadWorkspaceAutomationActions } from "../automation/workspace-dashboard";
import {
  DashboardData,
  handleAgentPrs,
  handleAutomations,
  handleLogs,
  handleRunArtifact,
  handleRunArtifacts,
  handleRunDetail,
  handleRunHarnessLog,
  handleRunHarnessLogs,
  handleRuns,
  handleStats,
  handleWorkerStatus,
} from "../observability/dashboard-api";
import type {
  ApiResponse,
  DashboardAutomationView,
  EnrichedLogEntry,
  AgentPrView,
  RunHarnessLogFile,
  RunRetryInfo,
  WorkerQueueStats,
  WorkerStatusView,
} from "../observability/dashboard-api";
import { resolveWorkspaceArgPath } from "../observability/dashboard-db";
import { handleOverview } from "../observability/dashboard-overview";
import type { OverviewResponse } from "../observability/dashboard-overview";
import { handleQueuedWork } from "../observability/queued-work";
import type { QueuedWorkResponse } from "../observability/queued-work";
import type { TaskArtifactContent, TaskArtifactFile } from "../observability/task-artifacts";
import type { HarnessLogContent } from "../observability/harness-logs";
import type { RunRecord, RunStageRecord, RunStats } from "../state/run-recorder";
import type { WorkerLogsResult } from "../observability/worker-logs";
import { configureSqliteConnection } from "../state/sqlite";
import { resolveWorkspaceDir, workspaceDbPath } from "../workspace/paths";

/** Top-level `devintern worker` subcommands handled here. */
export const WORKER_READ_COMMANDS = [
  "runs",
  "stats",
  "automations",
  "prs",
  "queue",
  "status",
  "overview",
  "logs",
] as const;

export type WorkerReadCommand = (typeof WORKER_READ_COMMANDS)[number];

/** Whether `name` is one of the read-only dashboard subcommands. */
export function isWorkerReadCommand(name: string | undefined): name is WorkerReadCommand {
  return (WORKER_READ_COMMANDS as readonly string[]).includes(name ?? "");
}

/** Output sinks (tests capture them; the CLI writes to the process streams). */
export interface WorkerReadIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const PROCESS_IO: WorkerReadIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

type OptionSpec = { type: "string" | "boolean"; short?: string };
type ParsedValues = Record<string, string | boolean | undefined>;

interface CommandSpec {
  /** Usage line after `devintern worker `. */
  usage: string;
  /** Route served by the dashboard (shown in help). */
  route: string;
  description: string;
  /** Command-specific options and their help lines. */
  options: Record<string, OptionSpec>;
  optionHelp: string[];
  positionals: { min: number; max: number };
  /** Handler call; returns the response and the human renderer for its body. */
  run: (
    data: DashboardData,
    values: ParsedValues,
    positionals: string[],
  ) => { response: ApiResponse; render: (body: never) => string };
}

const COMMON_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean" },
  workspace: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const COMMON_OPTION_HELP = [
  "  --json              Print the dashboard API response body (same JSON as the route)",
  "  --workspace <path>  Use this workspace.toml or workspace directory (default:",
  "                      ~/.devintern, or DEVINTERN_WORKSPACE_DIR)",
  "  -h, --help          Display this help message",
];

/** Build URL query params from CLI flag values (unset flags are omitted). */
function queryParams(values: ParsedValues, mapping: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [flag, param] of Object.entries(mapping)) {
    const value = values[flag];
    if (typeof value === "string") params.set(param, value);
  }
  return params;
}

const RUNS_SPEC: CommandSpec = {
  usage:
    "runs [--automation <id>] [--origin <origin>] [--status <status>] [--task-key <key>] [--limit N] [--offset N]",
  route: "GET /api/runs",
  description: "List recorded runs, newest first, with optional filters.",
  options: {
    automation: { type: "string" },
    origin: { type: "string" },
    status: { type: "string" },
    "task-key": { type: "string" },
    limit: { type: "string" },
    offset: { type: "string" },
  },
  optionHelp: [
    "  --automation <id>   Only runs of this automation",
    "  --origin <origin>   task | error_monitor | pr_mention | ci_fix | conflict_resolution |",
    "                      auto_merge | scheduled | estimate | manual | local",
    "  --status <status>   in_progress | succeeded | failed | deferred | escalated | abandoned",
    "  --task-key <key>    Only runs of this task key",
    "  --limit N           Page size, 1..200 (default 50)",
    "  --offset N          Rows to skip (default 0)",
  ],
  positionals: { min: 0, max: 0 },
  run: (data, values) => ({
    response: handleRuns(
      data,
      queryParams(values, {
        automation: "automationId",
        origin: "origin",
        status: "status",
        "task-key": "taskKey",
        limit: "limit",
        offset: "offset",
      }),
    ),
    render: renderRuns,
  }),
};

const RUNS_SHOW_SPEC: CommandSpec = {
  usage: "runs show <id>",
  route: "GET /api/runs/:id",
  description: "Show one run: stages (with detail), retry eligibility, harness logs, artifacts.",
  options: {},
  optionHelp: [],
  positionals: { min: 1, max: 1 },
  run: (data, _values, [id]) => ({
    response: handleRunDetail(data, id ?? ""),
    render: renderRunDetail,
  }),
};

const RUNS_LOGS_SPEC: CommandSpec = {
  usage: "runs logs <id> [<name>]",
  route: "GET /api/runs/:id/harness-logs[/:name]",
  description:
    "List a run's harness (agent transcript) logs, or print the redacted tail of one log.",
  options: {},
  optionHelp: [],
  positionals: { min: 1, max: 2 },
  run: (data, _values, [id, name]) =>
    name === undefined
      ? { response: handleRunHarnessLogs(data, id ?? ""), render: renderHarnessLogs }
      : {
          // The HTTP route URL-decodes the name segment; encode so any name round-trips.
          response: handleRunHarnessLog(data, id ?? "", encodeURIComponent(name)),
          render: renderHarnessLog,
        },
};

const RUNS_ARTIFACTS_SPEC: CommandSpec = {
  usage: "runs artifacts <id> [<artifact-id>]",
  route: "GET /api/runs/:id/artifacts[/:artifactId]",
  description: "List a run's registered artifacts, or print one artifact's redacted content.",
  options: {},
  optionHelp: [],
  positionals: { min: 1, max: 2 },
  run: (data, _values, [id, artifactId]) =>
    artifactId === undefined
      ? { response: handleRunArtifacts(data, id ?? ""), render: renderArtifacts }
      : {
          response: handleRunArtifact(data, id ?? "", encodeURIComponent(artifactId)),
          render: renderArtifact,
        },
};

const SPECS: Record<string, CommandSpec> = {
  runs: RUNS_SPEC,
  "runs show": RUNS_SHOW_SPEC,
  "runs logs": RUNS_LOGS_SPEC,
  "runs artifacts": RUNS_ARTIFACTS_SPEC,
  stats: {
    usage: "stats [--window 7d|30d|90d|all]",
    route: "GET /api/stats",
    description: "Aggregate run statistics over a time window.",
    options: { window: { type: "string" } },
    optionHelp: ["  --window <window>   7d | 30d | 90d | all (default 30d)"],
    positionals: { min: 0, max: 0 },
    run: (data, values) => ({
      response: handleStats(data, queryParams(values, { window: "window" })),
      render: renderStats,
    }),
  },
  automations: {
    usage: "automations",
    route: "GET /api/automations",
    description: "Configured automations with their schedule, next due time, and last run.",
    options: {},
    optionHelp: [],
    positionals: { min: 0, max: 0 },
    run: (data) => ({ response: handleAutomations(data), render: renderAutomations }),
  },
  prs: {
    usage: "prs [--state open|merged] [--limit N]",
    route: "GET /api/agent-prs",
    description: "Pull/merge requests created by the agent: open ones, or recently merged.",
    options: { state: { type: "string" }, limit: { type: "string" } },
    optionHelp: [
      "  --state <state>     open | merged (default open)",
      "  --limit N           Merged PRs to return, 1..500 (default 50)",
    ],
    positionals: { min: 0, max: 0 },
    run: (data, values) => ({
      response: handleAgentPrs(data, queryParams(values, { state: "state", limit: "limit" })),
      render: values.state === "merged" ? renderMergedPrs : renderPrs,
    }),
  },
  queue: {
    usage: "queue",
    route: "GET /api/queue",
    description: "Work queued but not started: ad-hoc tasks, retries, webhooks, automations.",
    options: {},
    optionHelp: [],
    positionals: { min: 0, max: 0 },
    run: (data) => ({ response: handleQueuedWork(data), render: renderQueue }),
  },
  status: {
    usage: "status",
    route: "GET /api/worker",
    description: "Worker liveness, durable queue counts, agent PR counts, and poll cursors.",
    options: {},
    optionHelp: [],
    positionals: { min: 0, max: 0 },
    run: (data) => ({ response: handleWorkerStatus(data), render: renderStatus }),
  },
  overview: {
    usage: "overview",
    route: "GET /api/overview",
    description: "Capacity, harness chain health, and tracker poll freshness.",
    options: {},
    optionHelp: [],
    positionals: { min: 0, max: 0 },
    run: (data) => ({ response: handleOverview(data), render: renderOverview }),
  },
  logs: {
    usage: "logs [--lines N] [--level all|info|warn|error]",
    route: "GET /api/logs",
    description: "Most recent worker log entries from the worker's capture files.",
    options: { lines: { type: "string" }, level: { type: "string" } },
    optionHelp: [
      "  --lines N           Entries to return, 1..1000 (default 500)",
      "  --level <level>     all | info | warn | error (default all)",
    ],
    positionals: { min: 0, max: 0 },
    run: (data, values) => ({
      response: handleLogs(data, queryParams(values, { lines: "limit", level: "level" })),
      render: renderLogs,
    }),
  },
};

const RUNS_SUBCOMMANDS = new Set(["show", "logs", "artifacts"]);

/** Usage text for one command. */
function commandHelp(spec: CommandSpec): string {
  return [
    `Usage: devintern worker ${spec.usage} [--json] [--workspace <path>]`,
    "",
    spec.description,
    `Same data as the worker dashboard's ${spec.route}, read straight from the workspace`,
    "state database: no dashboard, running worker, or network needed. Read-only.",
    "",
    "Options:",
    ...spec.optionHelp,
    ...COMMON_OPTION_HELP,
    ...(spec === RUNS_SPEC
      ? [
          "",
          "Subcommands:",
          "  runs show <id>                    Run detail with stages and retry info",
          "  runs logs <id> [<name>]           Harness log list, or one log's tail",
          "  runs artifacts <id> [<artifact>]  Artifact list, or one artifact's content",
        ]
      : []),
    "",
  ].join("\n");
}

/** Help lines listing these commands, for `devintern worker --help`. */
export const WORKER_READ_HELP_LINES = [
  "  runs                List runs (`runs show|logs|artifacts <id>` for one run)",
  "  stats               Aggregate run statistics (--window 7d|30d|90d|all)",
  "  automations         Configured automations with next due time and last run",
  "  prs                 Open agent pull/merge requests",
  "  queue               Queued work not started yet",
  "  status              Worker liveness, queue counts, poll cursors",
  "  overview            Capacity, harness chain health, tracker freshness",
  "  logs                Recent worker log entries (--lines N, --level)",
];

/**
 * Resolve the workspace directory from `--workspace` or the default
 * (`DEVINTERN_WORKSPACE_DIR`, then `~/.devintern`).
 */
function resolveSelectedWorkspace(
  flag: string | undefined,
): { ok: true; dir: string } | { ok: false; error: string } {
  if (flag === undefined) return { ok: true, dir: resolveWorkspaceDir() };
  const configPath = resolveWorkspaceArgPath(flag);
  if (!configPath) {
    return {
      ok: false,
      error:
        `No workspace.toml at ${resolve(flag)}.\n` +
        "   Pass an existing workspace.toml or the directory that contains it.",
    };
  }
  return { ok: true, dir: dirname(configPath) };
}

/**
 * Confirm the state database exists and is readable without creating or
 * changing anything. A plain read-only open is used on purpose: unlike
 * `immutable=1` it still sees committed rows in the WAL, and SQLite falls back
 * to a private read-only wal-index when the `-shm` file cannot be written.
 */
function probeDatabase(dbPath: string): string | null {
  if (!existsSync(dbPath)) {
    return (
      `No worker database at ${dbPath}.\n` +
      "   The worker creates it on first start (`devintern worker`); pass --workspace\n" +
      "   or set DEVINTERN_WORKSPACE_DIR if the workspace lives elsewhere."
    );
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    configureSqliteConnection(db, { readonly: true });
    db.query("SELECT count(*) FROM sqlite_master").get();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // SQLite can read a WAL database from a read-only location only while its
    // `-wal`/`-shm` files exist (i.e. while the worker has it open).
    const hint = existsSync(`${dbPath}-wal`)
      ? ""
      : "\n   No -wal file exists next to it: if this directory is read-only (sandbox), SQLite\n" +
        "   cannot open the WAL database until the worker is running. Run the command\n" +
        "   outside the sandbox or start `devintern worker`.";
    return `Cannot read the worker database at ${dbPath}: ${message}${hint}`;
  } finally {
    db?.close();
  }
}

/**
 * Build the dashboard data source the worker's embedded dashboard would use:
 * history and queues both in `<workspace>/state/queue.db`, liveness and
 * transcripts from the workspace home, automations from `workspace.toml`.
 *
 * Live in-process state the worker alone holds (working-window snapshot,
 * automation occurrences in flight) is unavailable and reported empty.
 *
 * @param workspaceDir - Workspace home
 */
export function createWorkerDashboardData(workspaceDir: string): DashboardData {
  const dbPath = workspaceDbPath(workspaceDir);
  return new DashboardData({
    dbPath,
    queueDbPath: dbPath,
    workingDir: workspaceDir,
    workspaceDir,
    retryMode: "schedule",
    automationActions: loadWorkspaceAutomationActions(workspaceDir),
  });
}

/** Resolve the command spec and the remaining args (`runs show 5` → `runs show`, `[5]`). */
function selectSpec(command: WorkerReadCommand, args: string[]): { key: string; rest: string[] } {
  if (command === "runs" && args[0] !== undefined && RUNS_SUBCOMMANDS.has(args[0])) {
    return { key: `runs ${args[0]}`, rest: args.slice(1) };
  }
  return { key: command, rest: args };
}

/**
 * Run one read-only dashboard command.
 *
 * @param command - Top-level worker subcommand (`runs`, `stats`, ...)
 * @param args - Remaining arguments
 * @param io - Output sinks
 * @returns Process exit code (0 success, 1 error)
 */
export function runWorkerReadCommand(
  command: WorkerReadCommand,
  args: string[],
  io: WorkerReadIo = PROCESS_IO,
): number {
  const { key, rest } = selectSpec(command, args);
  const spec = SPECS[key];
  if (!spec) {
    io.stderr(`❌ Unknown command: devintern worker ${key}\n`);
    return 1;
  }
  let values: ParsedValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...COMMON_OPTIONS, ...spec.options },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as ParsedValues;
    positionals = parsed.positionals;
  } catch (error) {
    io.stderr(`❌ ${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr(`   Run \`devintern worker ${key} --help\` for usage.\n`);
    return 1;
  }
  if (values.help) {
    io.stdout(commandHelp(spec));
    return 0;
  }
  if (positionals.length < spec.positionals.min || positionals.length > spec.positionals.max) {
    io.stderr(`❌ Usage: devintern worker ${spec.usage}\n`);
    return 1;
  }

  const workspace = resolveSelectedWorkspace(values.workspace as string | undefined);
  if (!workspace.ok) {
    io.stderr(`❌ ${workspace.error}\n`);
    return 1;
  }
  const dbError = probeDatabase(workspaceDbPath(workspace.dir));
  if (dbError) {
    io.stderr(`❌ ${dbError}\n`);
    return 1;
  }

  const data = createWorkerDashboardData(workspace.dir);
  try {
    const { response, render } = spec.run(data, values, positionals);
    if (response.status < 200 || response.status >= 300) {
      io.stderr(`❌ ${errorMessage(response)}\n`);
      return 1;
    }
    if (values.json) {
      io.stdout(`${JSON.stringify(response.body)}\n`);
    } else {
      io.stdout(`${(render as (body: unknown) => string)(response.body)}\n`);
    }
    return 0;
  } finally {
    data.close();
  }
}

function errorMessage(response: ApiResponse): string {
  const body = response.body as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `request failed (${response.status})`;
}

// ---------------------------------------------------------------------------
// Human-readable renderers. Compact by design; `--json` is the stable contract.
// ---------------------------------------------------------------------------

function formatTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return "-";
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatPercent(fraction: number | null): string {
  return fraction === null ? "-" : `${Math.round(fraction * 100)}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Left-aligned table; the last column is not padded. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column])))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function runSubject(run: RunRecord): string {
  return run.taskKey ?? run.automationId ?? (run.prNumber ? `PR #${run.prNumber}` : "-");
}

function runDuration(run: RunRecord): string {
  return run.finishedAt === undefined ? "running" : formatDuration(run.finishedAt - run.startedAt);
}

function renderRuns(body: { runs: RunRecord[]; total: number }): string {
  if (body.runs.length === 0) return `No runs (total ${body.total}).`;
  const rows = body.runs.map((run) => [
    String(run.id),
    run.status,
    run.origin,
    runSubject(run),
    run.repo ?? "-",
    formatTime(run.startedAt),
    runDuration(run),
    run.prUrl ?? run.outcomeReason ?? "",
  ]);
  return [
    table(
      ["ID", "STATUS", "ORIGIN", "SUBJECT", "REPO", "STARTED", "DURATION", "PR / OUTCOME"],
      rows,
    ),
    "",
    `Showing ${body.runs.length} of ${body.total} run(s).`,
  ].join("\n");
}

/** Stage detail is stored as a JSON string; pretty-print it when it parses. */
function formatStageDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderRunDetail(body: {
  run: RunRecord;
  stages: RunStageRecord[];
  retry: RunRetryInfo;
  harnessLogs: RunHarnessLogFile[];
  artifacts: TaskArtifactFile[];
}): string {
  const { run } = body;
  const fields: [string, string | number | undefined][] = [
    ["Status", run.status],
    ["Origin", run.origin],
    ["Task", run.taskKey],
    ["Automation", run.automationId],
    ["Attempt", run.attempt],
    ["Repo", run.repo],
    ["Team", run.team],
    ["Harness", run.harness],
    ["Branch", run.branch],
    ["PR", run.prUrl],
    ["Ticket", run.ticketUrl],
    ["Started", formatTime(run.startedAt)],
    ["Finished", run.finishedAt === undefined ? undefined : formatTime(run.finishedAt)],
    ["Duration", runDuration(run)],
    ["Step", run.step ? `${run.step}${run.stepActive ? " (active)" : ""}` : undefined],
    ["Outcome", run.outcomeReason],
  ];
  const lines = [`Run ${run.id}`];
  for (const [label, value] of fields) {
    if (value !== undefined && value !== "") lines.push(`  ${`${label}:`.padEnd(12)}${value}`);
  }
  lines.push("", `Stages (${body.stages.length}):`);
  for (const stage of body.stages) {
    lines.push(
      `  ${formatTime(stage.createdAt)}  ${stage.stage} [${stage.status}]${stage.summary ? ` ${stage.summary}` : ""}`,
    );
    if (stage.detail) lines.push(indent(formatStageDetail(stage.detail), "      "));
  }
  const retry = body.retry;
  lines.push(
    "",
    `Retry: ${retry.eligible ? `eligible (${retry.kind ?? "task"})` : `not eligible${retry.reason ? ` (${retry.reason})` : ""}`}`,
  );
  for (const entry of retry.audit) {
    lines.push(
      `  ${formatTime(entry.createdAt)}  ${entry.action} by ${entry.actor}${entry.message ? `: ${entry.message}` : ""}`,
    );
  }
  lines.push("", `Harness logs (${body.harnessLogs.length}):`);
  for (const log of body.harnessLogs) lines.push(`  ${harnessLogLine(log)}`);
  lines.push("", `Artifacts (${body.artifacts.length}):`);
  for (const artifact of body.artifacts) lines.push(`  ${artifactLine(artifact)}`);
  return lines.join("\n");
}

function harnessLogLine(log: RunHarnessLogFile): string {
  const attempt = log.attempt === undefined ? "" : ` attempt ${log.attempt}`;
  return `${log.name}  ${formatBytes(log.size)}  ${formatTime(log.modifiedAt)}${attempt}`;
}

function artifactLine(artifact: TaskArtifactFile): string {
  return `${artifact.id}  ${artifact.name}  ${formatBytes(artifact.size)}  ${artifact.step}${artifact.available ? "" : "  (unavailable)"}`;
}

function renderHarnessLogs(body: { harnessLogs: RunHarnessLogFile[] }): string {
  if (body.harnessLogs.length === 0) return "No harness logs for this run.";
  return body.harnessLogs.map(harnessLogLine).join("\n");
}

function renderHarnessLog(body: HarnessLogContent): string {
  const note = body.truncated ? `(tail of ${formatBytes(body.totalBytes)})\n` : "";
  return `${note}${body.content}`;
}

function renderArtifacts(body: { artifacts: TaskArtifactFile[] }): string {
  if (body.artifacts.length === 0) return "No artifacts for this run.";
  return body.artifacts.map(artifactLine).join("\n");
}

function renderArtifact(body: TaskArtifactContent): string {
  if (body.content === null)
    return `${body.name}: binary content (${formatBytes(body.totalBytes)})`;
  const note = body.truncated ? `(first part of ${formatBytes(body.totalBytes)})\n` : "";
  return `${note}${body.content}`;
}

function renderStats(body: { window: string; stats: RunStats | null }): string {
  const { stats } = body;
  if (!stats) return `No run statistics (window ${body.window}).`;
  const byStatus = Object.entries(stats.totals.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(", ");
  const byOrigin = Object.entries(stats.byOrigin)
    .filter(([, count]) => count > 0)
    .map(([origin, count]) => `${origin} ${count}`)
    .join(", ");
  const lines = [
    `Window:           ${body.window}`,
    `Runs:             ${stats.totals.runs}${byStatus ? ` (${byStatus})` : ""}`,
    `Success rate:     ${formatPercent(stats.successRate)}`,
    `Escalation rate:  ${formatPercent(stats.escalationRate)}`,
    `Median duration:  ${formatDuration(stats.medianDurationMs)} (succeeded runs with a PR)`,
  ];
  if (byOrigin) lines.push(`By origin:        ${byOrigin}`);
  if (stats.byHarness.length > 0) {
    lines.push(
      "",
      table(
        ["HARNESS", "RUNS", "SUCCEEDED", "FAILED", "ESCALATED", "MEDIAN"],
        stats.byHarness.map((row) => [
          row.harness,
          String(row.runs),
          String(row.succeeded),
          String(row.failed),
          String(row.escalated),
          formatDuration(row.medianDurationMs),
        ]),
      ),
    );
  }
  return lines.join("\n");
}

function renderAutomations(body: { automations: DashboardAutomationView[] }): string {
  if (body.automations.length === 0) return "No automations configured.";
  return table(
    ["ID", "KIND", "ENABLED", "SCHEDULE", "REPO", "NEXT DUE", "LAST RUN"],
    body.automations.map((automation) => [
      automation.id,
      automation.kind,
      automation.enabled ? "yes" : "no",
      automation.schedule ?? "-",
      automation.repo ?? "-",
      formatTime(automation.nextDueAt),
      automation.lastRun
        ? `#${automation.lastRun.id} ${automation.lastRun.status} ${formatTime(automation.lastRun.startedAt)}`
        : "-",
    ]),
  );
}

function renderPrs(body: { prs: AgentPrView[] }): string {
  if (body.prs.length === 0) return "No open agent PRs.";
  return table(
    ["REPO", "PR", "TASK", "UPDATED", "URL"],
    body.prs.map((pr) => [
      pr.repo,
      `#${pr.prNumber}`,
      pr.taskKey ?? "-",
      formatTime(pr.updatedAt),
      pr.prUrl,
    ]),
  );
}

function renderMergedPrs(body: { prs: AgentPrView[] }): string {
  if (body.prs.length === 0) return "No merged agent PRs recorded.";
  return table(
    ["REPO", "PR", "TASK", "MERGED", "URL"],
    body.prs.map((pr) => [
      pr.repo,
      `#${pr.prNumber}`,
      pr.taskKey ?? "-",
      pr.mergedAt !== undefined ? formatTime(pr.mergedAt) : "-",
      pr.prUrl,
    ]),
  );
}

function renderQueue(body: QueuedWorkResponse): string {
  if (body.items.length === 0) return "Nothing queued.";
  return [
    table(
      ["KIND", "SUBJECT", "REPO", "QUEUED", "TITLE"],
      body.items.map((item) => [
        item.kind,
        item.taskKey ?? item.automationId ?? (item.prNumber ? `PR #${item.prNumber}` : "-"),
        item.repo ?? "-",
        formatTime(item.createdAt),
        item.title,
      ]),
    ),
    "",
    `${body.items.length} shown, ${body.total} queued in total.`,
  ].join("\n");
}

function workerLine(worker: WorkerStatusView): string {
  const pid = worker.pid === undefined ? "" : ` (pid ${worker.pid})`;
  const since = worker.startedAt ? ` since ${worker.startedAt}` : "";
  return `${worker.status}${pid}${since}`;
}

function renderStatus(body: {
  worker: WorkerStatusView;
  queue: WorkerQueueStats;
  agentPrs: { open: number; closed: number };
  cursors: { source: string; cursorValue: string; updatedAt: number }[];
  dbPath: string;
  dbMissing: boolean;
}): string {
  const { queue } = body;
  const lines = [
    `Worker:     ${workerLine(body.worker)}`,
    `Database:   ${body.dbPath}${body.dbMissing ? " (missing)" : ""}`,
    `Webhooks:   ${queue.pending} pending, ${queue.processing} processing, ${queue.failed} failed`,
    `Ad-hoc:     ${queue.injected.pending} pending, ${queue.injected.running} running`,
    `Retries:    ${queue.retries.pending} pending, ${queue.retries.running} running`,
    `Agent PRs:  ${body.agentPrs.open} open, ${body.agentPrs.closed} closed`,
  ];
  if (body.cursors.length > 0) {
    lines.push("", "Poll cursors:");
    for (const cursor of body.cursors) {
      lines.push(`  ${cursor.source}  updated ${formatTime(cursor.updatedAt)}`);
    }
  }
  return lines.join("\n");
}

function renderOverview(body: OverviewResponse): string {
  const lines = [
    `Worker:   ${workerLine(body.worker)}`,
    `Config:   ${body.config.path} (${body.config.status}${body.config.error ? `: ${body.config.error}` : ""})`,
  ];
  // Nested sections vary by workspace; print them as JSON rather than guess a layout.
  for (const [label, value] of [
    ["Capacity", body.capacity],
    ["Harnesses", body.harnesses],
    ["Trackers", body.trackers],
  ] as const) {
    lines.push("", `${label}:`, indent(JSON.stringify(value, null, 2), "  "));
  }
  return lines.join("\n");
}

function renderLogs(
  body: Omit<WorkerLogsResult, "entries"> & { entries: EnrichedLogEntry[] },
): string {
  if (!body.available) {
    return `No worker log files found (looked in: ${body.sources.map((source) => source.path).join(", ") || "-"}).`;
  }
  const lines = body.entries.map((entry) => {
    const run = entry.runId === undefined ? "" : ` [run ${entry.runId}]`;
    return `${formatTime(entry.timestamp)}  ${entry.level.padEnd(5)} ${entry.message}${run}`;
  });
  if (body.truncated) lines.unshift("(older entries omitted)");
  return lines.join("\n");
}
