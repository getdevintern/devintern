import { useQuery } from "@tanstack/react-query";

import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Eligible recent project directories (most recent first). A failed fetch
 * resolves to `[]` (not an error) so the Welcome empty state still renders.
 * Callers invalidate {@link qk.recentProjects} after connect/remove/setup
 * flows that change the eligible list.
 */
export function useRecentProjects() {
  return useQuery({
    queryKey: qk.recentProjects,
    queryFn: async () => {
      try {
        return unwrap(await window.pm.getRecentProjectDirs());
      } catch {
        return [];
      }
    },
  });
}
