/**
 * The `[[repos]]` part of `workspace.toml`, read leniently.
 *
 * DevIntern Code validates the whole file when its worker starts. Other
 * products (`devpm`, the desktop app) only need to know whether a checkout is
 * registered and which credentials it uses, so entries they cannot use are
 * skipped instead of failing the read.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { parse } from "smol-toml";

import { readEnvFile } from "./env-file.ts";
import { workspaceConfigPath, workspaceEnvPath } from "./paths.ts";

/** One `[[repos]]` entry. */
export interface WorkspaceRepo {
  name: string;
  /** Git remote URL the entry is keyed by. */
  remote?: string;
  /** Absolute checkout directory (manual-only entries without a usable remote). */
  path?: string;
  /** Per-repo env file, absolute or relative to the workspace home. */
  envFile?: string;
  /** Inline `[repos.env]` values. */
  env: Record<string, string>;
  /** Run by hand only; the worker skips it. */
  manualOnly: boolean;
}

/** One `[[teams]]` entry. */
export interface WorkspaceTeam {
  name: string;
  /** The team's tracker; falls back to `[defaults].tracker`. */
  tracker?: string;
  /** Fixed destination repo (`[[repos]]` name); unset for a multi-repo team. */
  repo?: string;
  /** Team env file, absolute or relative to the workspace home. */
  envFile?: string;
  /** Inline `[teams.env]` values. */
  env: Record<string, string>;
}

