import type { QueryClient } from "@tanstack/react-query";

import { qk, TRACKER_KEY_PREFIX } from "./keys.ts";

/**
 * Invalidate queries that depend on project context after a mutation
 * changes it (tracker switch, project-key switch, harness switch, setup
 * complete, tracker-settings complete, git update, project connect/remove).
 *
 * `["tracker"]` busts both issue types and labels across all dirs/keys in a
 * single call. Recent projects are also refreshed since connect/remove and
 * setup flows change the eligible list.
 */
export async function invalidateProjectQueries(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: TRACKER_KEY_PREFIX });
  await queryClient.invalidateQueries({ queryKey: qk.recentProjects });
}

/**
 * Invalidate the label cache for a single project dir + key. Used by the
 * label "Retry" affordance, which only re-fetches the currently active key.
 */
export function invalidateLabels(queryClient: QueryClient, dir: string, projectKey: string): void {
  queryClient.invalidateQueries({ queryKey: qk.labels(dir, projectKey) });
}
