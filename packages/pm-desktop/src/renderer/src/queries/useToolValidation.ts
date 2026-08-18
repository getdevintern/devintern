import { useQuery } from "@tanstack/react-query";

import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Launch-time Git + agent-harness probe. Refetches on window focus so a tool
 * installed in another window can clear the gate without a full relaunch.
 */
export function useToolValidation() {
  return useQuery({
    queryKey: qk.toolValidation,
    queryFn: async () => unwrap(await window.pm.validateRequiredTools()),
    refetchOnWindowFocus: "always",
  });
}
