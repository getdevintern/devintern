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
