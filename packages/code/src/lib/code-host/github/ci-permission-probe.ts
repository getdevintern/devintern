/**
 * CI-permission probe: can the GitHub credential a repository's runs use read
 * the commit CI state that auto-merge and automatic CI fixes depend on?
 *
 * A credential without `Commit statuses: Read` fails nothing visibly: the
 * auto-merge gate fails closed as a retryable "CI check status could not be
 * read" and CI-fix sweeps see no failures. This probe reads the same
 * endpoints once so `worker doctor` and worker startup can name the missing
 * permission instead.
 *
 * - `GET /repos/{slug}/commits/{default branch}/status` needs `Commit
 *   statuses: Read`: a 403 is a fail.
 * - `GET /repos/{slug}/actions/runs` needs `Actions: Read` (CI fixes only):
 *   a 403 is a fail.
 * - `GET /repos/{slug}/commits/{default branch}/check-runs` needs `Checks:
 *   Read`. Fine-grained tokens cannot be granted it and the auto-merge gate
 *   falls back to GraphQL, so for a token a 403 is informational. A GitHub App
 *   can be granted it, so there a 403 is a warning.
 *
 * Network errors, timeouts, rate limits and 5xx are "couldn't verify"
 * warnings, never failures. Token values never appear in results.
 */

/** Credential the repository's worker runs authenticate GitHub API calls with. */
export type CiProbeCredential =
  | {
      kind: "token";
      token: string;
      /** Where the token comes from (env var and file), never its value. */
      source: string;
    }
  | {
      kind: "app";
      /** Installation token for the repository. */
      getToken: () => Promise<string>;
    };

/** `info` is healthy but worth a note; the other values match readiness rows. */
export type CiProbeStatus = "ok" | "info" | "warn" | "fail";

export interface CiProbeFinding {
  status: CiProbeStatus;
  /** One-line description, for example `can't read commit statuses (HTTP 403)`. */
  detail: string;
  /** How to fix it; only on `warn` / `fail`. */
  hint?: string;
}

export interface CiProbeResult {
  /** Worst status across {@link findings}. */
  status: CiProbeStatus;
  findings: CiProbeFinding[];
}

export type CiProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CiProbeOptions {
  /** `owner/repo`. */
  slug: string;
  credential: CiProbeCredential;
  /** `[workspace].ci_failure_fix`: also check `Actions: Read`. */
  ciFailureFix: boolean;
  /** Injectable HTTP layer (tests). Defaults to global `fetch`. */
  fetch?: CiProbeFetch;
  /** Per-request timeout (default 15s). */
  timeoutMs?: number;
}

export const CI_PERMISSION_DOCS = "docs/code/configuration.md#github-authentication";

const API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const STATUS_RANK: Record<CiProbeStatus, number> = { ok: 0, info: 1, warn: 2, fail: 3 };

/** Outcome of one HTTP probe, reduced to what the classifier needs. */
type HttpOutcome =
  | { kind: "ok"; body: unknown }
  | { kind: "denied" }
  | { kind: "unverified"; reason: string };

/** Worst of several statuses (`ok` for none). */
export function worstCiProbeStatus(statuses: readonly CiProbeStatus[]): CiProbeStatus {
  return statuses.reduce<CiProbeStatus>(
    (worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
    "ok",
  );
}

/** A 403 GitHub uses for rate limiting rather than a missing permission. */
function isRateLimited(response: Response): boolean {
  return (
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
  );
}

async function request(
  fetchFn: CiProbeFetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<HttpOutcome> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "devintern-ci-permission-probe",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      kind: "unverified",
      reason: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : "network error",
    };
  }
  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { kind: "ok", body };
  }
  if (response.status === 403 && !isRateLimited(response)) return { kind: "denied" };
  if (response.status === 403 || response.status === 429) {
    return { kind: "unverified", reason: "rate limited" };
  }
  return { kind: "unverified", reason: `HTTP ${response.status}` };
}

function defaultBranchOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("default_branch" in body)) return undefined;
  return typeof body.default_branch === "string" && body.default_branch
    ? body.default_branch
    : undefined;
}

