import { useQuery } from "@tanstack/react-query";

import type { GitHubRepoListItem, IpcError } from "../../../shared/ipc-contract.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Repositories visible to the stored GitHub token (empty when disconnected).
 * Pass `enabled` to gate fetching on auth being connected. The query throws
 * on IPC failure so callers can inspect `error.code` for `auth_required` /
 * `forbidden` to surface a re-auth prompt. Invalidate
 * {@link qk.githubRepos} after OAuth/PAT mutations.
 */
export function useGitHubRepos(enabled: boolean) {
  return useQuery<GitHubRepoListItem[], IpcError>({
    queryKey: qk.githubRepos,
    queryFn: async () => unwrap(await window.pm.listGitHubRepos()),
    enabled,
    staleTime: Infinity,
  });
}
