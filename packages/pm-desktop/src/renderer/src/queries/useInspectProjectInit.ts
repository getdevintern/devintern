import { useQuery } from "@tanstack/react-query";

import type { ProjectInitInspect } from "../../../shared/ipc-contract.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Tracker menu + existing-config snapshot for the setup wizard. Fetched when
 * the wizard opens; `staleTime: 0` ensures a fresh inspect each open (the
 * project state on disk may have changed since the last visit).
 */
export function useInspectProjectInit(dir: string, enabled: boolean) {
  return useQuery<ProjectInitInspect>({
    queryKey: qk.projectInit(dir),
    queryFn: async () => unwrap(await window.pm.inspectProjectInit(dir)),
    enabled,
    staleTime: 0,
  });
}
