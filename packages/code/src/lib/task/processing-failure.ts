import { isMarkdownFilePath } from "@devintern/task-trackers";
import { runContext } from "../cli/context";
import { getTodoStatusForProject, loadProjectSettings } from "../config/project-settings";
import { reportTaskFailure } from "./failure-feedback";

/**
 * Best-effort failure feedback: post a comment explaining why no pull request
 * was created and move the ticket back to its To Do status so the next
 * scheduled run can retry. Never throws — feedback must not mask the
 * original error.
 *
 * After posting, the attempt is recorded for the retry gate so posting the
 * comment (which bumps the ticket's `updated` stamp) does not itself cause
 * an immediate re-pickup loop.
 */
export async function reportProcessingFailure(taskKey: string, reason: string): Promise<void> {
  const context = runContext.activeTaskContext;
  if (!context || runContext.options.skipComments || isMarkdownFilePath(taskKey)) return;

  await reportTaskFailure({
    taskKey,
    reason,
    tracker: context.tracker,
    trackerType: process.env.TASK_TRACKER || "jira",
    projectKey: context.projectKey,
    movedToInProgress: context.movedToInProgress,
    getTodoStatus: () => getTodoStatusForProject(context.projectKey, loadProjectSettings()),
    log: console.log,
    warn: console.warn,
  });
}
