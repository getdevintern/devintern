/**
 * Read every CI signal on one commit: Checks API check runs and legacy
 * commit statuses, all pages. Each result says whether it is complete, so a
 * truncated list is never mistaken for "no failures".
 */

import type { GitHubReviewsClient } from "./reviews";
import type { CheckRun, CombinedStatus } from "./reviews-types";

/** Pages read before giving up (100 entries each). */
const MAX_PAGES = 10;

type Getter = Pick<GitHubReviewsClient, "conditionalGet">;

/** GET one page; the response is never a 304 without an ETag. */
async function getPage<T>(client: Getter, path: string, owner: string, repo: string): Promise<T> {
  const { data } = await client.conditionalGet<T>(path, owner, repo);
  if (data === null) throw new Error(`GitHub returned no data for ${path}`);
  return data;
}

/** Every check run on `ref` (latest per check name). */
export async function listCheckRunsForRef(
  client: Getter,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ checkRuns: CheckRun[]; complete: boolean }> {
  const checkRuns: CheckRun[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await getPage<{ total_count: number; check_runs: CheckRun[] }>(
      client,
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?filter=latest&per_page=100&page=${page}`,
      owner,
      repo,
    );
    total = batch.total_count;
    checkRuns.push(...batch.check_runs);
    if (batch.check_runs.length < 100 || checkRuns.length >= total) break;
  }
  return { checkRuns, complete: checkRuns.length >= total };
}

/** The latest legacy commit status per context on `ref`. */
export async function listLatestCommitStatuses(
  client: Getter,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ statuses: CombinedStatus["statuses"]; complete: boolean }> {
  const statuses: CombinedStatus["statuses"] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await getPage<CombinedStatus>(
      client,
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status?per_page=100&page=${page}`,
      owner,
      repo,
    );
    total = batch.total_count;
    statuses.push(...batch.statuses);
    if (batch.statuses.length < 100 || statuses.length >= total) break;
  }
  return { statuses, complete: statuses.length >= total };
}
