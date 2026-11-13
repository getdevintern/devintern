/**
 * Diagnostic collection for bug reports.
 *
 * Everything here is best-effort: a missing database, an unreadable log, or a
 * broken git checkout must never prevent a user from describing a bug. The
 * collector reads only safe metadata and bounded tails, never task content.
 *
 * This module intentionally avoids the CLI's workspace/configuration modules
 * so `@getdevintern/code/report` stays usable in a project that installed the
 * package without the monorepo's shared workspace packages. The small read-only
 * run queries below mirror the run store's schema.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { isAutomatedEnvironment } from "../config/env-detector";
import { readWorkerLogs } from "../observability/worker-logs";
import { resolveWorkspaceDir } from "../workspace/paths";
import { resolveReportConfigDir } from "./paths";
import { detectRepoSlug, redactReportText, safeSourceLabel } from "./redact";
import type {
  ReportContext,
  ReportEnvironment,
  ReportLogAttachment,
  ReportRunStage,
  ReportRunSummary,
} from "./types";

const DEFAULT_LOG_BYTES = 64 * 1024;
const DEFAULT_LOG_LINES = 400;
const MAX_STAGE_SUMMARY = 400;
const BUILT_IN_PIPELINE = ["implement", "commit", "auto-review", "finalize"];

export interface CollectDiagnosticsOptions {
  cliVersion?: string;
  installKind?: string;
  cwd?: string;
  configDir?: string;
  signedIn?: boolean;
  /** Collect environment only when false. Default true. */
  diagnostics?: boolean;
  /** Include log tails. Default true. */
  logs?: boolean;
  logPaths?: string[];
  runId?: number;
  taskKey?: string;
  last?: boolean;
  shareIdentifiers?: boolean;
  command?: string;
}

export interface CollectedDiagnostics {
  environment: ReportEnvironment;
  context?: ReportContext;
  repoSlug: string | null;
  /** Effective task key used for redaction; never included in the payload by itself. */
  taskKey: string | null;
}

