/**
 * Inject GitHub credentials into git network commands when a PAT is available.
 *
 * Origin remotes stay credential-free (`https://github.com/owner/repo.git`);
 * auth is supplied via `GIT_CONFIG_*` `http.extraHeader` for fetch/clone/ls-remote/pull
 * only when the target remote is GitHub HTTPS (never argv — keeps the PAT out of
 * process listings).
 */

import { getGitHubToken } from "./github-auth.ts";
import {
  defaultGitExec,
  type GitExec,
  type GitExecOptions,
  type GitExecResult,
} from "./git-sync.ts";

const NETWORK_COMMANDS = new Set(["clone", "fetch", "pull", "ls-remote", "push"]);

const FETCH_FLAGS_WITH_VALUE = new Set([
  "--depth",
  "--jobs",
  "-j",
  "--upload-pack",
  "--negotiation-tip",
  "--shallow-since",
  "--shallow-exclude",
  "--stdin",
  "--recurse-submodules",
]);

function skipGitConfigArgs(args: readonly string[], start: number): number {
  let i = start;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) break;
    if (arg === "-c" && args[i + 1]) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function gitVerbIndex(args: readonly string[]): number {
  return skipGitConfigArgs(args, 0);
}

function needsNetworkAuth(args: readonly string[]): boolean {
  const i = gitVerbIndex(args);
  const verb = args[i];
  return Boolean(verb && NETWORK_COMMANDS.has(verb));
}

/** True when `url` is an HTTPS remote on github.com (not SSH, not other hosts). */
export function isGitHubHttpsRemote(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "github.com" || host === "www.github.com";
  } catch {
    return false;
  }
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^(https?:\/\/|git@)/i.test(value);
}

/** First URL-looking positional in `args`, if any. */
function extractUrlFromArgs(args: readonly string[]): string | null {
  for (const arg of args) {
    if (looksLikeRemoteUrl(arg)) return arg;
  }
  return null;
}

/**
 * Remote name (or URL) for fetch/pull/push when not already a URL in args.
 * Defaults to `origin`.
 */
function remoteNameHint(args: readonly string[]): string {
  let i = gitVerbIndex(args);
  const verb = args[i];
  if (!verb) return "origin";
  i += 1;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) break;
    if (arg === "--") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      if (arg.includes("=")) {
        i += 1;
        continue;
      }
      if (FETCH_FLAGS_WITH_VALUE.has(arg)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return arg;
  }
  return "origin";
}

async function resolveNetworkRemoteUrl(
  cwd: string,
  args: readonly string[],
  inner: GitExec,
  options: GitExecOptions | undefined,
): Promise<string | null> {
  const fromArgs = extractUrlFromArgs(args);
  if (fromArgs) return fromArgs;

  const remote = remoteNameHint(args);
  if (looksLikeRemoteUrl(remote)) return remote;

  const result = await inner(cwd, ["remote", "get-url", remote], options);
  if (result.code !== 0) return null;
  const url = result.stdout.trim();
  return url.length > 0 ? url : null;
}

function authAlreadyConfigured(
  args: readonly string[],
  options: GitExecOptions | undefined,
): boolean {
  const inArgs = args.some(
    (a, idx) => a === "-c" && (args[idx + 1] ?? "").toLowerCase().includes("authorization:"),
  );
  if (inArgs) return true;
  const env = options?.env;
  if (!env) return false;
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("GIT_CONFIG_VALUE_") &&
      typeof value === "string" &&
      value.toLowerCase().includes("authorization:")
    ) {
      return true;
    }
  }
  return false;
}

/** Hostname for URL-scoped `http.<url>.extraHeader` (github.com / www.github.com). */
function githubHttpsConfigHost(remoteUrl: string): string | null {
  try {
    const host = new URL(remoteUrl.trim()).hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") return host;
    return null;
  } catch {
    return null;
  }
}

/**
 * Append one `GIT_CONFIG_KEY_N` / `GIT_CONFIG_VALUE_N` entry, preserving any
 * pre-existing `GIT_CONFIG_*` slots in `env`.
 */
export function appendGitConfigEnv(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  value: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const rawCount = next.GIT_CONFIG_COUNT;
  const count =
    typeof rawCount === "string" && /^\d+$/.test(rawCount) ? Number.parseInt(rawCount, 10) : 0;
  next[`GIT_CONFIG_KEY_${count}`] = key;
  next[`GIT_CONFIG_VALUE_${count}`] = value;
  next.GIT_CONFIG_COUNT = String(count + 1);
  return next;
}

/**
 * Wrap a git runner so GitHub HTTPS network ops include a Bearer PAT when stored.
 * The PAT is passed via `GIT_CONFIG_*` env (not argv), scoped to the GitHub host
 * so submodule fetches to other HTTPS remotes do not receive the token.
 */
export function withGitHubTokenAuth(
  inner: GitExec,
  getToken: () => Promise<string | null> = getGitHubToken,
): GitExec {
  return async (cwd, args, options): Promise<GitExecResult> => {
    if (!needsNetworkAuth(args)) {
      return inner(cwd, args, options);
    }
    if (authAlreadyConfigured(args, options)) {
      return inner(cwd, args, options);
    }

    const remoteUrl = await resolveNetworkRemoteUrl(cwd, args, inner, options);
    if (!remoteUrl || !isGitHubHttpsRemote(remoteUrl)) {
      return inner(cwd, args, options);
    }

    const host = githubHttpsConfigHost(remoteUrl);
    if (!host) {
      return inner(cwd, args, options);
    }

    const token = await getToken();
    if (!token) {
      return inner(cwd, args, options);
    }

    return inner(cwd, args, {
      ...options,
      env: appendGitConfigEnv(
        options?.env,
        `http.https://${host}/.extraHeader`,
        `Authorization: Bearer ${token}`,
      ),
    });
  };
}

/** Default session git runner: real git + optional GitHub PAT header. */
export const authenticatedGitExec: GitExec = withGitHubTokenAuth(defaultGitExec);
