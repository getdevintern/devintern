import type { RunOrigin } from "@/lib/api";

export const RUN_ORIGIN_LABELS = {
  task: "Tracker task",
  error_monitor: "Error monitor",
  pr_mention: "PR mention",
  ci_fix: "CI fix",
  conflict_resolution: "Conflict resolution",
  scheduled: "Scheduled automation",
  estimate: "Estimate run",
  manual: "Manual run",
} satisfies Record<RunOrigin, string>;

export function formatRunOrigin(origin: RunOrigin): string {
  return RUN_ORIGIN_LABELS[origin];
}

/** Label an origin string that may come from an untrusted source (log filename). */
export function formatRunOriginLabel(origin: string): string {
  return (RUN_ORIGIN_LABELS as Record<string, string | undefined>)[origin] ?? origin;
}