/** Read the last `maxBytes` of a file, snapping to a line boundary. */
function readTail(
  path: string,
  maxBytes = DEFAULT_LOG_BYTES,
  maxLines = DEFAULT_LOG_LINES,
): { text: string; lines: number; truncated: boolean } | null {
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    let start = Math.max(0, size - maxBytes);
    if (start > 0) {
      // Skip a partial leading line so the tail starts cleanly.
      const probe = Buffer.alloc(Math.min(8192, size - start));
      const read = readSync(fd, probe, 0, probe.length, start);
      const newline = probe.subarray(0, read).indexOf(0x0a);
      if (newline >= 0) start += newline + 1;
    }
    const buffer = Buffer.alloc(Math.max(0, size - start));
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (read <= 0) break;
      filled += read;
    }
    const allLines = buffer.subarray(0, filled).toString("utf8").split("\n");
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
    const lines = allLines.slice(Math.max(0, allLines.length - maxLines));
    return {
      text: lines.join("\n"),
      lines: lines.length,
      truncated: start > 0 || allLines.length > maxLines,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

/** Read file logs requested by the caller. */
function collectFileLogs(
  paths: string[],
  options: {
    cwd: string;
    repoSlug: string | null;
    taskKey: string | null;
    shareIdentifiers: boolean;
  },
): ReportLogAttachment[] {
  const logs: ReportLogAttachment[] = [];
  for (const path of paths) {
    const tail = readTail(path);
    if (!tail) continue;
    logs.push({
      source: safeSourceLabel(path),
      lines: tail.lines,
      text: redactReportText(tail.text, {
        cwd: options.cwd,
        homeDir: homedir(),
        repoSlug: options.repoSlug,
        taskKey: options.taskKey,
        shareIdentifiers: options.shareIdentifiers,
        maxChars: DEFAULT_LOG_BYTES,
      }),
      ...(tail.truncated ? { truncated: true } : {}),
    });
  }
  return logs;
}

/** Read the worker capture files when a workspace exists on this host. */
function collectWorkerLogs(options: {
  cwd: string;
  repoSlug: string | null;
  taskKey: string | null;
  shareIdentifiers: boolean;
}): ReportLogAttachment[] {
  try {
    const result = readWorkerLogs({
      dirs: [resolveWorkspaceDir()],
      limit: 200,
      maxBytesPerFile: DEFAULT_LOG_BYTES,
    });
    if (!result.available || result.entries.length === 0) return [];
    const byStream = new Map<"out" | "err", string[]>();
    for (const entry of result.entries) {
      const line = entry.timestamp
        ? `${new Date(entry.timestamp).toISOString()} ${entry.message}`
        : entry.message;
      const list = byStream.get(entry.stream) ?? [];
      list.push(line);
      byStream.set(entry.stream, list);
    }
    const logs: ReportLogAttachment[] = [];
    for (const [stream, lines] of byStream) {
      const text = redactReportText(lines.join("\n"), {
        cwd: options.cwd,
        homeDir: homedir(),
        repoSlug: options.repoSlug,
        taskKey: options.taskKey,
        shareIdentifiers: options.shareIdentifiers,
        maxChars: DEFAULT_LOG_BYTES,
      });
      logs.push({
        source: stream === "out" ? "worker.stdout.log" : "worker.stderr.log",
        lines: lines.length,
        text,
        ...(result.truncated ? { truncated: true } : {}),
      });
    }
    return logs;
  } catch {
    return [];
  }
}

interface RunRow {
  id: number;
  task_key: string | null;
  origin: string | null;
  status: string;
  outcome_reason: string | null;
  started_at: number;
  finished_at: number | null;
}

interface StageRow {
  stage: string;
  status: string;
  summary: string | null;
}

/** Resolve the local queue database without importing the CLI's path helpers. */
function resolveRunDbPath(cwd: string): string {
  const override = process.env.WEBHOOK_QUEUE_DB?.trim();
  if (override) return override;
  return join(resolveReportConfigDir(undefined, cwd), "queue.db");
}

/** Open the run database read-only, or return null when it does not exist. */
function openRunDb(cwd: string): Database | null {
  const path = resolveRunDbPath(cwd);
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

/** Pick the most useful failing run when the caller did not name one. */
function selectRun(db: Database, options: CollectDiagnosticsOptions): RunRow | null {
  try {
    if (options.runId !== undefined) {
      const row = db
        .query(
          `SELECT id, task_key, origin, status, outcome_reason, started_at, finished_at
             FROM runs WHERE id = ?`,
        )
        .get(options.runId) as RunRow | null;
      return row ?? null;
    }
    const params: string[] = [];
    const where = options.taskKey ? "WHERE task_key = ?" : "";
    if (options.taskKey) params.push(options.taskKey);
    const rows = db
      .query(
        `SELECT id, task_key, origin, status, outcome_reason, started_at, finished_at
           FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT 25`,
      )
      .all(...params) as RunRow[];
    if (rows.length === 0) return null;
    if (options.last) {
      return (
        rows.find((run) => run.status === "failed" || run.status === "escalated") ??
        rows.find((run) => run.status === "deferred") ??
        null
      );
    }
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Build a redacted run summary from local run records. */
function summarizeRun(
  db: Database,
  run: RunRow,
  redaction: {
    cwd: string;
    repoSlug: string | null;
    taskKey: string | null;
    shareIdentifiers: boolean;
  },
): ReportRunSummary {
  let stages: ReportRunStage[] = [];
  try {
    const rows = db
      .query(`SELECT stage, status, summary FROM run_stages WHERE run_id = ? ORDER BY id ASC`)
      .all(run.id) as StageRow[];
    stages = rows.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      ...(stage.summary
        ? {
            summary: redactReportText(stage.summary, {
              ...redaction,
              maxChars: MAX_STAGE_SUMMARY,
            }),
          }
        : {}),
    }));
  } catch {
    stages = [];
  }
  const failed = stages.find(
    (stage) =>
      stage.stage !== "outcome" && (stage.status === "failed" || stage.status === "escalated"),
  );
  return {
    id: run.id,
    ...(redaction.shareIdentifiers && run.task_key ? { taskKey: run.task_key } : {}),
    status: run.status,
    ...(run.origin ? { origin: run.origin } : {}),
    ...(failed ? { failedStep: failed.stage } : {}),
    ...(run.outcome_reason
      ? {
          reason: redactReportText(run.outcome_reason, {
            ...redaction,
            maxChars: 2000,
          }),
        }
      : {}),
    startedAt: new Date(run.started_at).toISOString(),
    ...(run.finished_at !== null
      ? { durationMs: Math.max(0, run.finished_at - run.started_at) }
      : {}),
    stages,
  };
}

/** Read a JSON object, returning null for missing or malformed files. */
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Extract step names from a pipeline definition object. */
function pipelineStepsFrom(value: Record<string, unknown> | null): string[] | null {
  if (!value || !Array.isArray(value.steps)) return null;
  const steps = value.steps
    .slice(0, 50)
    .map((step) =>
      step !== null &&
      typeof step === "object" &&
      typeof (step as { use?: unknown }).use === "string"
        ? (step as { use: string }).use.trim()
        : "",
    )
    .filter(Boolean);
  return steps.length > 0 ? steps : null;
}

/** Describe the selected pipeline without loading plugins or running checks. */
function collectPipelineInfo(cwd: string): Pick<ReportContext, "pipelineScope" | "pipelineSteps"> {
  try {
    const repoFile = process.env.DEVINTERN_WORKSPACE_PIPELINE_REPO?.trim();
    if (repoFile) {
      const steps = pipelineStepsFrom(readJsonObject(resolve(repoFile)));
      return { pipelineScope: "workspace-repo", pipelineSteps: steps ?? BUILT_IN_PIPELINE };
    }
    const settings = readJsonObject(join(cwd, ".devintern-code", "settings.json"));
    const repositoryPipeline =
      settings && settings.pipeline && typeof settings.pipeline === "object"
        ? (settings.pipeline as Record<string, unknown>)
        : null;
    if (repositoryPipeline) {
      const steps = pipelineStepsFrom(repositoryPipeline);
      return { pipelineScope: "repository", pipelineSteps: steps ?? BUILT_IN_PIPELINE };
    }
    const defaultFile = process.env.DEVINTERN_WORKSPACE_PIPELINE_DEFAULT?.trim();
    if (defaultFile) {
      const steps = pipelineStepsFrom(readJsonObject(resolve(defaultFile)));
      return { pipelineScope: "workspace-default", pipelineSteps: steps ?? BUILT_IN_PIPELINE };
    }
    return { pipelineScope: "built-in", pipelineSteps: BUILT_IN_PIPELINE };
  } catch {
    return {};
  }
}

/**
 * Collect the environment block plus optional run/log context.
 *
 * @param options - Collection preferences and identifiers to redact.
 */
export async function collectDiagnostics(
  options: CollectDiagnosticsOptions = {},
): Promise<CollectedDiagnostics> {
  const cwd = options.cwd ?? process.cwd();
  const repoSlug = detectRepoSlug(cwd);
  const shareIdentifiers = options.shareIdentifiers ?? false;
  const environment: ReportEnvironment = {
    cliVersion: options.cliVersion ?? "unknown",
    installKind: options.installKind ?? "unknown",
    runtime: {
      ...(process.versions.bun ? { bun: process.versions.bun } : {}),
      node: process.version,
      os: process.platform,
      arch: process.arch,
      ci: isAutomatedEnvironment(),
    },
    ...(() => {
      const harness = process.env.AGENT_HARNESS?.split(",")[0]?.trim();
      return harness ? { harness: { name: harness } } : {};
    })(),
    tracker: (process.env.TASK_TRACKER || "jira").toLowerCase(),
    ...(process.env.AGENT_SANDBOX ? { sandbox: process.env.AGENT_SANDBOX } : {}),
    signedIn: options.signedIn ?? false,
    telemetry: process.env.DEVINTERN_TELEMETRY_DISABLED !== "1",
  };

  if (options.diagnostics === false) {
    return { environment, repoSlug, taskKey: options.taskKey ?? null };
  }

  const db = openRunDb(cwd);
  const run = db ? selectRun(db, options) : null;
  // Redact the run's task key even when it is omitted from the payload. A
  // `--last` report has no explicit --task value, but the failure reason and
  // logs still contain the key.
  const redaction = {
    cwd,
    repoSlug,
    taskKey: options.taskKey ?? run?.task_key ?? null,
    shareIdentifiers,
  };
  const context: ReportContext = {
    ...(options.command
      ? {
          command: redactReportText(options.command, {
            ...redaction,
            maxChars: 500,
          }),
        }
      : {}),
    ...collectPipelineInfo(cwd),
  };
  try {
    if (db && run) context.run = summarizeRun(db, run, redaction);
  } finally {
    db?.close();
  }

  if (options.logs !== false) {
    const logs = [
      ...collectFileLogs(options.logPaths ?? [], redaction),
      ...collectWorkerLogs(redaction),
    ];
    if (logs.length > 0) context.logs = logs;
  }

  return {
    environment,
    ...(Object.keys(context).length > 0 ? { context } : {}),
    repoSlug,
    taskKey: redaction.taskKey,
  };
}
