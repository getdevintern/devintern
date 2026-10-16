/**
 * Explicit remote-tracker configuration for the live tracker suite.
 *
 * Every value is read from a dedicated `E2E_TRACKER_*` variable and validated
 * before the first remote mutation. Nothing falls back to a developer's
 * production tracker credentials or to the code-host configuration, so a
 * missing variable fails fast instead of provisioning a ticket somewhere
 * unexpected.
 */

export interface GitHubTrackerConfig {
  /** `owner/repo` of the dedicated tracker repository. */
  repository: string;
  /** Token used for tracker reads/writes. */
  token: string;
  /** Optional mutually-exclusive status label names. */
  statusLabels: string[];
}

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * Resolve and validate GitHub Issues tracker configuration.
 *
 * @param env - Environment source (defaults to `process.env`).
 * @throws When the repository or token is missing or malformed.
 */
export function resolveGitHubTrackerConfig(
  env: Record<string, string | undefined> = process.env,
): GitHubTrackerConfig {
  const repository = env.E2E_TRACKER_REPOSITORY?.trim() ?? "";
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      "Set E2E_TRACKER_REPOSITORY=owner/repo to a dedicated repository that will host test tickets",
    );
  }
  const token = env.E2E_TRACKER_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error("Set E2E_TRACKER_TOKEN for the live tracker suite");
  }
  const statusLabels = (env.E2E_TRACKER_STATUS_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  return { repository, token, statusLabels };
}
