/**
 * The worker's lifecycle record (`<workspace>/.worker.lifecycle.json`).
 *
 * The worker lock says whether a worker is running right now. Once it is
 * gone, nothing used to say why: a clean stop and a worker that never got
 * past its license check looked the same ("unknown"). The daemon now writes
 * one small record at each transition:
 *
 * - `started`: every event source started (written from `onStarted`).
 * - `stopped`: the graceful shutdown finished (written before the lock is
 *   released, so a reader never sees neither).
 * - `startup_failed`: the process exited before it started, with the last
 *   error lines it printed and its exit code. `permanent` marks failures a
 *   restart cannot fix (no license, invalid configuration).
 *
 * Writes are best-effort: a read-only workspace must never stop the worker.
 */

import { readFileSync, renameSync, writeFileSync } from "fs";
import { workspaceWorkerLifecyclePath } from "../workspace/paths";

export type WorkerLifecycleState = "started" | "stopped" | "startup_failed";

export interface WorkerLifecycleRecord {
  state: WorkerLifecycleState;
  pid: number;
  /** ISO 8601 time of the transition. */
  at: string;
  /** Process exit code (`stopped`, `startup_failed`). */
  exitCode?: number;
  /** Why startup failed: the last error lines the worker printed. */
  message?: string;
  /** A restart alone will not fix this startup failure. */
  permanent?: boolean;
}

const STATES: readonly WorkerLifecycleState[] = ["started", "stopped", "startup_failed"];

/** Parse a lifecycle record read from disk; null when it is not one. */
export function parseWorkerLifecycleRecord(raw: unknown): WorkerLifecycleRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const state = STATES.find((candidate) => candidate === value.state);
  if (!state || typeof value.pid !== "number" || typeof value.at !== "string") return null;
  if (!Number.isFinite(Date.parse(value.at))) return null;
  return {
    state,
    pid: value.pid,
    at: value.at,
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(value.permanent === true ? { permanent: true } : {}),
  };
}

/** How the last worker process ended, as `worker status` / `/api/worker` report it. */
export interface WorkerLastExitView {
  outcome: "stopped" | "startup_failed";
  at: string;
  exitCode?: number;
  /** Startup failures: the last error lines the worker printed. */
  message?: string;
  /** Startup failures a restart alone cannot fix (license, config). */
  permanent?: boolean;
}

/** The record as a last-exit view; undefined for a `started` record. */
export function lastExitView(record: WorkerLifecycleRecord): WorkerLastExitView | undefined {
  if (record.state === "started") return undefined;
  return {
    outcome: record.state,
    at: record.at,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.message ? { message: record.message } : {}),
    ...(record.permanent ? { permanent: true } : {}),
  };
}

/**
 * Last exit for a worker whose lock is left behind by a dead pid (it died
 * without cleanup). A record written before that worker started describes an
 * older process, so it is ignored. (Without a lock at all, a `started`
 * record means the worker released its lock on the way out and has not
 * written `stopped` yet.)
 */
export function stoppedWorkerExit(
  record: WorkerLifecycleRecord | null,
  lockStartedAt: string | undefined,
): WorkerLastExitView | undefined {
  if (!record || !lockStartedAt) return undefined;
  return Date.parse(record.at) >= Date.parse(lockStartedAt) ? lastExitView(record) : undefined;
}

/**
 * One-line summary of a startup-failure message: its first two non-empty
 * lines ("❌ License check failed" + the reason), without the leading icon.
 */
export function summarizeStartupFailure(message: string | undefined): string | undefined {
  const lines = (message ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^❌\s*/, ""))
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.slice(0, 2).join(": ");
}

/** Read the record, or null when it is absent, unreadable, or malformed. */
export function readWorkerLifecycle(workspaceDir: string): WorkerLifecycleRecord | null {
  try {
    return parseWorkerLifecycleRecord(
      JSON.parse(readFileSync(workspaceWorkerLifecyclePath(workspaceDir), "utf8")),
    );
  } catch {
    return null;
  }
}

/** Replace the record atomically (temp file + rename). Never throws. */
export function writeWorkerLifecycle(
  workspaceDir: string,
  record: Omit<WorkerLifecycleRecord, "pid" | "at"> & { pid?: number; at?: string },
): void {
  const path = workspaceWorkerLifecyclePath(workspaceDir);
  const full: WorkerLifecycleRecord = {
    ...record,
    pid: record.pid ?? process.pid,
    at: record.at ?? new Date().toISOString(),
  };
  try {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(full)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Best effort: status falls back to the lock alone.
  }
}
