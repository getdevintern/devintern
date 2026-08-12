import type { QueryClient } from "@tanstack/react-query";

import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import { resolveIssueTypes } from "../lib/issue-types.ts";
import { qk } from "./keys.ts";

/**
 * Seed the issue-type and label query caches from a freshly loaded
 * {@link ProjectStatus}. The status payload embeds `issueTypes` and `labels`
 * for the default project key, so we write them directly into the query
 * cache to avoid an extra IPC round-trip for the default key. Other project
 * keys are fetched on demand by the `useIssueTypes` / `useLabels` hooks.
 *
 * Call this from `applyProjectStatus` (and any path that receives a fresh
 * `ProjectStatus` from a mutation) before the hooks mount or refetch.
 */
export function seedProjectStatusCaches(queryClient: QueryClient, status: ProjectStatus): void {
  const dir = status.projectDir;
  const projectKey = status.defaultProjectKey;
  if (!projectKey) return;

  if (status.supportsIssueTypes) {
    queryClient.setQueryData(qk.issueTypes(dir, projectKey), resolveIssueTypes(status.issueTypes));
  }
  if (status.supportsLabels) {
    queryClient.setQueryData(qk.labels(dir, projectKey), {
      labels: status.labels ?? [],
      truncated: status.labelsTruncated ?? false,
    });
  }
}
