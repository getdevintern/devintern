import { useQuery } from "@tanstack/react-query";

import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/** Whether the OAuth "Sign in with GitHub" path is available (Client ID set). */
export function useGitHubOAuthAvailable(enabled: boolean) {
  return useQuery({
    queryKey: qk.githubOAuthAvailable,
    queryFn: async () => unwrap(await window.pm.isGitHubOAuthAvailable()),
    enabled,
    staleTime: Infinity,
  });
}
