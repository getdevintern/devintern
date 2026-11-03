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
 * summary always comes from a previous attempt minutes earlier, so a one-second
 * tolerance keeps the guard meaningful while absorbing clock and filesystem
 * timestamp granularity.
 */
const SUMMARY_MTIME_TOLERANCE_MS = 1_000;

/** Implementation summary files the agent may have written for this run. */
export interface ImplementationReport {
  /** True when the agent handed the task back as incomplete. */
  incomplete: boolean;
  /** Agent-written report excerpt, when a fresh file exists. */
  report?: string;
}

/**
 * Whether a summary file was written at or after the attempt start.
 *
 * @param path - Summary file to inspect
 * @param sinceMs - Epoch ms when this implementation attempt started
 * @returns True when the file belongs to the current attempt.
 */
function writtenThisAttempt(path: string, sinceMs: number): boolean {
  try {
    return existsSync(path) && statSync(path).mtimeMs >= sinceMs - SUMMARY_MTIME_TOLERANCE_MS;
  } catch {
    // Treat an unreadable stat as "not this run's file".
    return false;
  }
}

/**
 * Read the implementation report the agent wrote for the current attempt.
 *
 * The summary directory is shared across attempts, so only files modified at or
 * after `sinceMs` belong to this run; a stale summary from an earlier attempt is
 * ignored. Reads are best-effort: a missing or unreadable file means "no
 * report", never a failed task.
 *
 * @param taskDir - Per-task output directory holding the summary files
 * @param sinceMs - Epoch ms when this implementation attempt started
 */
export function readImplementationReport(taskDir: string, sinceMs: number): ImplementationReport {
  const incompletePath = join(taskDir, "implementation-summary-incomplete.md");
  const incomplete = writtenThisAttempt(incompletePath, sinceMs);

  const reportPath = incomplete ? incompletePath : join(taskDir, "implementation-summary.md");
  try {
    if (writtenThisAttempt(reportPath, sinceMs)) {
      return {
        incomplete,
        report: readFileSync(reportPath, "utf8").slice(0, IMPLEMENTATION_REPORT_EXCERPT_LENGTH),
      };
    }
  } catch {
    /* best-effort: recording must never fail a run */
  }
  return { incomplete };
}
