/** Classifiers and messages for GitHub REST API errors. */

import { isRetryableNetworkError } from "@devintern/utils";

/**
 * Whether an error thrown by a GitHub API client call is an HTTP 404
 * (`Not Found`): the repo or PR may be gone, or this credential may lack
 * access. Callers must preserve watched PRs because 404 alone cannot
 * distinguish those cases.
 *
 * @param error - Error thrown by `apiRequest` / `conditionalGet`
 */
export function isGitHubNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("GitHub API error (404)");
}

/**
 * Whether an error thrown by a GitHub API client call is a credential failure:
 * an HTTP 401 (`Bad credentials`), a missing-credential failure, or a 403
 * permission denial with a known credential body (`Resource not accessible`,
 * `Must have admin rights`). The credential is expired, revoked, rejected, or
 * under-scoped. Unlike 5xx/429 responses this is not transient — every request
 * with the same credential fails identically, so long-running callers treat it
 * as a configuration problem (renew `GITHUB_TOKEN` or grant the missing
 * permission) instead of re-reporting it as a per-tick failure forever.
 *
 * 404 remains false because callers cannot distinguish a deleted resource from
 * one this credential cannot see. 403 responses without a credential-denial
 * body also remain false: GitHub reuses 403 for rate limits, abuse detection,
 * archived read-only repositories, locked issues, and blocked repositories.
 * Those are either transient or genuine per-request failures and must keep
 * their normal capture/retry handling.
 *
 * @param error - Error thrown by `apiRequest` / `conditionalGet`
 */
export function isGitHubAuthError(error: unknown): boolean {
  return classifyGitHubAuthError(error) !== null;
}

/** Credential failure classes that need different operator action. */
export type GitHubAuthFailureKind = "invalid-credential" | "missing-permission";

/**
 * 403 bodies that prove the credential itself lacks access rather than the
 * resource being temporarily unavailable (rate limit, archived repo, locked
 * issue, blocked repository). Matched case-insensitively against the API
 * error detail.
 */
const GITHUB_CREDENTIAL_DENIAL_PATTERNS = [
  "resource not accessible",
  "bad credentials",
  "must have admin rights",
] as const;

/**
 * Classify a GitHub credential failure so callers can give correct guidance:
 * a 401/missing token must be renewed, while a 403 with a credential-denial
 * body may be a valid token that simply lacks a permission. Unknown 403s are
 * not credential failures and keep the normal error path.
 *
 * @param error - Error thrown by `apiRequest` / `conditionalGet`
 * @returns The failure class, or `null` when this is not a credential failure
 */
export function classifyGitHubAuthError(error: unknown): GitHubAuthFailureKind | null {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("GitHub API error (401)") ||
    message.includes("No GitHub authentication configured")
  ) {
    return "invalid-credential";
  }
  if (!message.includes("GitHub API error (403)")) {
    return null;
  }
  const lower = message.toLowerCase();
  const credentialDenied = GITHUB_CREDENTIAL_DENIAL_PATTERNS.some((pattern) =>
    lower.includes(pattern),
  );
  return credentialDenied ? "missing-permission" : null;
}

/**
 * API surface a credential failure came from. Read contexts need different
 * permissions than the write context used for posting PR comments, so the
 * guidance must not name permissions the failing request does not use.
 */
export type GitHubAuthFailureContext = "reviews" | "ci" | "comment";

/** Permission hint for each context, or "" when the read path has no extra scope. */
function requiredPermissionHint(context: GitHubAuthFailureContext): string {
  switch (context) {
    case "ci":
      return " (CI polling needs Actions: Read and Commit statuses: Read)";
    case "comment":
      return " (posting pull-request comments needs Issues: Write or Pull requests: Write)";
    default:
      return "";
  }
}

/**
 * Build actionable guidance for a credential failure. Non-credential errors
 * yield an empty string.
 *
 * @param error - Error thrown by `apiRequest` / `conditionalGet`
 * @param context - API surface that failed; selects the permission hint
 * @returns Guidance sentence(s) for the operator
 */
export function describeGitHubAuthFailure(
  error: unknown,
  context: GitHubAuthFailureContext = "reviews",
): string {
  const kind = classifyGitHubAuthError(error);
  if (kind === "invalid-credential") {
    return (
      "The GitHub credential is invalid, expired, or revoked. " +
      "Renew GITHUB_TOKEN (or reconnect the workspace's GitHub credentials); " +
      (context === "comment"
        ? "the escalation retries and resumes automatically once the credential works."
        : "polling continues and resumes automatically once the credential works.")
    );
  }
  if (kind === "missing-permission") {
    return (
      "The GitHub token is valid but lacks a permission this request needs. " +
      "Grant the missing permission" +
      requiredPermissionHint(context) +
      (context === "comment"
        ? "; the escalation retries and lands automatically once the permission is granted."
        : "; polling continues and recovers automatically once the permission is granted.")
    );
  }
  return "";
}

/** GitHub statuses that represent a momentary upstream failure. */
const TRANSIENT_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Detail markers GitHub uses for primary/secondary rate-limit 403s. */
const GITHUB_RATE_LIMIT_PATTERN = /rate limit|abuse detection/i;

/**
 * Whether an error thrown by a GitHub API client call is a transient upstream
 * failure that the next poll can simply retry.
 *
 * Covers HTTP 408/429/5xx, GitHub's rate-limit 403s (primary and secondary
 * rate limits use 403, not only 429), and transport failures such as DNS or
 * connection errors. A plain 403 (permission denied) is not transient.
 *
 * `fetchWithRetry` retries the retryable HTTP statuses and transport errors
 * with backoff; rate-limit 403s are not retried by that helper, but the next
 * poll retries them. When a call still fails the error escapes into
 * long-running polling loops; reporting each occurrence to error tracking
 * turns a normal GitHub outage into a recurring defect, so callers warn
 * instead of capturing it.
 *
 * @param error - Error thrown by `apiRequest` / `conditionalGet`
 */
export function isGitHubTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/GitHub API error \((\d{3})\)(?::\s*([\s\S]*))?/);
  if (match?.[1]) {
    const status = Number(match[1]);
    if (TRANSIENT_GITHUB_STATUSES.has(status)) return true;
    if (status === 403 && GITHUB_RATE_LIMIT_PATTERN.test(match[2] ?? "")) return true;
    // A recognized status that is not transient stays non-transient; do not
    // let incidental transport-looking words in the detail reclassify it.
    return false;
  }
  return isRetryableNetworkError(error instanceof Error ? error : new Error(message));
}

/** Build an API error message; 401s get actionable credential guidance. */
export function apiErrorMessage(status: number, detail: string): string {
  const base = `GitHub API error (${status}): ${detail}`;
  if (status === 401) {
    return (
      `${base}. The GitHub credential was rejected as expired or revoked. ` +
      "Set a valid GITHUB_TOKEN (or reconnect the workspace's GitHub credentials) " +
      "to restore access."
    );
  }
  return base;
}
