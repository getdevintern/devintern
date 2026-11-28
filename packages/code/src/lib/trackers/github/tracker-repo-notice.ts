/**
 * The GitHub Issues tracker repository (`GITHUB_REPO`) and the repositories
 * the worker opens pull requests in are configured separately. Tickets kept
 * in one repository and code in another is a legitimate setup, but so is a
 * typo in `GITHUB_REPO`; this names the split so the user can tell which.
 */

/**
 * One info line when the tracker repository is none of the worker's
 * repositories, e.g. "Tickets come from acme/issues, PRs go to acme/app".
 *
 * @param trackerRepo - `GITHUB_REPO` (`owner/name`)
 * @param prRepos - `owner/name` of each worker repository on GitHub
 * @returns null when the tracker repository is one of them, or either side is unknown
 */
export function trackerRepoNotice(
  trackerRepo: string | undefined,
  prRepos: readonly (string | null | undefined)[],
): string | null {
  const tracker = trackerRepo?.trim();
  if (!tracker) return null;
  const targets = [...new Set(prRepos.filter((slug): slug is string => Boolean(slug)))];
  if (targets.length === 0) return null;
  const same = (slug: string) => slug.toLowerCase() === tracker.toLowerCase();
  if (targets.some(same)) return null;
  return `Tickets come from ${tracker}, PRs go to ${targets.join(", ")}`;
}
