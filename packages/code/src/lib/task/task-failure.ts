/**
 * Failure handling for a single task attempt, split out of `pipeline.ts`.
 */

import { UsageLimitError } from "@devintern/agent-harness";
import { captureError, flushErrorTracking } from "@devintern/utils";
import { adoptAgentCreatedChangeRequest } from "../agent/adopt-change-request";
import {
  AGENT_START_STAGE,
  agentStartMaxAttempts,
  agentStartReason,
} from "../agent/agent-start-failure";
import { HarnessUnavailableError } from "../agent/harness-startup";
import { flushAnalyticsAndExit } from "../cli/bootstrap";
import { isWorkerTaskProcess, runContext } from "../cli/context";
import {
  getActiveTrackerType,
  getTodoStatusForProject,
  loadProjectSettings,
} from "../config/project-settings";
import { readAgentStartFailureStreak } from "../observability/agent-start-health";
import { flushAnalytics, trackInteractiveTaskRun } from "../observability/analytics";
import { failureFromError, formatFailureCause } from "../state/run-outcome";
import { currentRunStep, getActiveRunContext } from "../state/run-recorder";
import { finishTaskRun } from "../state/task-run";
import { resolveQueueDbPath } from "../state/webhook-queue";
import {
  HARNESS_UNAVAILABLE_EXIT_CODE,
  USAGE_LIMIT_EXIT_CODE,
  isWorkerChild,
  writeUsageLimitHint,
} from "../worker/usage-limit-protocol";
import { reportDevInternDefect } from "./defect-report";
import { finishUnfinishedRun } from "./preserve-work";
import { reportProcessingFailure } from "./processing-failure";

/** Identifies the task attempt for failure handling. */
export interface TaskAttempt {
  taskKey: string;
  taskIndex: number;
  totalTasks: number;
}

/**
 * Handle a failed task attempt. Usage limits defer without failing the task;
 * other errors record tracker feedback and either rethrow (batch) or exit.
 */
export async function handleTaskFailure(error: unknown, attempt: TaskAttempt): Promise<never> {
  const { taskKey, taskIndex, totalTasks } = attempt;
  const options = runContext.options;

  if (error instanceof UsageLimitError) {
    await finishTaskRun("deferred", error.message);
    if (isWorkerChild()) {
      console.warn(`\n⏳ ${error.message}. Signaling worker to fail over.`);
      if (runContext.activeTaskContext?.movedToInProgress) {
        try {
          const todoStatus = getTodoStatusForProject(
            runContext.activeTaskContext.projectKey,
            loadProjectSettings(),
          );
          if (todoStatus?.trim()) {
            await runContext.activeTaskContext.tracker.transitionStatus(taskKey, todoStatus.trim());
          }
        } catch {
          /* best-effort */
        }
      }
      if (runContext.lockManager) {
        runContext.lockManager.release();
      }
      writeUsageLimitHint(error);
      await flushAnalyticsAndExit(USAGE_LIMIT_EXIT_CODE);
    }
    console.warn(`\n⏳ ${error.message}. Stopping; will retry on the next scheduled run.`);
    try {
      await reportProcessingFailure(taskKey, `${error.message} (usage limit)`);
    } catch {
      /* best-effort */
    }
    if (totalTasks > 1) {
      throw error;
    }
    if (runContext.lockManager) {
      runContext.lockManager.release();
    }
    await flushAnalyticsAndExit(0);
  }

  // A harness that could not start is a configuration problem, not a task
  // attempt. In a worker child, signal the parent to fail over/defer without
  // posting a failure comment, recording retry state, or transitioning the
  // ticket. Interactive runs keep the normal failure path below.
  if (error instanceof HarnessUnavailableError && isWorkerChild()) {
    // Bound the loop: an agent CLI that exits at once (bad API key, missing
    // login) would otherwise be deferred and retried forever. After the
    // budget the run settles `failed` (environment), which raises a
    // notification and keeps the ticket out of the sweep until it changes.
    const activeRun = getActiveRunContext();
    const attempt =
      (activeRun?.taskKey
        ? readAgentStartFailureStreak(resolveQueueDbPath(), activeRun.taskKey, activeRun.id)
        : 0) + 1;
    const maxAttempts = agentStartMaxAttempts();
    if (attempt >= maxAttempts) {
      await finishTaskRun("failed", agentStartReason(error.message), {
        failure: {
          outcomeClass: "environment",
          stage: AGENT_START_STAGE,
          cause: formatFailureCause(error.message),
        },
      });
      console.error(
        `\n❌ ${error.message}. The agent CLI failed to start ${attempt} time(s) in a row; ` +
          "giving up on this task until it is retried. See `devintern worker status`.",
      );
      if (runContext.lockManager) {
        runContext.lockManager.release();
      }
      await flushAnalyticsAndExit(1);
    }
    await finishTaskRun("deferred", agentStartReason(error.message));
    console.warn(
      `\n🛠️  ${error.message}. Start attempt ${attempt}/${maxAttempts}; ` +
        "signaling worker to try the next harness or retry later.",
    );
    if (runContext.lockManager) {
      runContext.lockManager.release();
    }
    await flushAnalyticsAndExit(HARNESS_UNAVAILABLE_EXIT_CODE);
  }

  const err = error as Error;
  // Captured before the run ends so a defect report can be attached to it.
  const failedRunId = getActiveRunContext()?.id;
  const failedStep = currentRunStep();
  // An exception reaching here is a DevIntern step failing (or the
  // environment), unless the step that halted already classified it.
  await finishUnfinishedRun("failed", err.message, failureFromError(err, failedStep));

  // A failed run may still have pushed a branch and opened a PR itself (agents
  // sometimes run `gh pr create`). Register and label it so review polling and
  // PR metadata stay correct; the run remains failed.
  await adoptAgentCreatedChangeRequest({ taskKey });

  const taskPrefix = totalTasks > 1 ? `[${taskIndex + 1}/${totalTasks}] ` : "";
  console.error(`${taskPrefix}❌ Error processing ${taskKey}: ${err.message}`);
  if (options.verbose && err.stack) {
    console.error(err.stack);
  }
  captureError(error, {
    taskKey,
    tracker: process.env.TASK_TRACKER || "jira",
    stage: "process-task",
  });

  try {
    await reportProcessingFailure(taskKey, err.message);
  } catch {
    /* best-effort */
  }
  // Opt-in (DEVINTERN_AUTO_REPORT): report confirmed DevIntern defects.
  // Never throws, and runs after the failure is recorded and fed back.
  await reportDevInternDefect({
    error,
    taskKey,
    ...(failedRunId !== undefined ? { runId: failedRunId } : {}),
    ...(failedStep ? { failedStep } : {}),
  });
  runContext.activeTaskContext = null;

  if (totalTasks > 1) {
    throw error;
  }
  if (!isWorkerTaskProcess()) {
    await trackInteractiveTaskRun({
      tracker: getActiveTrackerType(),
      outcome: "failed",
      taskCount: 1,
      runMode: options.query ? "query" : "tasks",
    });
    await flushAnalytics();
  }
  await flushErrorTracking();
  process.exit(1);
}
