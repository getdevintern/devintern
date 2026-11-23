/**
 * Read worker state through the built CLI's read commands (`worker queue`,
 * `worker runs`), never the queue database, so tests observe what an operator
 * or delegating agent sees.
 */

import type { WorkerAddResult, WorkerFixture } from "./worker";

/** One pending item from `worker queue --json` (the fields tests assert on). */
export interface CliQueuedItem {
  id: string;
  kind: string;
  taskKey?: string;
  dependsOn?: string[];
  dependencyMode?: "merged" | "stacked";
  dependencyState?: "waiting" | "blocked";
  dependencyReason?: string;
}

/** One recently cancelled ad-hoc task from `worker queue --json`. */
export interface CliCancelledItem {
  taskKey: string;
  cancelledAt?: number;
  cancelledBy?: string;
  cancelReason?: string;
}

/** `worker queue --json` body. */
export interface CliQueue {
  items: CliQueuedItem[];
  total: number;
  cancelled: CliCancelledItem[];
}

/** One run from `worker runs --json` / `worker runs show <id> --json`. */
export interface CliRun {
  id: number;
  taskKey?: string;
  status: string;
  attempt?: number;
  startedAt: number;
  finishedAt?: number;
}

/** Parse the single JSON line a `--json` command prints on stdout. */
export function singleJson<T = Record<string, unknown>>(result: WorkerAddResult): T {
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(
      `Expected one JSON line (exit ${result.exitCode}), got ${lines.length}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(lines[0]!) as T;
}

async function readJson<T>(worker: WorkerFixture, args: string[]): Promise<T> {
  const result = await worker.runCli(args);
  if (result.exitCode !== 0) {
    throw new Error(`devintern ${args.join(" ")} exited ${result.exitCode}:\n${result.stderr}`);
  }
  return singleJson<T>(result);
}

/** `worker queue --json`. */
export function cliQueue(worker: WorkerFixture): Promise<CliQueue> {
  return readJson<CliQueue>(worker, ["worker", "queue", "--json"]);
}

/** `worker runs --task-key <key> --json`, oldest first. */
export async function cliRuns(worker: WorkerFixture, taskKey: string): Promise<CliRun[]> {
  const body = await readJson<{ runs: CliRun[] }>(worker, [
    "worker",
    "runs",
    "--task-key",
    taskKey,
    "--json",
  ]);
  return [...body.runs].sort((a, b) => a.id - b.id);
}

/** `worker runs show <id> --json`. */
export async function cliRun(worker: WorkerFixture, id: number): Promise<CliRun> {
  return (await readJson<{ run: CliRun }>(worker, ["worker", "runs", "show", String(id), "--json"]))
    .run;
}

/** Poll an async probe until it returns a value; fails with the worker log tail. */
export async function pollCli<T>(
  worker: WorkerFixture,
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\n${worker.tail()}`);
    }
    await Bun.sleep(intervalMs);
  }
}

/** Wait until the task's latest run has finished and return every run. */
export function waitForSettledRun(
  worker: WorkerFixture,
  taskKey: string,
  attempts = 1,
  timeoutMs = 90_000,
): Promise<CliRun[]> {
  return pollCli(
    worker,
    `${taskKey} run #${attempts} to settle`,
    async () => {
      const runs = await cliRuns(worker, taskKey);
      const latest = runs.at(-1);
      if (runs.length < attempts || !latest || latest.finishedAt === undefined) return undefined;
      return runs;
    },
    timeoutMs,
  );
}

/**
 * Run a read-only `devintern worker <args...> --json` command and parse its
 * body without typing it, for byte-level parity checks against the matching
 * dashboard route. Typed readers below wrap this for field assertions.
 */
export function cliReadJson(
  worker: WorkerFixture,
  args: string[],
  env?: Record<string, string>,
): Promise<unknown> {
  return worker.runCli(["worker", ...args, "--json"], { env }).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(
        `devintern worker ${args.join(" ")} --json exited ${result.exitCode}:\n${result.stderr}`,
      );
    }
    return singleJson<unknown>(result);
  });
}

