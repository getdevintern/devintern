/**
 * Commit identity for the commits DevIntern itself makes (task commits, the
 * WIP commit of `preserve-work`, conflict merges, rebases, hook-fix amends).
 *
 * A fresh box often has no git `user.name`/`user.email`, and git then refuses
 * every commit ("Author identity unknown"). Rather than write global config,
 * each commit-creating git command gets the missing parts through the
 * `GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment of that one process.
 *
 * Resolution order (first match wins):
 * 1. What git already has for the checkout: `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
 *    (and `EMAIL`) in the environment, `-c user.*` on the command line, and
 *    `user.*`/`author.*`/`committer.*` from any config scope. Never overridden;
 *    only fields git lacks are filled.
 * 2. The workspace setting `git_author_name`/`git_author_email` (`[workspace]`
 *    or a `[[repos]]` entry), which reaches the task process as
 *    {@link GIT_AUTHOR_NAME_ENV}/{@link GIT_AUTHOR_EMAIL_ENV}.
 * 3. The code-host token's user: `GITHUB_TOKEN` → `GET /user` →
 *    `name || login` and `<id>+<login>@users.noreply.github.com`; a GitLab
 *    code-host token → `GET /api/v4/user`. Cached on disk per token.
 * 4. {@link FALLBACK_COMMIT_IDENTITY}, with a warning.
 *
 * A previous commit's identity (HEAD's author) is never borrowed.
 */

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";

import { workspaceCodeStateDir } from "../workspace/paths";
import { gitCredentialSources, gitSubcommand } from "./git-credentials";
import { writeSecretFile } from "./secret-file";

type Env = NodeJS.ProcessEnv;

/** Workspace setting for the commit author name, as the task process sees it. */
export const GIT_AUTHOR_NAME_ENV = "DEVINTERN_GIT_AUTHOR_NAME";
/** Workspace setting for the commit author email, as the task process sees it. */
export const GIT_AUTHOR_EMAIL_ENV = "DEVINTERN_GIT_AUTHOR_EMAIL";

/** Last-resort identity when nothing else resolves. */
export const FALLBACK_COMMIT_IDENTITY = {
  name: "DevIntern",
  email: "devintern@users.noreply.github.com",
} as const;

/** Where a resolved identity came from. */
export type CommitIdentitySource = "workspace" | "github-user" | "gitlab-user" | "fallback";

/** An identity DevIntern supplies when git has none. */
export interface CommitIdentity {
  name: string;
  email: string;
  source: CommitIdentitySource;
  /** Why the fallback was used (fallback only). */
  reason?: string;
}

/** The four identity variables git reads. */
export type IdentityEnv = Partial<
  Record<
    "GIT_AUTHOR_NAME" | "GIT_AUTHOR_EMAIL" | "GIT_COMMITTER_NAME" | "GIT_COMMITTER_EMAIL",
    string
  >
>;

/** Identity fields git resolves for a checkout without DevIntern's help. */
export interface ConfiguredIdentity {
  authorName?: string;
  authorEmail?: string;
  committerName?: string;
  committerEmail?: string;
}

/** Git subcommands that create commits and so need an identity. */
const COMMIT_SUBCOMMANDS = new Set([
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "pull",
  "stash",
]);

/** Whether `args` is a git invocation that may create a commit. */
export function isGitCommitCommand(args: readonly string[]): boolean {
  const subcommand = gitSubcommand(args);
  return subcommand !== undefined && COMMIT_SUBCOMMANDS.has(subcommand);
}

/** The leading `-c key=value` pairs of a git invocation (before the subcommand). */
export function leadingConfigArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-c" && index + 1 < args.length) {
      out.push("-c", args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) break;
  }
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Identity git already has for `cwd`: environment variables first, then config
 * from every scope (including `-c` pairs in `configArgs`). Reads config with
 * one `git config --get-regexp` call.
 */
