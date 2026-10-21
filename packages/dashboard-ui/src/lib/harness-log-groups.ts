/**
 * Group harness logs by the run attempt that produced them.
 *
 * A run-detail page lists transcripts for the whole ticket, not just the
 * current run (retries reuse the task key). When more than one attempt is
 * present, rendering an ambiguous flat list makes the same `clarity` /
 * `implementation` labels look duplicated, so callers show a group header per
 * attempt instead. Logs are always ordered oldest first.
 */

import type { HarnessLogFile } from "@/lib/api";

/** One attempt's transcripts, ordered oldest first. */
export interface HarnessLogGroup {
  /** Stable React key (`run:<id>` or `unattributed`). */
  key: string;
  /** Short header label, for example `Attempt 2` or `Unattributed logs`. */
  label: string;
  runId?: number;
  attempt?: number;
  logs: HarnessLogFile[];
}

export interface HarnessLogGrouping {
  /** True when the logs span more than one run (or include unattributed logs). */
  grouped: boolean;
  /** Chronological (earliest first). */
  groups: HarnessLogGroup[];
}

/** Sort key for a log; fall back to mtime for old entries without a timestamp. */
function timeOf(file: HarnessLogFile): number {
  return file.startedAt ?? file.modifiedAt;
}

/**
 * Sort logs oldest first and bucket them by producing run.
 *
 * @param logs - Harness logs from the run-detail response (any order)
 */
export function groupHarnessLogs(logs: HarnessLogFile[]): HarnessLogGrouping {
  const sorted = [...logs].sort((a, b) => timeOf(a) - timeOf(b) || a.name.localeCompare(b.name));
  const byRun = new Map<string, HarnessLogGroup>();

  for (const file of sorted) {
    const key = file.runId !== undefined ? `run:${file.runId}` : "unattributed";
    let group = byRun.get(key);
    if (!group) {
      group = {
        key,
        label: groupLabel(file),
        runId: file.runId,
        attempt: file.attempt,
        logs: [],
      };
      byRun.set(key, group);
    }
    group.logs.push(file);
  }

  const groups = [...byRun.values()].sort((a, b) => groupTime(a) - groupTime(b));
  return { grouped: groups.length > 1, groups };
}

/** Earliest log time in a group (every group has at least one log). */
function groupTime(group: HarnessLogGroup): number {
  const first = group.logs[0];
  return first ? timeOf(first) : 0;
}

/** Header label for the first log of a group. */
function groupLabel(file: HarnessLogFile): string {
  if (file.runId === undefined) {
    return "Unattributed logs";
  }
  return file.attempt !== undefined ? `Attempt ${file.attempt}` : "Run";
}
