import { normalizeCodeHostUrl } from "./provider";
import type { ChangeRequestIdentity } from "./provider";

export interface PRInfo {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  repository: string;
  /** Labels to apply (GitHub; existing project labels only on GitLab). */
  labels?: string[];
}

/**
 * Parse a comma-separated `PR_LABELS` value into label names.
 *
 * @param value - Raw env value, e.g. `"devintern, auto-pr"`
 */
export function parsePrLabels(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

/** Extract the PR number from a PR html_url (`…/pull/123`). */
export function prNumberFromUrl(url: string | undefined): number | undefined {
  const parsed = Number(url?.match(/\/pull\/(\d+)/)?.[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface PRResult {
  success: boolean;
  url?: string;
  message: string;
  /** Additive provider-neutral identity for durable state and dashboards. */
  changeRequest?: ChangeRequestIdentity;
  warnings?: string[];
}

export const VALIDATED_GITLAB_VERSION = "19.3";

/** Whether the experimental GitLab code-host integration is explicitly enabled. */
export function isGitLabCodeHostEnabled(
  value = process.env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST,
) {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

export type GitLabCodeHostConfigResult =
  | {
      ok: true;
      instanceUrl: string;
      token: string;
      caFile?: string;
      proxy?: string;
    }
  | { ok: false; message: string };

/** Resolve the default GitLab code-host profile without crossing token boundaries. */
export function resolveGitLabCodeHostConfig(
  remoteInstanceUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): GitLabCodeHostConfigResult {
  if (!isGitLabCodeHostEnabled(env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST)) {
    return {
      ok: false,
      message:
        "GitLab code-host support is experimental. Set DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST=true to enable it.",
    };
  }

  let instanceUrl: string;
  try {
    instanceUrl = normalizeCodeHostUrl(env.GITLAB_CODE_HOST_URL || "https://gitlab.com");
  } catch (error) {
    return { ok: false, message: `Invalid GITLAB_CODE_HOST_URL: ${(error as Error).message}` };
  }
  if (remoteInstanceUrl !== instanceUrl) {
    return {
      ok: false,
      message: `GitLab remote belongs to ${remoteInstanceUrl}, but the configured code-host profile is ${instanceUrl}`,
    };
  }

  let token = env.GITLAB_CODE_HOST_TOKEN;
  if (!token && (env.TASK_TRACKER ?? "").toLowerCase() === "gitlab") {
    try {
      const trackerUrl = normalizeCodeHostUrl(env.GITLAB_BASE_URL || "https://gitlab.com");
      if (trackerUrl === instanceUrl) token = env.GITLAB_TOKEN;
    } catch {
      // An invalid tracker URL cannot authorize fallback to its token.
    }
  }
  if (!token) {
    return {
      ok: false,
      message:
        "GitLab code-host client not configured. Set GITLAB_CODE_HOST_TOKEN; the tracker token is reused only when both instance URLs match.",
    };
  }

  return {
    ok: true,
    instanceUrl,
    token,
    caFile: env.GITLAB_CODE_HOST_CA_FILE,
    proxy: env.GITLAB_CODE_HOST_PROXY,
  };
}

/**
 * Match PR-creation failures worth retrying: DNS/connect failures, timeouts,
 * and other transport-level errors. Deliberately conservative so API-level
 * validation errors (401/404/422 "Validation Failed", etc.) fail fast.
 */
export function isTransientPrFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("typo in the url or port") ||
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("socket hang up") ||
    m.includes("epipe") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("econnaborted") ||
    m.includes("etimedout") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("enotfound") ||
    m.includes("eai_again") ||
    m.includes("unable to connect") ||
    m.includes("unable to resolve") ||
    m.includes("getaddrinfo")
  );
}
