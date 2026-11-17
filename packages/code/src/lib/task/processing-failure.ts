import { isMarkdownFilePath } from "@devintern/task-trackers";
import { runContext } from "../cli/context";
import { getTodoStatusForProject, loadProjectSettings } from "../config/project-settings";
import { RUN_ORIGIN_ENV } from "../observability/analytics";
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
 *
 * Returns `true` when the interruption feedback is handled — the comment was
 * delivered, or comments are deliberately suppressed (`--skip-comments` /
 * markdown inputs). Returns `false` when no run context exists or the comment
 * could not be posted, so a caller can tell "already reported" from "recovery
 * still needs to report it".
 */
export async function reportProcessingFailure(taskKey: string, reason: string): Promise<boolean> {
  const context = runContext.activeTaskContext;
  if (!context) return false;
  if (process.env[RUN_ORIGIN_ENV] === "local") {
    // Ad-hoc `worker add` runs use a synthetic `local-<slug>` key with no
    // tracker ticket. The durable injected row carries the failure (and
    // startup recovery settles it), while the markdown tracker cannot resolve
    // the key to record retry state — attempting it only logs a spurious
    // "Cannot resolve markdown task … without MARKDOWN_TASKS_DIR" warning.
    return true;
  }
  if (runContext.options.skipComments || isMarkdownFilePath(taskKey)) return true;

  return reportTaskFailure({
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