/** What other products read from `workspace.toml`. */
export interface WorkspaceFile {
  repos: WorkspaceRepo[];
  teams: WorkspaceTeam[];
  /** `[defaults].tracker`, when set. */
  defaultTracker?: string;
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEnvTable(raw: Table): Record<string, string> {
  const env: Record<string, string> = {};
  if (isTable(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return env;
}

function readRepo(raw: unknown): WorkspaceRepo | null {
  if (!isTable(raw)) return null;
  const name = nonEmptyString(raw.name);
  if (!name) return null;
  const env = readEnvTable(raw);
  const path = nonEmptyString(raw.path);
  return {
    name,
    remote: nonEmptyString(raw.remote),
    path: path && isAbsolute(path) ? path : undefined,
    envFile: nonEmptyString(raw.env_file),
    env,
    manualOnly: raw.manual_only === true,
  };
}

function readTeam(raw: unknown, defaultTracker: string | undefined): WorkspaceTeam | null {
  if (!isTable(raw)) return null;
  const name = nonEmptyString(raw.name);
  if (!name) return null;
  const tracker = nonEmptyString(raw.tracker) ?? defaultTracker;
  const repo = nonEmptyString(raw.repo);
  const envFile = nonEmptyString(raw.env_file);
  return {
    name,
    ...(tracker ? { tracker } : {}),
    ...(repo ? { repo } : {}),
    ...(envFile ? { envFile } : {}),
    env: readEnvTable(raw),
  };
}

/**
 * Parse `workspace.toml` text.
 *
 * @throws When the text is not valid TOML
 */
export function parseWorkspaceFile(text: string): WorkspaceFile {
  const document = parse(text) as Table;
  const repos = Array.isArray(document.repos)
    ? document.repos.map(readRepo).filter((repo): repo is WorkspaceRepo => repo !== null)
    : [];
  const defaults = isTable(document.defaults) ? document.defaults : {};
  const defaultTracker = nonEmptyString(defaults.tracker);
  const teams = Array.isArray(document.teams)
    ? document.teams
        .map((raw) => readTeam(raw, defaultTracker))
        .filter((team): team is WorkspaceTeam => team !== null)
    : [];
  return { repos, teams, ...(defaultTracker ? { defaultTracker } : {}) };
}

/**
 * Read the workspace's `workspace.toml`.
 *
 * @param workspaceDir - Workspace home
 * @returns Null when the file is missing, unreadable, or not valid TOML
 */
export function readWorkspaceFile(workspaceDir: string): WorkspaceFile | null {
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return null;
  try {
    return parseWorkspaceFile(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Reduce a git remote URL to `host/path` for comparison: no user, protocol,
 * port, `.git` suffix, or surrounding slashes. GitHub remotes are compared
 * case-insensitively, as GitHub treats them.
 *
 * @returns Null for local paths and URLs without a host
 */
export function normalizeRemote(remote: string): string | null {
  const trimmed = remote.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.protocol === "file:" || !url.hostname) return null;
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path) return null;
  host = host.toLowerCase();
  const key = `${host}/${path}`;
  return host === "github.com" ? key.toLowerCase() : key;
}

function realDir(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/**
 * Find the entry for a checkout: the first whose `remote` names the same
 * project as `origin`, else the deepest path-registered entry containing `dir`.
 */
export function matchWorkspaceRepo(
  repos: readonly WorkspaceRepo[],
  checkout: { origin: string | null; dir: string },
): WorkspaceRepo | null {
  const origin = checkout.origin ? normalizeRemote(checkout.origin) : null;
  if (origin) {
    const byRemote = repos.find((repo) => repo.remote && normalizeRemote(repo.remote) === origin);
    if (byRemote) return byRemote;
  }
  const target = realDir(checkout.dir);
  let best: { repo: WorkspaceRepo; length: number } | null = null;
  for (const repo of repos) {
    if (!repo.path) continue;
    const root = realDir(repo.path);
    if (target !== root && !target.startsWith(root + sep)) continue;
    if (!best || root.length > best.length) best = { repo, length: root.length };
  }
  return best?.repo ?? null;
}

/**
 * The team whose credentials a repo's runs layer when no team is named: the
 * one `[[teams]]` entry fixed to the repo (`repo = "<name>"`). Zero or several
 * fixed teams give none, since picking one of several could use the wrong
 * account. Same rule as DevIntern Code's credential team resolution.
 */
export function repoCredentialTeam(
  teams: readonly WorkspaceTeam[],
  repoName: string,
): WorkspaceTeam | null {
  const fixed = teams.filter((team) => team.repo === repoName);
  return fixed.length === 1 ? fixed[0]! : null;
}

function envNamespacePart(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/**
 * Project `<TRACKER>_<TEAM>_<SETTING>` workspace values onto the plain tracker
 * names (`JIRA_PLATFORM_API_TOKEN` becomes `JIRA_API_TOKEN` for team
 * `platform`; `JIRA_<TEAM>_URL` also sets `JIRA_BASE_URL`).
 */
export function namespacedTeamEnv(
  workspaceEnv: Record<string, string>,
  team: Pick<WorkspaceTeam, "name" | "tracker">,
): Record<string, string> {
  if (!team.tracker) return {};
  const trackerPrefix = envNamespacePart(team.tracker);
  const namespace = `${trackerPrefix}_${envNamespacePart(team.name)}_`;
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(workspaceEnv)) {
    if (!key.startsWith(namespace)) continue;
    const suffix = key.slice(namespace.length);
    projected[`${trackerPrefix}_${suffix}`] = value;
    if (trackerPrefix === "JIRA" && suffix === "URL") projected.JIRA_BASE_URL = value;
  }
  return projected;
}

/**
 * The layers a team adds over a repo's credentials, later winning: its
 * namespaced workspace values, its `env_file`, then its inline `[teams.env]`.
 * `TASK_TRACKER` is the team's tracker, as for the tasks the team polls.
 *
 * @param workspaceEnv - The shared workspace `.env`, already read
 */
export function teamCredentialEnv(
  team: WorkspaceTeam,
  workspaceDir: string,
  workspaceEnv: Record<string, string>,
  readEnv: (path: string) => Record<string, string> = readEnvFile,
): Record<string, string> {
  const teamFileEnv = team.envFile
    ? readEnv(isAbsolute(team.envFile) ? team.envFile : join(workspaceDir, team.envFile))
    : {};
  return {
    ...namespacedTeamEnv(workspaceEnv, team),
    ...teamFileEnv,
    ...team.env,
    ...(team.tracker ? { TASK_TRACKER: team.tracker } : {}),
  };
}

/**
 * A repo's credential layers, later winning: the shared workspace `.env`, the
 * repo's `env_file`, then its inline `[repos.env]`.
 *
 * @param readEnv - Reads one env file; defaults to the lenient
 *                  {@link readEnvFile}. The worker passes a reader that throws
 *                  on an unreadable file instead of dropping its credentials.
 */
export function repoCredentialEnv(
  repo: Pick<WorkspaceRepo, "envFile" | "env">,
  workspaceDir: string,
  readEnv: (path: string) => Record<string, string> = readEnvFile,
): Record<string, string> {
  const repoFileEnv = repo.envFile
    ? readEnv(isAbsolute(repo.envFile) ? repo.envFile : join(workspaceDir, repo.envFile))
    : {};
  return { ...readEnv(workspaceEnvPath(workspaceDir)), ...repoFileEnv, ...repo.env };
}
