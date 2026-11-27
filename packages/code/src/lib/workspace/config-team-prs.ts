/** Per-repo team-PR opt-ins from `[[repos]]` tables in `workspace.toml`. */

import { readOptionalBoolean } from "./config-readers";
import type { RepoConfig } from "./config-types";

/**
 * `sync_team_prs` / `auto_merge_team_prs`. Team-PR discovery uses GitHub's
 * open-PR list and author_association; there is no GitLab/Bitbucket
 * equivalent wired, so reject instead of silently doing nothing.
 */
export function readTeamPrFlags(
  table: Record<string, unknown>,
  label: string,
  name: string,
  hasGitHubSlug: boolean,
  errors: string[],
): Pick<RepoConfig, "syncTeamPrs" | "autoMergeTeamPrs"> {
  const flags: Pick<RepoConfig, "syncTeamPrs" | "autoMergeTeamPrs"> = {};
  for (const [key, field] of [
    ["sync_team_prs", "syncTeamPrs"],
    ["auto_merge_team_prs", "autoMergeTeamPrs"],
  ] as const) {
    const value = readOptionalBoolean(table, key, label, errors);
    if (value === undefined) continue;
    flags[field] = value;
    if (value && !hasGitHubSlug) {
      errors.push(
        `${label}.${key} is GitHub-only; "${name}" does not use a github.com remote ` +
          "(or an inline GITHUB_REPO).",
      );
    }
  }
  return flags;
}
