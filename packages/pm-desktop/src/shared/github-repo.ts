/**
 * Parse and normalize GitHub repository references for Connect.
 *
 * Accepts `owner/repo`, HTTPS/SSH GitHub URLs, and optional `.git` suffix.
 * Branch is never part of the slug — callers pass it separately.
 */

/** Canonical GitHub slug: `owner/repo` (owner lowercased for identity; repo as typed). */
export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Stable identity key: lowercase `owner/repo`. */
  slug: string;
}

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize pasted input to a GitHub slug, or null when it is not a GitHub repo ref.
 *
 * @param input - `owner/repo`, `https://github.com/owner/repo(.git)`, or SSH form.
 */
export function parseGitHubRepoInput(input: string): GitHubRepoRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate = trimmed;

  // Strip query/hash from URLs before path parsing.
  const withoutFragment = candidate.split("#")[0] ?? candidate;
  candidate = withoutFragment.split("?")[0] ?? withoutFragment;

  // git@github.com:owner/repo.git
  const ssh = candidate.match(/^git@github\.com:(.+)$/i);
  if (ssh?.[1]) {
    candidate = ssh[1];
  } else {
    // https://github.com/owner/repo[/tree/branch...][.git]
    const https = candidate.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)/i);
    if (https?.[1] && https[2]) {
      candidate = `${https[1]}/${https[2]}`;
    }
  }

  candidate = candidate.replace(/\.git$/i, "").replace(/\/+$/, "");
  // Drop trailing path segments (tree/branch, issues, etc.) if still present.
  const parts = candidate.split("/").filter(Boolean);
  if (parts.length >= 2) {
    candidate = `${parts[0]}/${parts[1]}`;
  }

  if (!OWNER_REPO_RE.test(candidate)) return null;
  const [owner, repo] = candidate.split("/");
  if (!owner || !repo) return null;
  // Reject path traversal / empty segments already covered by the regex.
  return {
    owner,
    repo,
    slug: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
  };
}

/** HTTPS clone URL for a GitHub slug (no credentials). */
export function githubHttpsRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/** Display label: `owner/repo` as the user typed (not forced lowercase). */
export function formatGitHubRepoLabel(ref: Pick<GitHubRepoRef, "owner" | "repo">): string {
  return `${ref.owner}/${ref.repo}`;
}
