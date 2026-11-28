/**
 * `worker doctor` wording for GitHub token problems: an invalid token or a
 * token that cannot see the repository is named as such with its fix, using
 * the same text as the setup wizard (`@devintern/task-trackers`).
 */

import { describeGitHubTokenProblem, githubTokenGrantHint } from "@devintern/task-trackers";

import { PUSH_FIX } from "./repo-push-probe";

/** The parts of a polled tracker source a credential failure is worded from. */
export interface CredentialSource {
  tracker: string;
  env: Record<string, string | undefined>;
  /** Display label, e.g. `github ([defaults])`. */
  name: string;
  /** Hint used when nothing more specific is known. */
  credentialHint: string;
  /** Where this source's credentials live. */
  credentialLocation: string;
}

/**
 * Detail and hint for a credential probe that failed. Nothing is missing when
 * GitHub rejects the token or it cannot see the repository, so the generic
 * "add the missing variables" hint would mislead.
 */
export function credentialFailure(
  source: CredentialSource,
  message: string,
): { detail: string; hint: string } {
  const problem =
    source.tracker === "github"
      ? describeGitHubTokenProblem(message, source.env.GITHUB_REPO)
      : undefined;
  if (!problem) return { detail: `${source.name}: ${message}`, hint: source.credentialHint };
  const where =
    problem.kind === "invalid"
      ? `replace GITHUB_TOKEN in ${source.credentialLocation}`
      : `update GITHUB_TOKEN or GITHUB_REPO in ${source.credentialLocation}`;
  return { detail: `${source.name}: ${problem.text}`, hint: `${problem.hint}; then ${where}` };
}

/** Fix for a failed repository check: push access, a bad token, or a token without the repository. */
export function repoFailureHint(repoName: string, reason: string): string {
  if (reason.includes("cannot push")) return PUSH_FIX;
  const problem = describeGitHubTokenProblem(reason);
  if (problem?.kind === "invalid") {
    return `${problem.hint}; then replace GITHUB_TOKEN in the workspace .env or this repo's env file`;
  }
  if (problem) {
    return `Check the remote URL for "${repoName}". ${githubTokenGrantHint(problem.repo)}`;
  }
  return `Check the remote URL for "${repoName}" and that GITHUB_TOKEN (or your git credentials) can read it`;
}
