/**
 * Supply code-host tokens to git for HTTPS remotes, per invocation.
 *
 * Git never reads `GITHUB_TOKEN` (or a GitLab token) on its own, so on a box
 * with no credential helper a worker clone of `https://github.com/...` fails
 * with "could not read Username". This module closes that gap without writing
 * anything to disk: it adds a URL-scoped `credential.<url>.helper` through
 * git's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` environment
 * config, for the one git process being spawned.
 *
 * Security properties:
 * - The token never appears in argv, a remote URL, `.git/config`, or the
 *   helper definition. The helper is a fixed shell snippet that prints the
 *   value of a named environment variable (`$GITHUB_TOKEN`) with the shell's
 *   builtin `printf`, so the secret only ever lives in the environment of
 *   processes owned by the same user.
 * - The helper is scoped to the code host's HTTPS URL, so SSH remotes and
 *   every other host are untouched, and it answers only `get` (never `store`
 *   or `erase`).
 * - It is added only when git has no credential helper configured for that
 *   URL and no `GIT_ASKPASS` program is set. A user's own helper (`gh auth
 *   setup-git`, a keychain, a credential manager) is never overridden, and a configured storing helper such as
 *   `store` is never handed the token to persist.
 */

import { spawnSync } from "child_process";

import { normalizeCodeHostUrl } from "../code-host/provider";

type Env = NodeJS.ProcessEnv;

/** A code-host token git may use for one HTTPS URL prefix. */
export interface GitCredentialSource {
  /** URL prefix the helper is scoped to, e.g. `https://github.com`. */
  url: string;
  /** Username the host expects alongside a token. */
  username: string;
  /** Environment variable holding the token; read by the helper at run time. */
  tokenVar: string;
}

/** Placeholder written over a supplied token in captured git output. */
const REDACTED = "[redacted]";

/** Git subcommands that may contact a remote and so may need credentials. */
const NETWORK_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "remote",
  "submodule",
]);

/** Global git options that take a separate value argument. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/** Only variable names of this shape are interpolated into the helper. */
const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The git subcommand in `args`, skipping global options such as `-C <dir>` or
 * `-c key=value`.
 */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/** Whether a git invocation may talk to a remote. */
export function isGitNetworkCommand(args: readonly string[]): boolean {
  const subcommand = gitSubcommand(args);
  return subcommand !== undefined && NETWORK_SUBCOMMANDS.has(subcommand);
}

