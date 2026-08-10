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

/**
 * List repositories visible to the authenticated user (first page, capped).
 * Requires a token; returns [] when unauthenticated.
 * Throws an Error with `code` on auth/API failures (so Connect can show them).
 */
export async function listGitHubRepos(
  token: string | null,
  fetchImpl: FetchLike = fetch,
  options: { perPage?: number } = {},
): Promise<GitHubRepoListItem[]> {
  if (!token) return [];
  const perPage = Math.min(options.perPage ?? 50, 100);
  const response = await githubFetch(
    `/user/repos?sort=updated&per_page=${perPage}&affiliation=owner,collaborator,organization_member`,
    token,
    fetchImpl,
  );
  if (!response.ok) {
    const err = new Error() as Error & { code?: string };
    if (response.status === 401) {
      err.code = "auth_required";
      err.message =
        "GitHub rejected this token. Paste a valid personal access token with repo access.";
    } else if (response.status === 403) {
      const body = await response.text().catch(() => "");
      if (/rate limit/i.test(body)) {
        err.code = "rate_limited";
        err.message = "GitHub rate limit reached. Try again in a few minutes.";
      } else {
        err.code = "forbidden";
        err.message =
          "This token does not have access to list repositories. Check the token scopes.";
      }
    } else {
      err.code = "error";
      err.message = `GitHub returned ${response.status}. Try again later.`;
    }
    throw err;
  }
  const data = (await response.json()) as Array<{
    full_name?: string;
    private?: boolean;
    default_branch?: string;
  }>;
  if (!Array.isArray(data)) return [];
  return data
    .filter((r) => typeof r.full_name === "string" && r.full_name.includes("/"))
    .map((r) => ({
      fullName: r.full_name!,
      private: r.private === true,
      defaultBranch: r.default_branch ?? "main",
    }));
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
