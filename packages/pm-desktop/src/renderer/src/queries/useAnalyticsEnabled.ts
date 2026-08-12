import { useQuery } from "@tanstack/react-query";

import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Whether anonymous usage analytics are enabled (default on). Pass `enabled`
 * to gate fetching on dialog open.
 */
export function useAnalyticsEnabled(enabled: boolean) {
  return useQuery({
    queryKey: qk.analyticsEnabled,
    queryFn: async () => unwrap(await window.pm.getAnalyticsEnabled()),
    enabled,
    staleTime: Infinity,
  });
}
