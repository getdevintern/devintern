/**
 * Lightweight GitHub REST helpers for Connect (probe access, list repos).
 */

import type { GitHubRepoRef } from "../shared/github-repo.ts";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "devintern-pm-desktop";

/** Cap hung api.github.com requests so Connect / token validation cannot block indefinitely. */
const GITHUB_FETCH_TIMEOUT_MS = 30_000;

export interface GitHubRepoProbe {
  ok: true;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface GitHubRepoProbeFailure {
  ok: false;
  /** Stable code for IPC / UI branching. */
  code: "auth_required" | "not_found" | "forbidden" | "rate_limited" | "error";
  message: string;
}

export type GitHubRepoProbeResult = GitHubRepoProbe | GitHubRepoProbeFailure;

export interface GitHubRepoListItem {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** Minimal fetch surface for tests (avoids requiring `fetch.preconnect`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /aborted|timed out/i.test(err.message))
  );
}

async function githubFetch(
  path: string,
  token: string | null,
  fetchImpl: FetchLike,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    return await fetchImpl(`${GITHUB_API}${path}`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw Object.assign(
        new Error("GitHub request timed out. Check your network and try again."),
        { code: "error" },
      );
    }
    throw err;
  }
}

/**
 * Probe whether `ref` is readable with the optional token.
 * Private repos without a token → auth_required; bad token → forbidden/not_found.
 */
export async function probeGitHubRepo(
  ref: GitHubRepoRef,
  token: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubRepoProbeResult> {
  const response = await githubFetch(`/repos/${ref.owner}/${ref.repo}`, token, fetchImpl);

  if (response.status === 401) {
    return {
      ok: false,
      code: "auth_required",
      message: token
        ? "GitHub rejected this token. Paste a valid personal access token with repo access."
        : "Sign in with a GitHub personal access token to access this repository.",
    };
  }
  if (response.status === 403) {
    const body = await response.text().catch(() => "");
    if (/rate limit/i.test(body)) {
      return {
        ok: false,
        code: "rate_limited",
        message: "GitHub rate limit reached. Try again in a few minutes.",
      };
    }
    return {
      ok: false,
      code: "forbidden",
      message: token
        ? "This token does not have access to that repository. Check the token scopes or ask for access."
        : "This repository requires GitHub authentication.",
    };
  }
  if (response.status === 404) {
    // GitHub returns 404 for private repos when unauthenticated — ask for auth first.
    if (!token) {
      return {
        ok: false,
        code: "auth_required",
        message:
          "Could not find that repository (or it is private). Connect a GitHub token, then try again.",
      };
    }
    return {
      ok: false,
      code: "not_found",
      message:
        "Repository not found, or this token lacks access. Check owner/repo spelling and token permissions.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "error",
      message: `GitHub returned ${response.status}. Try again later.`,
    };
  }

  const data = (await response.json()) as {
    full_name?: string;
    private?: boolean;
    default_branch?: string;
    clone_url?: string;
  };
  const fullName = data.full_name ?? `${ref.owner}/${ref.repo}`;
  return {
    ok: true,
    fullName,
    private: data.private === true,
    defaultBranch: data.default_branch ?? "main",
    cloneUrl: data.clone_url ?? `https://github.com/${fullName}.git`,
  };
}

/** GitHub App user-to-server tokens (`ghu_`). Installation list is the supported repo source. */
function isGitHubAppUserToken(token: string): boolean {
  return token.startsWith("ghu_");
}

function listError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function throwIfListFailed(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) {
    throw listError(
      "auth_required",
      "GitHub rejected this token. Sign in again, or paste a valid personal access token with repo access.",
    );
  }
  if (response.status === 403) {
    const body = await response.text().catch(() => "");
    if (/rate limit/i.test(body)) {
      throw listError("rate_limited", "GitHub rate limit reached. Try again in a few minutes.");
    }
    throw listError(
      "forbidden",
      "This token does not have access to list repositories. Check the token scopes.",
    );
  }
  throw listError("error", `GitHub returned ${response.status}. Try again later.`);
}

interface GitHubRepoApiRow {
  full_name?: string;
  private?: boolean;
  default_branch?: string;
}

function mapRepoRows(rows: GitHubRepoApiRow[]): GitHubRepoListItem[] {
  return rows
    .filter((r): r is GitHubRepoApiRow & { full_name: string } => {
      return typeof r.full_name === "string" && r.full_name.includes("/");
    })
    .map((r) => ({
      fullName: r.full_name,
      private: r.private === true,
      defaultBranch: r.default_branch ?? "main",
    }));
}