export function readConfiguredIdentity(
  cwd: string | undefined,
  env: Env,
  configArgs: readonly string[] = [],
): ConfiguredIdentity {
  const result = spawnSync(
    "git",
    [...configArgs, "config", "--get-regexp", "^(user|author|committer)\\.(name|email)$"],
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
  );
  const config = new Map<string, string>();
  if (result.status === 0) {
    for (const line of (result.stdout ?? "").split("\n")) {
      const space = line.indexOf(" ");
      if (space <= 0) continue;
      const value = nonEmpty(line.slice(space + 1));
      // Later scopes (local, worktree, command line) override earlier ones.
      if (value) config.set(line.slice(0, space).toLowerCase(), value);
    }
  }
  const userName = config.get("user.name");
  const userEmail = config.get("user.email");
  const email = nonEmpty(env.EMAIL);
  return {
    authorName: nonEmpty(env.GIT_AUTHOR_NAME) ?? config.get("author.name") ?? userName,
    authorEmail: nonEmpty(env.GIT_AUTHOR_EMAIL) ?? config.get("author.email") ?? userEmail ?? email,
    committerName: nonEmpty(env.GIT_COMMITTER_NAME) ?? config.get("committer.name") ?? userName,
    committerEmail:
      nonEmpty(env.GIT_COMMITTER_EMAIL) ?? config.get("committer.email") ?? userEmail ?? email,
  };
}

/** Whether every identity field is already configured. */
export function isIdentityComplete(identity: ConfiguredIdentity): boolean {
  return Boolean(
    identity.authorName &&
    identity.authorEmail &&
    identity.committerName &&
    identity.committerEmail,
  );
}

/** Env filling only the fields `configured` lacks from `identity`. */
export function missingIdentityEnv(
  configured: ConfiguredIdentity,
  identity: { name: string; email: string },
): IdentityEnv {
  const env: IdentityEnv = {};
  if (!configured.authorName) env.GIT_AUTHOR_NAME = identity.name;
  if (!configured.authorEmail) env.GIT_AUTHOR_EMAIL = identity.email;
  if (!configured.committerName) env.GIT_COMMITTER_NAME = identity.name;
  if (!configured.committerEmail) env.GIT_COMMITTER_EMAIL = identity.email;
  return env;
}

/** A code-host user parsed from `GET /user`. */
interface HostUser {
  name: string;
  email: string;
}

/** Injectable network and cache hooks. */
export interface IdentityDeps {
  fetch?: typeof fetch;
  /** Cache file; default `<workspace>/state/code/git-identity.json`. */
  cachePath?: string;
  /** Remote URL of the checkout (default: `git remote get-url origin`). */
  remoteUrl?: (cwd: string | undefined, env: Env) => string | undefined;
  warn?: (message: string) => void;
  now?: () => number;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

let testDeps: IdentityDeps = {};
const memo = new Map<string, Promise<CommitIdentity>>();
let fallbackWarned = false;

/** Replace the network/cache hooks and clear memoized identities (tests). */
export function setCommitIdentityDepsForTests(deps: IdentityDeps = {}): void {
  testDeps = deps;
  memo.clear();
  fallbackWarned = false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse GitHub's `GET /user`. */
export function parseGitHubUser(body: unknown): HostUser | undefined {
  if (!isRecord(body) || typeof body.login !== "string" || typeof body.id !== "number") {
    return undefined;
  }
  const login = body.login;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : login;
  return { name, email: `${body.id}+${login}@users.noreply.github.com` };
}

/** Parse GitLab's `GET /api/v4/user`; `host` names the noreply domain. */
export function parseGitLabUser(body: unknown, host: string): HostUser | undefined {
  if (!isRecord(body) || typeof body.username !== "string" || typeof body.id !== "number") {
    return undefined;
  }
  const username = body.username;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : username;
  const commitEmail =
    typeof body.commit_email === "string" && body.commit_email.includes("@")
      ? body.commit_email
      : undefined;
  return { name, email: commitEmail ?? `${body.id}-${username}@users.noreply.${host}` };
}

interface CacheEntry {
  name: string;
  email: string;
  fetchedAt: number;
}

function parseCache(raw: string): Record<string, CacheEntry> {
  const out: Record<string, CacheEntry> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(parsed) || !isRecord(parsed.entries)) return out;
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (
      isRecord(value) &&
      typeof value.name === "string" &&
      typeof value.email === "string" &&
      typeof value.fetchedAt === "number"
    ) {
      out[key] = { name: value.name, email: value.email, fetchedAt: value.fetchedAt };
    }
  }
  return out;
}

function cachePath(deps: IdentityDeps): string {
  return deps.cachePath ?? join(workspaceCodeStateDir(), "git-identity.json");
}

