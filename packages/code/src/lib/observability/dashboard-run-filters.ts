/**
 * Allowed values for the `status` and `origin` filters of `GET /api/runs`.
 */

import type { RunOrigin, RunStatus } from "../state/run-recorder";

export const RUN_STATUSES: RunStatus[] = [
  "in_progress",
  "succeeded",
  "failed",
  "deferred",
  "escalated",
  "abandoned",
];
export const RUN_ORIGINS: RunOrigin[] = [
  "task",
  "error_monitor",
  "pr_mention",
  "ci_fix",
  "conflict_resolution",
  "auto_merge",
  "scheduled",
  "estimate",
  "manual",
  "local",
];
