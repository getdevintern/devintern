/** Confirm or drop a worker-provided stack base once the run's PR target is known. */

import type { StackBase } from "../dependencies/gate";
import { STACKED_ON_ENV } from "../dependencies/stacked-base";
import { recordTrackerStackedOn } from "../state/tracker-dependencies";
import { resolveQueueDbPath } from "../state/webhook-queue";
import { WORKSPACE_TEAM_ENV } from "../workspace/env";

/**
 * Record a worker-stacked tracker ticket's base for its dependents, once the
 * run really targets it. Nothing is recorded when the stack was dropped: an
 * explicit `Target branch:` removed the env marker in {@link prepareTask}, or
 * the base branch is missing on the remote and the target fell back to the
 * default branch. Best-effort: a storage failure only logs.
 *
 * @returns Whether the base was recorded
 */
export function recordConfirmedStackBase(
  taskKey: string,
  stackBase: StackBase | undefined,
  effectiveTargetBranch: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!stackBase || effectiveTargetBranch !== stackBase.branch) return false;
  try {
    recordTrackerStackedOn(
      env.WEBHOOK_QUEUE_DB || resolveQueueDbPath(),
      taskKey,
      env[WORKSPACE_TEAM_ENV] || undefined,
      stackBase.taskKey,
    );
    return true;
  } catch (error) {
    console.warn(`⚠️  Could not record ${taskKey}'s stack base: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Drop a worker-provided stack base the run will not use because the target
 * fell back to the default branch (the base branch is missing on the remote).
 * Removes the env marker so the PR body does not claim the stack, and the
 * prompt section so the agent is not told to build on a branch it never got.
 *
 * @returns Whether the stack was dropped
 */
export function dropUnusedStackBase(
  stackBase: StackBase | undefined,
  effectiveTargetBranch: string,
  taskDetails: { stackedOnSection?: string },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!stackBase || effectiveTargetBranch === stackBase.branch) return false;
  delete env[STACKED_ON_ENV];
  delete taskDetails.stackedOnSection;
  console.warn(
    `⚠️  Not stacking on ${stackBase.taskKey} PR #${stackBase.prNumber}: ` +
      `base branch '${stackBase.branch}' is unavailable, targeting '${effectiveTargetBranch}' instead`,
  );
  return true;
}
