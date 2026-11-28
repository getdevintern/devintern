/**
 * Shared wording for GitHub token problems, so the interactive wizards, the
 * readiness checks (`worker doctor`), and the non-interactive `fix-*` steps
 * name the same cause and the same fix.
 *
 * The permission list mirrors the token table in
 * `docs/code/configuration.md#github-authentication`; keep them in sync.
 */

/** Where to create a fine-grained personal access token (recommended). */
export const GITHUB_FINE_GRAINED_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new";

/** Where to create a classic personal access token with the `repo` scope. */
export const GITHUB_CLASSIC_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo&description=devintern";

/** Repository permissions a fine-grained token needs. */
export const GITHUB_FINE_GRAINED_PERMISSIONS =
  "Contents, Pull requests, and Issues set to Read and write (Metadata Read is added automatically)";

/**
 * Lines printed under a token prompt's link: what to grant a fine-grained
 * token, and the classic alternative.
 *
 * @param repo - `owner/repo` to name in the repository-access line, when known
 */
export function githubTokenLinkDetails(repo?: string): string[] {
  return [
    `Fine-grained (recommended): Repository access → ${repo || "the repositories the worker uses"}; ` +
      `permissions: ${GITHUB_FINE_GRAINED_PERMISSIONS}`,
    `Or a classic token with the repo scope: ${GITHUB_CLASSIC_TOKEN_URL}`,
  ];
}

/** One-line "how to create a new token" pointer, for error messages. */
export function githubNewTokenHint(): string {
  return (
    `Create a new token: fine-grained at ${GITHUB_FINE_GRAINED_TOKEN_URL} ` +
    `(${GITHUB_FINE_GRAINED_PERMISSIONS}), or classic with the repo scope at ${GITHUB_CLASSIC_TOKEN_URL}`
  );
}

/** How to give an existing token access to a repository. */
export function githubTokenGrantHint(repo: string): string {
  return (
    `Give GITHUB_TOKEN access to ${repo}: for a fine-grained token, add it under Repository access ` +
    `with ${GITHUB_FINE_GRAINED_PERMISSIONS}; for a classic token, use the repo scope ` +
    "(an organization may need to approve the token first)"
  );
}

/** How to let a token that can read a repository also push to it and open pull requests. */
export function githubTokenWriteHint(): string {
  return (
    "Give GITHUB_TOKEN write access to the repository: for a fine-grained token, set " +
    `${GITHUB_FINE_GRAINED_PERMISSIONS}; for a classic token, use the repo scope`
  );
}

/** Fix for a token that cannot see the configured `GITHUB_REPO`. */
export function githubRepoAccessHint(repo: string): string {
  return `Check that GITHUB_REPO is right. ${githubTokenGrantHint(repo)}`;
}

/** What went wrong with a GitHub token, read from a probe or API error message. */
export type GitHubTokenProblem =
  | { kind: "invalid"; text: string; hint: string }
  | { kind: "no-access"; repo: string; text: string; hint: string };

/**
 * Classify a GitHub probe error: a token GitHub rejected (401 / bad
 * credentials), or a token that cannot see the repository (404 / a
 * non-rate-limited 403 from the repository check). Anything else (network,
 * 5xx, rate limit) returns undefined so callers keep the raw message.
 *
 * @param message - Error message from `GitHubClient` or a readiness probe
 * @param repo - Configured `GITHUB_REPO`, used when the message names none
 */
export function describeGitHubTokenProblem(
  message: string,
  repo?: string,
): GitHubTokenProblem | undefined {
  if (
    /GitHub API error \(401\)|GitHub API 401\b|\(HTTP 401\)|Bad credentials/i.test(message) &&
    !/rate limit/i.test(message)
  ) {
    return {
      kind: "invalid",
      text: "GitHub rejected GITHUB_TOKEN (HTTP 401): the token is invalid, expired, or revoked",
      hint: githubNewTokenHint(),
    };
  }
  const noAccess =
    /GitHub token cannot access (\S+) \(HTTP (?:403|404)\)/.exec(message) ??
    /GitHub API 404 for (\S+)/.exec(message);
  if (noAccess) {
    const slug = noAccess[1] || repo || "the repository";
    return {
      kind: "no-access",
      repo: slug,
      text: `GITHUB_TOKEN has no access to ${slug}: the repository does not exist or the token is not granted it`,
      hint: githubRepoAccessHint(slug),
    };
  }
  return undefined;
}
