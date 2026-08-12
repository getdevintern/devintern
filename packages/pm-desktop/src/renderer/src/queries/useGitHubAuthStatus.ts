import { useQuery } from "@tanstack/react-query";

import type { GitHubAuthStatus } from "../../../shared/ipc-contract.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Stored GitHub auth status (never includes the token). Shared by
 * `ConnectGitHubDialog` and `AnalyticsSettings`. Invalidate
 * {@link qk.githubAuthStatus} after OAuth/PAT/clear mutations.
 */
export function useGitHubAuthStatus(enabled: boolean) {
  return useQuery<GitHubAuthStatus>({
    queryKey: qk.githubAuthStatus,
    queryFn: async () => unwrap(await window.pm.getGitHubAuthStatus()),
    enabled,
    staleTime: Infinity,
  });
}
