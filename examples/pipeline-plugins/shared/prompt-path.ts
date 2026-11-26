/**
 * Resolve a plugin's `promptFile` option to the absolute path to read.
 *
 * - An absolute path is used as written.
 * - A relative path resolves against `context.pipelineDir`, the directory of
 *   the workspace pipeline file that declared the step, so a pipeline and its
 *   `./prompts/` directory travel together across repositories and machines.
 * - When `pipelineDir` is `null` (built-in default pipeline, or an older
 *   DevIntern that does not set it) a relative path resolves against
 *   `context.workingDir`, the task checkout.
 *
 * There is deliberately no fallback from `pipelineDir` to `workingDir` when the
 * file is missing: callers report the returned absolute path instead.
 */

import { isAbsolute, resolve } from "node:path";

import type { PipelineContext } from "@getdevintern/code/pipeline";

export function resolvePromptPath(
  promptFile: string,
  context: Pick<PipelineContext, "workingDir"> & { pipelineDir?: string | null },
): string {
  if (isAbsolute(promptFile)) return promptFile;
  return resolve(context.pipelineDir ?? context.workingDir, promptFile);
}
