/**
 * Map renderer CreateTaskRequest → engine CreateTaskOptions.
 *
 * Intentionally omits any trusted-caller flags (e.g. labelsPrevalidated) so a
 * compromised or buggy renderer cannot skip allowlist validation on Jira/GitHub
 * apply paths that auto-create labels.
 */

import type { CreateTaskOptions } from "@getdevintern/pm/engine";
import type { CreateTaskRequest } from "../shared/ipc-contract.ts";

/** Strip renderer input down to the public engine create-task options. */
export function toEngineCreateTaskOptions(input: CreateTaskRequest): CreateTaskOptions {
  return {
    issueType: input.issueType,
    projectKey: input.projectKey,
    epicKey: input.epicKey,
    labels: input.labels,
    attachments: input.attachments,
  };
}
