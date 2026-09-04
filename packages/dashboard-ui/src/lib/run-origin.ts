import type { RunOrigin } from "@/lib/api";

export const RUN_ORIGIN_LABELS = {
  task: "Tracker task",
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
