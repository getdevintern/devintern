/**
 * Shared cleanup primitives for scenarios.
 *
 * Cleanup must attempt every operation even when one fails, and every failure
 * must name the resource it belongs to so a leftover remote object can be
 * found and removed by hand.
 */

/** One failed cleanup operation, tagged with the resource id it targeted. */
export interface CleanupFailure {
  resource: string;
  error: unknown;
}

/** Code-host operations cleanup needs; implemented by the GitHub provider. */
export interface GitHubCleanupClient {
  pulls(head: string): Promise<Array<{ number: number; state: string }>>;
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  deleteBranch(branch: string): Promise<void>;
}

/**
 * Close open pull requests and delete branches owned by the scenario.
 *
 * `base` is deleted too (the scenario seeded it); only refs in
 * `ownedBranches` are ever touched, and no prefix sweep is performed.
 *
 * @returns Failures tagged with their branch/PR resource id.
 */
export async function collectGitHubCleanupFailures(
  github: GitHubCleanupClient,
  ownedBranches: Iterable<string>,
  base: string,
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const head of [...ownedBranches].filter((branch) => branch !== base)) {
    try {
      const pulls = await github.pulls(head);
      for (const pull of pulls.filter((item) => item.state === "open")) {
        try {
          await github.request(`/pulls/${pull.number}`, "PATCH", { state: "closed" });
        } catch (error) {
          failures.push({ resource: `pull:${head}`, error });
        }
      }
    } catch (error) {
      failures.push({ resource: `pull:${head}`, error });
    }
  }
  for (const branch of ownedBranches) {
    try {
      await github.deleteBranch(branch);
    } catch (error) {
      failures.push({ resource: `branch:${branch}`, error });
    }
  }
  return failures;
}

/** Render failed resource ids and throw them as one aggregate error. */
export function throwCleanupFailures(message: string, failures: CleanupFailure[]): void {
  if (failures.length === 0) return;
  const resources = failures.map((failure) => failure.resource).join(", ");
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `${message}; failed resources: ${resources}`,
  );
}
