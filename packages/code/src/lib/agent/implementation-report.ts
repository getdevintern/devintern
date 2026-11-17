import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Cap the persisted agent report so a huge transcript cannot bloat the DB. */
export const IMPLEMENTATION_REPORT_EXCERPT_LENGTH = 10_000;

/**
 * Slack applied when comparing a summary file's mtime with the attempt start.
 *
 * `Date.now()` can run a fraction of a millisecond ahead of the kernel
 * timestamp stored on a file the run just wrote, so an exact `>=` comparison
 * occasionally treats this attempt's own summary as stale (visible on fast
 * runs, where the agent finishes in the same millisecond it started). A stale
 * summary always comes from a previous attempt, so a few milliseconds absorb
 * clock and filesystem timestamp granularity without letting an attempt that
 * finished moments before this one masquerade as its own.
 */
const SUMMARY_MTIME_TOLERANCE_MS = 5;

/** Implementation summary files the agent may have written for this run. */
export interface ImplementationReport {
  /** True when the agent handed the task back as incomplete. */
  incomplete: boolean;
  /** Agent-written report excerpt, when a fresh file exists. */
  report?: string;
}

/** Mtime of a summary file, or undefined when it is absent or unreadable. */
function summaryMtime(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  } catch {
    // Treat an unreadable stat as "not this run's file".
    return undefined;
  }
}

/**
 * Whether a summary file was written at or after the attempt start.
 *
 * @param mtimeMs - File modification time, or undefined when absent
 * @param sinceMs - Epoch ms when this implementation attempt started
 * @returns True when the file belongs to the current attempt.
 */
function writtenThisAttempt(mtimeMs: number | undefined, sinceMs: number): boolean {
  return mtimeMs !== undefined && mtimeMs >= sinceMs - SUMMARY_MTIME_TOLERANCE_MS;
}

/**
 * Read the implementation report the agent wrote for the current attempt.
 *
 * The summary directory is shared across attempts, so only files modified at or
 * after `sinceMs` belong to this run; a stale summary from an earlier attempt is
 * ignored. When both a success and an incomplete summary are fresh, the newer
 * file wins: a halt written after the agent's report escalates the run, while a
 * stale incomplete file from a prior attempt cannot override a fresh success.
 * Reads are best-effort: a missing or unreadable file means "no report", never a
 * failed task.
 *
 * @param taskDir - Per-task output directory holding the summary files
 * @param sinceMs - Epoch ms when this implementation attempt started
 */
export function readImplementationReport(taskDir: string, sinceMs: number): ImplementationReport {
  const successPath = join(taskDir, "implementation-summary.md");
  const incompletePath = join(taskDir, "implementation-summary-incomplete.md");
  const successMtime = summaryMtime(successPath);
  const incompleteMtime = summaryMtime(incompletePath);
  const successFresh = writtenThisAttempt(successMtime, sinceMs);
  const incompleteFresh = writtenThisAttempt(incompleteMtime, sinceMs);

  const incomplete =
    incompleteFresh && (!successFresh || (incompleteMtime ?? 0) >= (successMtime ?? 0));
  const reportPath = incomplete ? incompletePath : successFresh ? successPath : undefined;
  if (reportPath === undefined) return { incomplete: false };

  try {
    return {
      incomplete,
      report: readFileSync(reportPath, "utf8").slice(0, IMPLEMENTATION_REPORT_EXCERPT_LENGTH),
    };
  } catch {
    /* best-effort: recording must never fail a run */
    return { incomplete };
  }
}