/** Worker liveness as `worker status`/`worker overview` report it. */
export interface CliWorkerLiveness {
  status: string;
  pid?: number;
  startedAt?: string;
  lockFile?: string;
}

/** `worker status --json` (`GET /api/worker`), the fields tests assert on. */
export interface CliStatus {
  worker: CliWorkerLiveness;
  queue: {
    pending: number;
    processing: number;
    failed: number;
    injected: { pending: number; running: number };
    retries: { pending: number; running: number };
  };
  agentPrs: { open: number; closed: number };
  dbPath: string;
  dbMissing: boolean;
}

/** `worker overview --json` (`GET /api/overview`). */
export interface CliOverview {
  generatedAt: number;
  worker: CliWorkerLiveness;
  config: { status: string; path: string; error?: string };
  capacity: { running: number; maxConcurrency: number };
}

/** `worker stats --json` (`GET /api/stats`). */
export interface CliStats {
  window: string;
  stats: {
    totals: { runs: number; byStatus: Record<string, number> };
    byOrigin: Record<string, number>;
  } | null;
}

/** One automation from `worker automations --json` (`GET /api/automations`). */
export interface CliAutomation {
  id: string;
  kind: string;
  enabled: boolean;
  schedule?: string;
  nextDueAt?: number;
}

/** `worker prs --json` (`GET /api/agent-prs`). */
export interface CliPrs {
  prs: Array<{ repo: string; prNumber: number; prUrl: string; taskKey?: string }>;
}

/** `worker logs --json` (`GET /api/logs`). */
export interface CliLogs {
  available: boolean;
  entries: Array<{ index: number; timestamp: number; level: string; message: string }>;
}

/** `worker runs show <id> --json` (`GET /api/runs/:id`). */
export interface CliRunDetail {
  run: CliRun;
  stages: Array<{ stage: string; status: string }>;
  retry: { eligible: boolean; reason?: string };
  harnessLogs: Array<{ name: string; runId?: number }>;
  artifacts: Array<{ id: string; name: string }>;
}

/** `worker runs --json` (`GET /api/runs`), unfiltered. */
export function cliRunList(worker: WorkerFixture): Promise<{ runs: CliRun[]; total: number }> {
  return readJson(worker, ["worker", "runs", "--json"]);
}

/** `worker runs show <id> --json` with stages, retry info, logs, and artifacts. */
export function cliRunDetail(worker: WorkerFixture, id: number): Promise<CliRunDetail> {
  return readJson(worker, ["worker", "runs", "show", String(id), "--json"]);
}

/** `worker status --json`. */
export function cliStatus(worker: WorkerFixture): Promise<CliStatus> {
  return readJson(worker, ["worker", "status", "--json"]);
}

/** `worker overview --json`. */
export function cliOverview(worker: WorkerFixture): Promise<CliOverview> {
  return readJson(worker, ["worker", "overview", "--json"]);
}

/** `worker stats --window <window> --json`. */
export function cliStats(worker: WorkerFixture, window: string): Promise<CliStats> {
  return readJson(worker, ["worker", "stats", "--window", window, "--json"]);
}

/** `worker automations --json`. */
export async function cliAutomations(worker: WorkerFixture): Promise<CliAutomation[]> {
  return (
    await readJson<{ automations: CliAutomation[] }>(worker, ["worker", "automations", "--json"])
  ).automations;
}

/** `worker prs [--state <state>] --json`. */
export function cliPrs(worker: WorkerFixture, state?: "open" | "merged"): Promise<CliPrs> {
  return readJson(worker, ["worker", "prs", ...(state ? ["--state", state] : []), "--json"]);
}

/** `worker logs --lines <n> --level <level> --json`. */
export function cliLogs(
  worker: WorkerFixture,
  lines: number,
  level: "all" | "info" | "warn" | "error" = "all",
): Promise<CliLogs> {
  return readJson(worker, ["worker", "logs", "--lines", String(lines), "--level", level, "--json"]);
}