function readCache(deps: IdentityDeps): Record<string, CacheEntry> {
  try {
    const path = cachePath(deps);
    return existsSync(path) ? parseCache(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeCache(deps: IdentityDeps, key: string, user: HostUser, now: number): void {
  try {
    const path = cachePath(deps);
    const entries = readCache(deps);
    entries[key] = { name: user.name, email: user.email, fetchedAt: now };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeSecretFile(tmp, `${JSON.stringify({ entries }, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // Best effort: the next process fetches again.
  }
}

/** Cache key for one token: provider, host, and a short token digest (never the token). */
function tokenKey(provider: string, url: string, token: string): string {
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${provider}:${url}:${digest}`;
}

async function fetchJson(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await doFetch(url, {
    headers: { "User-Agent": "devintern", ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** The token's user from the cache, else the host's API. */
async function tokenUser(
  source: { provider: "github" | "gitlab"; url: string; token: string },
  deps: IdentityDeps,
): Promise<HostUser> {
  const now = (deps.now ?? Date.now)();
  const key = tokenKey(source.provider, source.url, source.token);
  const cached = readCache(deps)[key];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { name: cached.name, email: cached.email };
  }
  const doFetch = deps.fetch ?? fetch;
  let user: HostUser | undefined;
  if (source.provider === "github") {
    const body = await fetchJson(doFetch, "https://api.github.com/user", {
      Authorization: `Bearer ${source.token}`,
      Accept: "application/vnd.github+json",
    });
    user = parseGitHubUser(body);
  } else {
    const body = await fetchJson(doFetch, `${source.url.replace(/\/+$/, "")}/api/v4/user`, {
      Authorization: `Bearer ${source.token}`,
    });
    user = parseGitLabUser(body, new URL(source.url).host);
  }
  if (!user) throw new Error("unexpected response from the user API");
  writeCache(deps, key, user, now);
  return user;
}

function defaultRemoteUrl(cwd: string | undefined, env: Env): string | undefined {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return result.status === 0 ? nonEmpty(result.stdout) : undefined;
}

/** Host of an https, ssh, or scp-style remote URL. */
function remoteHost(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(remote);
  if (scp?.[1]) return scp[1].toLowerCase();
  try {
    return new URL(remote).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Token sources in preference order: the one matching the remote's host first. */
function tokenSources(
  env: Env,
  host: string | undefined,
): { provider: "github" | "gitlab"; url: string; token: string }[] {
  const sources = gitCredentialSources(env).flatMap((source) => {
    const token = nonEmpty(env[source.tokenVar]);
    if (!token) return [];
    const provider: "github" | "gitlab" = source.tokenVar === "GITHUB_TOKEN" ? "github" : "gitlab";
    return [{ provider, url: source.url, token }];
  });
  if (!host) return sources;
  const matches = (url: string) => {
    try {
      return new URL(url).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  };
  return [...sources.filter((s) => matches(s.url)), ...sources.filter((s) => !matches(s.url))];
}

/**
 * The identity DevIntern supplies when git has none (steps 2-4 of the module
 * comment). Memoized per process; never throws.
 *
 * @param env - Environment holding the workspace setting and tokens
 * @param options.cwd - Checkout, to prefer the token of its remote's host
 * @param options.offline - Skip the network (cache still used)
 */
export async function resolveCommitIdentity(
  env: Env = process.env,
  options: { cwd?: string; offline?: boolean; deps?: IdentityDeps } = {},
): Promise<CommitIdentity> {
  const deps = { ...testDeps, ...options.deps };
  const name = nonEmpty(env[GIT_AUTHOR_NAME_ENV]);
  const email = nonEmpty(env[GIT_AUTHOR_EMAIL_ENV]);
  if (name && email) return { name, email, source: "workspace" };

  const host = remoteHost((deps.remoteUrl ?? defaultRemoteUrl)(options.cwd, env));
  const sources = tokenSources(env, host);
  const key = JSON.stringify([
    options.offline === true,
    sources.map((s) => tokenKey(s.provider, s.url, s.token)),
  ]);
  const cached = memo.get(key);
  if (cached && !options.deps) return cached;
  const pending = (async (): Promise<CommitIdentity> => {
    const failures: string[] = [];
    for (const source of sources) {
      const label = source.provider === "github" ? "GITHUB_TOKEN" : "GitLab token";
      if (options.offline) {
        failures.push(`${label} user not looked up (offline)`);
        continue;
      }
      try {
        const user = await tokenUser(source, deps);
        return {
          ...user,
          source: source.provider === "github" ? "github-user" : "gitlab-user",
        };
      } catch (error) {
        failures.push(`could not look up the ${label} user: ${(error as Error).message}`);
      }
    }
    return {
      ...FALLBACK_COMMIT_IDENTITY,
      source: "fallback",
      reason: failures.length > 0 ? failures.join("; ") : "no git identity, setting, or token",
    };
  })();
  if (!options.deps) memo.set(key, pending);
  return pending;
}

/** How to set an identity yourself, for warnings, hints and failure comments. */
export const COMMIT_IDENTITY_FIX =
  'run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com` ' +
  "on the worker host, or set git_author_name and git_author_email under [workspace] in workspace.toml";

/** `Name <email>` plus where it came from, for logs and doctor. */
export function describeCommitIdentity(identity: CommitIdentity): string {
  const from: Record<CommitIdentitySource, string> = {
    workspace: "workspace setting",
    "github-user": "derived from the GitHub token's user",
    "gitlab-user": "derived from the GitLab token's user",
    fallback: "fallback",
  };
  return `${identity.name} <${identity.email}> (${from[identity.source]})`;
}

/**
 * Extra env for one commit-creating git command so it never fails for lack of
 * an identity: only the fields git lacks, or `undefined` when it has them all.
 * Never throws.
 *
 * @param args - Git arguments (`-c user.*` pairs before the subcommand count as configured)
 * @param cwd - Checkout the command runs in
 * @param env - The command's full environment
 */
export async function commitIdentityEnv(
  args: readonly string[],
  cwd: string | undefined,
  env: Env,
  deps?: IdentityDeps,
): Promise<IdentityEnv | undefined> {
  try {
    const configured = readConfiguredIdentity(cwd, env, leadingConfigArgs(args));
    if (isIdentityComplete(configured)) return undefined;
    const identity = await resolveCommitIdentity(env, { cwd, deps });
    if (identity.source === "fallback" && !fallbackWarned) {
      fallbackWarned = true;
      (deps?.warn ?? testDeps.warn ?? console.warn)(
        `⚠️  Git has no commit identity on this host (${identity.reason}); committing as ` +
          `${identity.name} <${identity.email}>. To commit under your own name, ${COMMIT_IDENTITY_FIX}.`,
      );
    }
    return missingIdentityEnv(configured, identity);
  } catch {
    return undefined;
  }
}

/** Git's messages for a missing or unusable commit identity. */
const IDENTITY_ERROR =
  /Author identity unknown|Committer identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email address|name consists only of disallowed characters/i;
/** Git's messages when commit signing is configured but cannot run. */
const SIGNING_ERROR =
  /gpg failed to sign the data|cannot run gpg|error: (?:ssh-keygen|gpg)[^\n]*sign/i;

/**
 * A commit failure that is host configuration, not a hook or code problem the
 * agent could fix: a missing identity or broken commit signing. Returns a
 * one-line description with the fix, or `undefined` for anything else.
 */
export function classifyCommitConfigError(output: string): string | undefined {
  if (IDENTITY_ERROR.test(output)) {
    return `git has no commit identity on this host (${firstMatchLine(output, IDENTITY_ERROR)}). To fix, ${COMMIT_IDENTITY_FIX}`;
  }
  if (SIGNING_ERROR.test(output)) {
    return `commit signing is enabled but failed (${firstMatchLine(output, SIGNING_ERROR)}). Fix the signing key on the worker host or disable commit.gpgsign for this checkout`;
  }
  return undefined;
}

function firstMatchLine(output: string, pattern: RegExp): string {
  const line = output.split("\n").find((candidate) => pattern.test(candidate)) ?? "";
  return line.trim().replace(/^fatal:\s*/i, "");
}

let agentIdentity: IdentityEnv | undefined;

/**
 * Resolve the identity agent subprocesses get for commits they make
 * themselves (a hook-fix amend, an agent committing its own work) and keep it
 * for {@link agentCommitIdentityEnv}. `undefined` when git already has one
 * for `cwd`. Call once per run, before the agent starts.
 */
export async function primeAgentCommitIdentity(
  cwd: string,
  env: Env = process.env,
): Promise<IdentityEnv | undefined> {
  const identity = await commitIdentityEnv(["commit"], cwd, env);
  agentIdentity = identity && Object.keys(identity).length > 0 ? identity : undefined;
  if (agentIdentity) {
    const resolved = await resolveCommitIdentity(env, { cwd });
    console.log(
      `🪪 Git has no commit identity here; commits use ${describeCommitIdentity(resolved)}`,
    );
  }
  return agentIdentity;
}

/** The env {@link primeAgentCommitIdentity} resolved, if any. */
export function agentCommitIdentityEnv(): IdentityEnv | undefined {
  return agentIdentity;
}

/** Forget the primed agent identity (tests). */
export function resetAgentCommitIdentityForTests(): void {
  agentIdentity = undefined;
}
