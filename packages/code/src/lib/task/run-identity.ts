/**
 * Run identity derived from a task subprocess's environment.
 *
 * The worker composes per-repo/team env (see `workspace/env.ts`) and the
 * pipeline records the run's origin, tracker, team, and repo from it. Startup
 * recovery looks runs up by that same scope, so the mapping lives here where
 * both sides can be tested together instead of being duplicated in the
 * pipeline and the recovery scan.
 */

import { RUN_ORIGIN_ENV } from "../observability/analytics";
import type { RunOrigin } from "../state/run-recorder";
import { WORKSPACE_REPO_ENV, WORKSPACE_TEAM_ENV } from "../workspace/env";

/** Fields a task subprocess contributes to its run record's scope. */
export interface RunIdentity {
  origin: RunOrigin;
  tracker: string;
  team?: string;
  repo?: string;
  automationId?: string;
}

/**
 * Resolve the run identity recorded for a task subprocess.
 *
 * Automation markers win over the task origin; without them an explicit
 * `error_monitor`/`local` origin maps to its own tracker (`sentry`/`local`)
 * rather than the ambient `TASK_TRACKER`.
 */
export function resolveRunIdentity(env: NodeJS.ProcessEnv = process.env): RunIdentity {
  const scheduledAutomationId = env.DEVINTERN_AUTOMATION_ID;
  const trackerName = env.TASK_TRACKER || "jira";
  const runOrigin = env[RUN_ORIGIN_ENV];
  const isErrorMonitorRun = runOrigin === "error_monitor";
  const isLocalInjectedRun = runOrigin === "local";
  const origin: RunOrigin = scheduledAutomationId
    ? runOrigin === "manual"
      ? "manual"
      : "scheduled"
    : isErrorMonitorRun
      ? "error_monitor"
      : isLocalInjectedRun
        ? "local"
        : "task";

  return {
    origin,
    // Tracker attribution follows the origin marker even when an automation
    // id wins the `origin` field, matching the pipeline's historical mapping.
    tracker: isErrorMonitorRun ? "sentry" : isLocalInjectedRun ? "local" : trackerName,
    team: env[WORKSPACE_TEAM_ENV],
    repo: env[WORKSPACE_REPO_ENV],
    ...(scheduledAutomationId ? { automationId: scheduledAutomationId } : {}),
  };
}
