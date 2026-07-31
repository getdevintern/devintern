import { join } from "path";

/**
 * Base directory for per-task output artifacts (task details, feasibility
 * assessments, summaries, attachments). Overridable via DEVINTERN_OUTPUT_DIR.
 *
 * Everything under this directory is a write-only artifact; retry bookkeeping
 * lives in `.devintern-code/queue.db` (see lib/retry-state.ts).
 */
export function resolveOutputDir(): string {
  return process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
}

/**
 * Output directory for one task's artifacts.
 *
 * @param taskKey - Task key (lowercased for the directory name)
 */
export function taskOutputDir(taskKey: string): string {
  return join(resolveOutputDir(), taskKey.toLowerCase());
}
