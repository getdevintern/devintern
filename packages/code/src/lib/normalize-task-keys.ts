/**
 * Normalize CLI task-key arguments for the active tracker.
 *
 * Linear / GitHub / Azure DevOps / Asana accept both bare ids and full URLs;
 * Trello always rewrites the argument (short link, URL, or 24-char id).
 */

import { parseTrelloCardReference } from "@devintern/task-trackers";
import { parseAsanaTaskReference } from "./trackers/asana/asana-task-tracker-client";
import { parseAzureDevOpsWorkItemReference } from "./trackers/azure-devops/azure-devops-task-tracker-client";
import { parseGitHubIssueReference } from "./trackers/github/github-task-tracker-client";
import { parseLinearIssueReference } from "./trackers/linear/linear-task-tracker-client";

/**
 * Rewrite each CLI task argument into the tracker-native id used for fetch.
 *
 * @param keys - Raw positional arguments (markdown paths should already be filtered out).
 * @param trackerType - Active `TASK_TRACKER` value (case-insensitive).
 * @returns Keys in the same order, with Linear identifiers uppercased and URLs unwrapped.
 */
export function normalizeTaskKeys(keys: string[], trackerType: string): string[] {
  const tracker = trackerType.toLowerCase();
  if (tracker === "trello") {
    return keys.map(parseTrelloCardReference);
  }
  if (tracker === "linear") {
    return keys.map((key) => parseLinearIssueReference(key) ?? key);
  }
  if (tracker === "github") {
    return keys.map((key) => parseGitHubIssueReference(key) ?? key);
  }
  if (tracker === "azure-devops") {
    return keys.map((key) => parseAzureDevOpsWorkItemReference(key) ?? key);
  }
  if (tracker === "asana") {
    return keys.map((key) => parseAsanaTaskReference(key) ?? key);
  }
  return keys;
}
