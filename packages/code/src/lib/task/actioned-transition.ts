/**
 * Post-PR actioned transition.
 *
 * After a ticket's PR is created the worker moves it to the project's
 * configured `prStatus` (when one is set) and always records a local actioned
 * marker. The marker is what keeps the ticket out of the next sweep even when
 * no `prStatus` is configured — and even when the transition fails (missing
 * label, permissions, transient API error). Failures are never allowed to fail
 * the run that just created a PR.
 */

import type { Task } from "../../types/task-tracker";
import { isWorkerTaskProcess } from "../cli/context";
import {
  getPrStatusForProject,
  loadProjectSettings,
  resolveProjectKey,
} from "../config/project-settings";
import { WorkerState } from "../state/worker-state";
import type { TaskTrackerClient } from "../trackers/client";
import { isMarkdownTaskTracker } from "../trackers/markdown/markdown-task-tracker-client";
import { actionedSourceKeyFromEnv, recordTaskActioned } from "./actioned-state";

export interface ActionedTransitionInput {
  tracker: TaskTrackerClient;
  task: Task;
  taskKey: string;
  /** When true, no tracker write happens; the local marker is still recorded. */
  skipComments: boolean;
  projectSettings?: ReturnType<typeof loadProjectSettings>;
  /** Injected for tests; a default store is opened and closed otherwise. */
  workerState?: WorkerState;
}

/**
 * Apply the configured actioned status and record the ticket as actioned.
 *
 * Markdown tasks are left to the pipeline (`markDoneIfSuccessful` changes the
 * file) so the recorded signal reflects the final file contents.
 */
export async function applyActionedTransition(input: ActionedTransitionInput): Promise<void> {
  const { tracker, task, taskKey, skipComments } = input;
  if (isMarkdownTaskTracker(tracker)) return;

  const projectSettings = input.projectSettings ?? loadProjectSettings();
  const projectKey = resolveProjectKey(taskKey, task);
  const prStatus = getPrStatusForProject(projectKey, projectSettings)?.trim();

  if (skipComments) {
    console.log(
      "\n⏭️  --skip-comments: recording the ticket as actioned locally (no tracker transition)",
    );
  } else if (prStatus) {
    try {
      console.log(`\n🔄 Transitioning ${taskKey} to '${prStatus}' after PR creation...`);
      await tracker.transitionStatus(taskKey, prStatus);
    } catch (statusError) {
      // Missing label/permissions/transient API error: the PR is already
      // created, so degrade to the local marker instead of failing the run.
      console.warn(
        `⚠️  Failed to transition ${taskKey} to '${prStatus}': ${(statusError as Error).message}`,
      );
      console.log("   PR was created; recording the ticket as actioned locally instead.");
    }
  } else if (isWorkerTaskProcess()) {
    // Interactive PR runs have no sweep to loop on; keep the warning for the
    // worker, where a missing actioned status is the duplicate-PR hazard.
    console.warn(
      `⚠️  No prStatus configured for ${projectKey}; recording ${taskKey} as actioned locally so it ` +
        "is not re-implemented. Add a prStatus in .devintern-code/settings.json (or exclude " +
        "actioned tickets in the sweep query) to also move it out of the tracker.",
    );
  }

  const workerState = input.workerState ?? new WorkerState();
  const ownsState = input.workerState === undefined;
  try {
    const marked = await recordTaskActioned({
      workerState,
      source: actionedSourceKeyFromEnv(),
      tracker,
      taskKey,
      fallbackTask: task,
    });
    if (marked) {
      console.log(`✅ Recorded ${taskKey} as actioned`);
    }
  } finally {
    if (ownsState) workerState.close();
  }
}
