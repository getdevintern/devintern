import { useQuery } from "@tanstack/react-query";

import { resolveIssueTypes } from "../lib/issue-types.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Tracker issue types for a project dir + project key. Keys are scoped by
 * `dir` so switching project dirs uses distinct cache entries (no
 * cross-dir contamination). The default-key cache is seeded from
 * `ProjectStatus` by `seedProjectStatusCaches`; other keys fetch on demand.
 */
export function useIssueTypes(dir: string | null, projectKey: string | null, enabled: boolean) {
  return useQuery<string[]>({
    queryKey: qk.issueTypes(dir ?? "", projectKey ?? ""),
    queryFn: async () =>
      resolveIssueTypes(unwrap(await window.pm.listIssueTypes(projectKey ?? undefined))),
    enabled: enabled && dir !== null && projectKey !== null,
    staleTime: Infinity,
  });
}
