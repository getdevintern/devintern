import { useQuery } from "@tanstack/react-query";

import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Whether the user dismissed the Code discovery tip. `data` is `undefined`
 * while loading (treated as "do not show" by callers) and `boolean` once
 * resolved. Dismissal is persisted across sessions by the main process.
 */
export function useCodeDiscoveryDismissed() {
  return useQuery({
    queryKey: qk.codeDiscoveryDismissed,
    queryFn: async () => unwrap(await window.pm.isCodeDiscoveryDismissed()),
  });
}
