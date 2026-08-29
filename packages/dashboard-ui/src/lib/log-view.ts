/**
 * Client-side helpers for the Logs view: search matching and severity counts
 * over the entries already served by `/api/logs` (the server bounds the
 * window; filtering here never refetches). Pure, for unit testing.
 */

import type { LogEntry, WorkerLogLevel } from "@/lib/api";

/** Case-insensitive substring match over the rendered line; empty query matches all. */
export function matchesQuery(entry: Pick<LogEntry, "message">, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return entry.message.toLowerCase().includes(query);
}

export interface SeverityCounts {
  error: number;
  warn: number;
}

/** Errors/warnings in a window of entries — triage summary for the header. */
export function severityCounts(entries: Pick<LogEntry, "level">[]): SeverityCounts {
  return entries.reduce<SeverityCounts>(
    (counts, entry) => {
      if (entry.level === "error") {
        counts.error += 1;
      } else if (entry.level === "warn") {
        counts.warn += 1;
      }
      return counts;
    },
    { error: 0, warn: 0 },
  );
}

/** Tailwind classes for the severity marker next to each line. */
export function levelDotClass(level: WorkerLogLevel): string {
  switch (level) {
    case "error":
      return "bg-destructive";
    case "warn":
      return "bg-chart-5";
    default:
      return "bg-muted-foreground/40";
  }
}
