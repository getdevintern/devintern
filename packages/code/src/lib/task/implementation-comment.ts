import type { TaskTrackerClient } from "../trackers/client";

/**
 * Post a successful implementation summary comment to the task tracker.
 *
 * @param tracker - Task tracker client
 * @param taskKey - Task tracker issue key
 * @param agentOutput - Agent stdout
 * @param taskSummary - Optional issue summary line
 */
export async function postImplementationComment(
  tracker: TaskTrackerClient,
  taskKey: string,
  agentOutput: string,
  taskSummary?: string,
): Promise<void> {
  try {
    await tracker.postImplementationComment(taskKey, agentOutput, taskSummary);
    console.log(`✅ Implementation summary posted to ${taskKey}`);
  } catch (error) {
    throw new Error(`Failed to post implementation comment: ${error}`);
  }
}
