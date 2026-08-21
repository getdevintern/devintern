import type { RunOrigin } from "@/lib/api";

export const RUN_ORIGIN_LABELS = {
  task: "Tracker task",
  pr_mention: "PR mention",
  conflict_resolution: "Conflict resolution",
} satisfies Record<RunOrigin, string>;

export function formatRunOrigin(origin: RunOrigin): string {
  return RUN_ORIGIN_LABELS[origin];
}