/** Encode a ref for a URL path, keeping `/` separators GitHub expects. */
function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function unverified(what: string, reason: string): CiProbeFinding {
  return {
    status: "warn",
    detail: `couldn't verify ${what} (${reason})`,
    hint: "Rerun `devintern worker doctor` once GitHub is reachable",
  };
}

function permissionHint(credential: CiProbeCredential, permission: string, why: string): string {
  const where =
    credential.kind === "app"
      ? `Add "${permission}" to your GitHub App's repository permissions and accept the updated permissions on the installation`
      : `Add "${permission}" to the GitHub token (${credential.source}); a classic token needs the \`repo\` scope`;
  return `${where}: ${why}. See ${CI_PERMISSION_DOCS}`;
}

/**
 * Probe the CI-read permissions of one GitHub repository. Never throws.
 *
 * @param options - Repository, credential, and which features are on
 * @returns Findings per permission, worst status first in {@link CiProbeResult.status}
 */
export async function probeGitHubCiPermissions(options: CiProbeOptions): Promise<CiProbeResult> {
  const { slug, credential, ciFailureFix } = options;
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const done = (findings: CiProbeFinding[]): CiProbeResult => ({
    status: worstCiProbeStatus(findings.map((finding) => finding.status)),
    findings,
  });

  let token: string;
  if (credential.kind === "app") {
    try {
      token = await credential.getToken();
    } catch {
      return done([
        {
          status: "warn",
          detail:
            "couldn't verify CI access (no GitHub App installation token for this repository)",
          hint: "Check that the GitHub App is installed on this repository",
        },
      ]);
    }
  } else {
    token = credential.token;
  }

  const repo = await request(fetchFn, `${API}/repos/${slug}`, token, timeoutMs);
  if (repo.kind !== "ok") {
    return done([
      unverified(
        "CI access",
        repo.kind === "denied" ? "repository not readable, HTTP 403" : repo.reason,
      ),
    ]);
  }
  const branch = defaultBranchOf(repo.body);
  if (!branch) return done([unverified("CI access", "no default branch")]);

  const commit = `${API}/repos/${slug}/commits/${refPath(branch)}`;
  const [statuses, checks, actions] = await Promise.all([
    request(fetchFn, `${commit}/status`, token, timeoutMs),
    request(fetchFn, `${commit}/check-runs?per_page=1`, token, timeoutMs),
    ciFailureFix
      ? request(fetchFn, `${API}/repos/${slug}/actions/runs?per_page=1`, token, timeoutMs)
      : Promise.resolve(undefined),
  ]);

  const findings: CiProbeFinding[] = [];
  if (statuses.kind === "ok") {
    findings.push({ status: "ok", detail: "commit statuses readable" });
  } else if (statuses.kind === "denied") {
    findings.push({
      status: "fail",
      detail: "can't read commit statuses (HTTP 403)",
      hint: permissionHint(
        credential,
        "Commit statuses: Read",
        "without it auto-merge never merges and CI fixes never see failures",
      ),
    });
  } else {
    findings.push(unverified("commit statuses", statuses.reason));
  }

  if (actions) {
    if (actions.kind === "ok") {
      findings.push({ status: "ok", detail: "workflow runs readable" });
    } else if (actions.kind === "denied") {
      findings.push({
        status: "fail",
        detail: "can't read workflow runs (HTTP 403)",
        hint: permissionHint(
          credential,
          "Actions: Read",
          "automatic CI fixes read failed workflow runs and their logs",
        ),
      });
    } else {
      findings.push(unverified("workflow runs", actions.reason));
    }
  }

  if (checks.kind === "ok") {
    findings.push({ status: "ok", detail: "check runs readable" });
  } else if (checks.kind === "denied") {
    findings.push(
      credential.kind === "app"
        ? {
            status: "warn",
            detail: "can't read check runs (HTTP 403)",
            hint: permissionHint(
              credential,
              "Checks: Read",
              "without it CI results lose their check-run names",
            ),
          }
        : {
            status: "info",
            detail: "check-run names hidden (fine-grained tokens can't be granted Checks)",
          },
    );
  } else {
    findings.push(unverified("check runs", checks.reason));
  }

  return done(findings);
}