/** PAT / classic OAuth: first page of `/user/repos`. */
async function listUserRepos(
  token: string,
  fetchImpl: FetchLike,
  perPage: number,
): Promise<GitHubRepoListItem[]> {
  const response = await githubFetch(
    `/user/repos?sort=updated&per_page=${perPage}&affiliation=owner,collaborator,organization_member`,
    token,
    fetchImpl,
  );
  await throwIfListFailed(response);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw listError("error", "GitHub returned an unexpected repository list.");
  }
  return mapRepoRows(data as GitHubRepoApiRow[]);
}

/**
 * GitHub App user tokens only see installation repos reliably.
 * Walk `/user/installations` then `/user/installations/{id}/repositories`.
 */
async function listInstallationRepos(
  token: string,
  fetchImpl: FetchLike,
  perPage: number,
): Promise<GitHubRepoListItem[]> {
  const installationIds = await listInstallationIds(token, fetchImpl);
  const seen = new Set<string>();
  const repos: GitHubRepoListItem[] = [];
  for (const installationId of installationIds) {
    if (repos.length >= perPage) break;
    const remaining = perPage - repos.length;
    const page = await listReposForInstallation(token, fetchImpl, installationId, remaining);
    for (const repo of page) {
      if (seen.has(repo.fullName)) continue;
      seen.add(repo.fullName);
      repos.push(repo);
      if (repos.length >= perPage) break;
    }
  }
  return repos;
}

async function listInstallationIds(token: string, fetchImpl: FetchLike): Promise<number[]> {
  const ids: number[] = [];
  const perPage = 100;
  for (let page = 1; page <= 3; page++) {
    const response = await githubFetch(
      `/user/installations?per_page=${perPage}&page=${page}`,
      token,
      fetchImpl,
    );
    await throwIfListFailed(response);
    const data: unknown = await response.json();
    const installations =
      data && typeof data === "object" && "installations" in data
        ? (data as { installations?: unknown }).installations
        : undefined;
    if (!Array.isArray(installations)) {
      throw listError("error", "GitHub returned an unexpected installations list.");
    }
    for (const installation of installations) {
      const id =
        installation && typeof installation === "object" && "id" in installation
          ? (installation as { id?: unknown }).id
          : undefined;
      if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
    }
    if (installations.length < perPage) break;
  }
  return ids;
}

async function listReposForInstallation(
  token: string,
  fetchImpl: FetchLike,
  installationId: number,
  limit: number,
): Promise<GitHubRepoListItem[]> {
  const repos: GitHubRepoListItem[] = [];
  const perPage = Math.min(Math.max(limit, 1), 100);
  for (let page = 1; page <= 3 && repos.length < limit; page++) {
    const response = await githubFetch(
      `/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
      token,
      fetchImpl,
    );
    await throwIfListFailed(response);
    const data: unknown = await response.json();
    const rows =
      data && typeof data === "object" && "repositories" in data
        ? (data as { repositories?: unknown }).repositories
        : undefined;
    if (!Array.isArray(rows)) {
      throw listError("error", "GitHub returned an unexpected repository list.");
    }
    for (const repo of mapRepoRows(rows as GitHubRepoApiRow[])) {
      repos.push(repo);
      if (repos.length >= limit) break;
    }
    if (rows.length < perPage) break;
  }
  return repos;
}

/**
 * List repositories visible to the stored token (capped).
 * GitHub App user tokens (`ghu_`) walk installations — `/user/repos` often
 * returns [] for org installs even when the app is installed.
 * PAT / other tokens use `/user/repos`.
 * Throws an Error with `code` when unauthenticated or on auth/API failures
 * (so Connect can show them instead of an empty list).
 */
export async function listGitHubRepos(
  token: string | null,
  fetchImpl: FetchLike = fetch,
  options: { perPage?: number } = {},
): Promise<GitHubRepoListItem[]> {
  if (!token) {
    throw listError(
      "auth_required",
      "GitHub sign-in expired. Sign in again to list your repositories.",
    );
  }
  const perPage = Math.min(options.perPage ?? 50, 100);
  if (isGitHubAppUserToken(token)) {
    return listInstallationRepos(token, fetchImpl, perPage);
  }
  return listUserRepos(token, fetchImpl, perPage);
}

/** Validate a token by calling `/user`. */
export async function validateGitHubToken(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; login: string } | { ok: false; message: string }> {
  const response = await githubFetch("/user", token, fetchImpl);
  if (response.status === 401) {
    return { ok: false, message: "GitHub rejected this token." };
  }
  if (!response.ok) {
    return { ok: false, message: `Could not verify token (GitHub ${response.status}).` };
  }
  const data = (await response.json()) as { login?: string };
  return { ok: true, login: data.login ?? "authenticated" };
}
