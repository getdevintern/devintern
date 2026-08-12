import { useQuery } from "@tanstack/react-query";

import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Installed app version from Electron `app.getVersion()`. The version never
 * changes during a session, so the result is kept fresh indefinitely.
 */
export function useAppVersion() {
  return useQuery({
    queryKey: qk.appVersion,
    queryFn: async () => unwrap(await window.pm.getAppVersion()),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
