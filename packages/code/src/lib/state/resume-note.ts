/**
 * Durable resume note.
 *
 * Stopping the worker mid-run (SIGTERM/drain) used to leave the run row
 * `in_progress` with no marker distinguishing an operator-requested stop from
 * a crash: the next start would reap it as an orphan and post a duplicate
 * "exited unexpectedly" failure comment.
 *
 * A resume note is a small, write-only-ahead artifact derived from the run
 * record at shutdown time. It records which runs were in flight when the
 * worker stopped cleanly, so the next start can (a) skip the crash feedback
 * the interrupted child already delivered via its own SIGTERM handler and
 * (b) carry the recorded branch/report into session pickup.
 *
 * Nothing irreversible happens during shutdown: the note is a separate,
 * idempotent JSON file written atomically (temp file + rename). The run rows
 * themselves are never mutated on the signal path.
 *
 * Every read is best-effort: an unreadable or malformed note degrades to
 * "no clean-stop information", which falls back to the existing crash
 * recovery.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";

import type { RunOrigin, RunRecord } from "./run-recorder";

/** Bump when the on-disk shape changes incompatibly. */
export const RESUME_NOTE_VERSION = 1;

/** One in-flight run captured at a clean stop. */
export interface ResumeNoteEntry {
  runId: number;
  origin: RunOrigin;
  taskKey?: string;
  branch?: string;
  attempt?: number;
  repo?: string;
  team?: string;
  harness?: string;
  startedAt: number;
}

/** A durable note of the runs in flight when the worker stopped cleanly. */
export interface ResumeNote {
  version: number;
  createdAt: number;
  /** Signal that triggered the stop (e.g. `SIGTERM`), when known. */
  signal?: string;
  runs: ResumeNoteEntry[];
}

export interface BuildResumeNoteOptions {
  /** Signal that triggered the stop, recorded for diagnostics. */
  signal?: string;
  /** Present-tense "now", overridable in tests. */
  now?: number;
}

/**
 * Derive a resume note from run records. Callers pass the runs that were
 * `in_progress` at shutdown; the mapper is tolerant of stale terminal rows so
 * a race with a late child write never produces a bogus entry.
 *
 * @param runs - Run records captured at shutdown
 * @param options - Optional signal and clock override
 */
export function buildResumeNote(
  runs: readonly RunRecord[],
  options: BuildResumeNoteOptions = {},
): ResumeNote {
  const entries: ResumeNoteEntry[] = [];
  for (const run of runs) {
    if (run.status !== "in_progress") continue;
    const entry: ResumeNoteEntry = {
      runId: run.id,
      origin: run.origin,
      startedAt: run.startedAt,
    };
    if (run.taskKey) entry.taskKey = run.taskKey;
    if (run.branch) entry.branch = run.branch;
    if (run.attempt !== undefined) entry.attempt = run.attempt;
    if (run.repo) entry.repo = run.repo;
    if (run.team) entry.team = run.team;
    if (run.harness) entry.harness = run.harness;
    entries.push(entry);
  }
  return {
    version: RESUME_NOTE_VERSION,
    createdAt: options.now ?? Date.now(),
    ...(options.signal ? { signal: options.signal } : {}),
    runs: entries,
  };
}

/**
 * Persist a resume note atomically (temp file + rename) so a crash mid-write
 * can never leave a truncated note. Never throws; returns false on failure so
 * the caller can warn without aborting shutdown.
 *
 * @param path - Destination path
 * @param note - Note to persist
 */
export function writeResumeNote(path: string, note: ResumeNote): boolean {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(note, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup of the partial temp file.
    }
    return false;
  }
}

/** Parse and validate an unknown value into a {@link ResumeNote}. */
function parseResumeNote(raw: unknown): ResumeNote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== RESUME_NOTE_VERSION) return null;
  if (typeof candidate.createdAt !== "number") return null;
  if (!Array.isArray(candidate.runs)) return null;

  const runs: ResumeNoteEntry[] = [];
  for (const item of candidate.runs) {
    if (typeof item !== "object" || item === null) continue;
    const run = item as Record<string, unknown>;
    if (typeof run.runId !== "number" || !Number.isSafeInteger(run.runId)) continue;
    if (typeof run.origin !== "string") continue;
    if (typeof run.startedAt !== "number") continue;
    const entry: ResumeNoteEntry = {
      runId: run.runId,
      origin: run.origin as RunOrigin,
      startedAt: run.startedAt,
    };
    if (typeof run.taskKey === "string") entry.taskKey = run.taskKey;
    if (typeof run.branch === "string") entry.branch = run.branch;
    if (typeof run.attempt === "number") entry.attempt = run.attempt;
    if (typeof run.repo === "string") entry.repo = run.repo;
    if (typeof run.team === "string") entry.team = run.team;
    if (typeof run.harness === "string") entry.harness = run.harness;
    runs.push(entry);
  }

  const note: ResumeNote = {
    version: RESUME_NOTE_VERSION,
    createdAt: candidate.createdAt,
    runs,
  };
  if (typeof candidate.signal === "string") note.signal = candidate.signal;
  return note;
}

/**
 * Read a resume note, or null when it is missing, unreadable, or written by an
 * incompatible version. Never throws.
 *
 * @param path - Note path
 */
export function readResumeNote(path: string): ResumeNote | null {
  if (!existsSync(path)) return null;
  try {
    return parseResumeNote(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/**
 * Read a resume note and delete it in one step. The file is removed even when
 * its contents are malformed so a broken note cannot be re-processed forever.
 * Never throws.
 *
 * @param path - Note path
 */
export function consumeResumeNote(path: string): ResumeNote | null {
  const note = readResumeNote(path);
  try {
    rmSync(path, { force: true });
  } catch {
    // A note we could not delete is retried on the next start.
  }
  return note;
}

/** Run ids named by a note, for callers that only need the set membership. */
export function resumeNoteRunIds(note: ResumeNote | null): Set<number> {
  const ids = new Set<number>();
  if (!note) return ids;
  for (const run of note.runs) ids.add(run.runId);
  return ids;
}
