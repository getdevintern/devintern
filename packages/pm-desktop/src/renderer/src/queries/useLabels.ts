import { useQuery } from "@tanstack/react-query";

import type { LabelListResult } from "../../../shared/ipc-contract.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Tracker labels for a project dir + project key. Keys are scoped by `dir`
 * so switching project dirs uses distinct cache entries (no cross-dir
 * contamination). The default-key cache is seeded from `ProjectStatus` by
 * `seedProjectStatusCaches`; other keys fetch on demand. The query throws
 * on IPC failure so callers can inspect `error` for the failure message.
 * Use {@link invalidateLabels} for the Retry affordance.
 */
export function useLabels(dir: string | null, projectKey: string | null, enabled: boolean) {
  return useQuery<LabelListResult>({
    queryKey: qk.labels(dir ?? "", projectKey ?? ""),
    queryFn: async () => unwrap(await window.pm.listLabels(projectKey ?? undefined)),
    enabled: enabled && dir !== null && projectKey !== null,
    staleTime: Infinity,
    // Keep failed label fetches in cache so switching tickets doesn't loop
    // a refetch on every activation — the Retry button invalidates instead.
    retry: false,
  });
}