/** HTTPS instance URL from a configured value, or undefined when unusable. */
function httpsInstanceUrl(value: string): string | undefined {
  try {
    const url = normalizeCodeHostUrl(value);
    // Never hand a token to a plain-HTTP remote.
    return url.startsWith("https://") ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Code-host tokens in `env` that git can use, one per host.
 *
 * - GitHub: `GITHUB_TOKEN` for `https://github.com` (user `x-access-token`,
 *   which GitHub accepts for classic, fine-grained, and App tokens).
 * - GitLab: `GITLAB_CODE_HOST_TOKEN` for `GITLAB_CODE_HOST_URL` (default
 *   `https://gitlab.com`); with `TASK_TRACKER=gitlab` and matching instance
 *   URLs the tracker's `GITLAB_TOKEN` is reused, like merge-request creation
 *   does. User `oauth2`, which GitLab accepts for personal, project, group,
 *   and OAuth tokens.
 */
export function gitCredentialSources(env: Env): GitCredentialSource[] {
  const sources: GitCredentialSource[] = [];
  if (env.GITHUB_TOKEN?.trim()) {
    sources.push({
      url: "https://github.com",
      username: "x-access-token",
      tokenVar: "GITHUB_TOKEN",
    });
  }

  const gitlabUrl = httpsInstanceUrl(env.GITLAB_CODE_HOST_URL || "https://gitlab.com");
  if (gitlabUrl) {
    if (env.GITLAB_CODE_HOST_TOKEN?.trim()) {
      sources.push({ url: gitlabUrl, username: "oauth2", tokenVar: "GITLAB_CODE_HOST_TOKEN" });
    } else if (
      env.GITLAB_TOKEN?.trim() &&
      (env.TASK_TRACKER ?? "").toLowerCase() === "gitlab" &&
      httpsInstanceUrl(env.GITLAB_BASE_URL || "https://gitlab.com") === gitlabUrl
    ) {
      sources.push({ url: gitlabUrl, username: "oauth2", tokenVar: "GITLAB_TOKEN" });
    }
  }
  return sources;
}

/** Environment variables {@link gitCredentialSources} reads. */
const CREDENTIAL_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITLAB_CODE_HOST_TOKEN",
  "GITLAB_CODE_HOST_URL",
  "GITLAB_TOKEN",
  "GITLAB_BASE_URL",
  "TASK_TRACKER",
] as const;

/** The subset of `env` that decides which code-host credentials git gets. */
export function pickGitCredentialEnv(env: Env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of CREDENTIAL_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/**
 * Inline credential helper that answers `get` with the username and the value
 * of `tokenVar`. Git runs `!` helpers through `sh -c`; only the variable
 * *name* is in the command, and `printf` is a shell builtin, so the token is
 * never in any process's argv.
 */
export function gitCredentialHelper(source: GitCredentialSource): string {
  if (!ENV_VAR_NAME.test(source.tokenVar) || !/^[\w.@-]+$/.test(source.username)) {
    throw new Error(`Unsafe git credential source: ${source.tokenVar}`);
  }
  return (
    `!f() { test "$1" = get || return 0; ` +
    `printf 'username=%s\\npassword=%s\\n' '${source.username}' "$${source.tokenVar}"; }; f`
  );
}

/**
 * Whether git already has a credential helper for `url` (any scope, including
 * `GIT_CONFIG_*`). An empty value is git's "reset the helper list" marker and
 * counts as none.
 */
export function hasConfiguredCredentialHelper(url: string, env: Env, cwd?: string): boolean {
  const result = spawnSync("git", ["config", "--get-urlmatch", "credential.helper", url], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return result.status === 0 && (result.stdout ?? "").trim() !== "";
}

/** Inputs to {@link gitCredentialEnv}; `hasHelper` is injectable for tests. */
export interface GitCredentialEnvOptions {
  cwd?: string;
  hasHelper?: (url: string, env: Env, cwd?: string) => boolean;
}

/**
 * Environment for one git invocation: `env` plus URL-scoped credential
 * helpers for every configured code-host token git has no helper for.
 *
 * Returns `env` unchanged for local commands, when no token is set, when
 * `GIT_ASKPASS` names a program, when every host already has a helper, or when an existing `GIT_CONFIG_COUNT` is
 * malformed (git would reject the command anyway). Existing `GIT_CONFIG_*`
 * entries are preserved; the new entries are appended after them.
 */
export function gitCredentialEnv(
  args: readonly string[],
  env: Env,
  options: GitCredentialEnvOptions = {},
): Env {
  if (!isGitNetworkCommand(args)) return env;
  // An explicit askpass program is the caller's own credential source.
  if (env.GIT_ASKPASS?.trim()) return env;
  const sources = gitCredentialSources(env);
  if (sources.length === 0) return env;

  const rawCount = env.GIT_CONFIG_COUNT?.trim();
  if (rawCount && !/^\d+$/.test(rawCount)) return env;
  let count = rawCount ? Number(rawCount) : 0;

  const hasHelper = options.hasHelper ?? hasConfiguredCredentialHelper;
  const additions: Env = {};
  for (const source of sources) {
    if (hasHelper(source.url, env, options.cwd)) continue;
    additions[`GIT_CONFIG_KEY_${count}`] = `credential.${source.url}.helper`;
    additions[`GIT_CONFIG_VALUE_${count}`] = gitCredentialHelper(source);
    count += 1;
  }
  if (Object.keys(additions).length === 0) return env;
  return { ...env, ...additions, GIT_CONFIG_COUNT: String(count) };
}

/**
 * Replace every code-host token value from `env` in `text`. Git does not echo
 * helper-supplied passwords, so this is defense in depth for output that is
 * surfaced in logs, run records, and tracker comments.
 */
export function redactGitCredentials(text: string, env: Env): string {
  let out = text;
  for (const source of gitCredentialSources(env)) {
    const token = env[source.tokenVar]?.trim();
    if (token && token.length >= 8) out = out.split(token).join(REDACTED);
  }
  return out;
}
