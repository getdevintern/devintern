import { useQuery } from "@tanstack/react-query";

import type { UpdateStatus } from "../../../shared/auto-update.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Current auto-update snapshot. A single subscription in the app root pushes
 * live updates into this cache via `queryClient.setQueryData(qk.updateStatus)`,
 * so `AboutDialog` and `UpdateNotifier` both read the same entry without each
 * subscribing separately.
 */
export function useUpdateStatus() {
  return useQuery<UpdateStatus>({
    queryKey: qk.updateStatus,
    queryFn: async () => unwrap(await window.pm.getUpdateStatus()),
    staleTime: Infinity,
  });
}
