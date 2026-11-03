/**
 * Per-repo environment composition for fleet task subprocesses.
 *
 * A workspace has one shared `.env`; each repo can layer an `env_file` and
 * inline `[repos.env]` overrides on top. The composed environment also pins
 * `WEBHOOK_QUEUE_DB` to the central workspace database and passes workspace
 * context to each task subprocess. The subprocess resolves auth and license
 * state in the workspace rather than its throwaway checkout.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

import type { ErrorMonitorConfig, RepoConfig, TeamConfig } from "./config";
import { resolveWorkspaceDir, workspaceDbPath, workspaceEnvPath } from "./paths";
import { ANALYTICS_CONFIG_DIR_ENV } from "../observability/analytics";
import { WORKER_SUBPROCESS_ENV } from "../config/config-dir";

export const WORKSPACE_REPO_ENV = "DEVINTERN_WORKSPACE_REPO";
export const WORKSPACE_TEAM_ENV = "DEVINTERN_WORKSPACE_TEAM";

/**
 * Absolute path of a repository's workspace-level pipeline override.
 *
 * The worker resolves a repo's `pipeline_file` against the workspace directory
 * and pins the absolute path here for the task subprocess. The subprocess
 * selects between this, the repo's `settings.json` pipeline, and the workspace
 * default (see {@link WORKSPACE_PIPELINE_DEFAULT_ENV}).
 */
export const WORKSPACE_PIPELINE_REPO_ENV = "DEVINTERN_WORKSPACE_PIPELINE_REPO";

/** Absolute path of the workspace-wide default pipeline definition. */
export const WORKSPACE_PIPELINE_DEFAULT_ENV = "DEVINTERN_WORKSPACE_PIPELINE_DEFAULT";

/**
 * Explicit actioned-ticket source key pinned into a task subprocess.
 *
 * The workspace gate is built from `[defaults].tracker`/team identity, while
 * the subprocess records with `TASK_TRACKER`/`DEVINTERN_WORKSPACE_TEAM`. Those
 * can disagree when a stale `.env` carries a different tracker (or a shell
 * `DEVINTERN_WORKSPACE_TEAM` leaks into a single-source workspace), which
 * silently disables suppression. Pinning the derived key removes the guesswork.
 */
export const ACTIONED_SOURCE_ENV = "DEVINTERN_ACTIONED_SOURCE";

/**
 * Parse a dotenv-style file into a record (same semantics as the tracker
 * config loader: `KEY=value`, `#` comments, optional single/double quotes).
 * Missing files yield an empty record.
 */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [key, ...valueParts] = trimmed.split("=");
    if (!key || valueParts.length === 0) {
      continue;
    }
    let value = valueParts.join("=").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key.trim()] = value;
  }
  return env;
}

/** Apply shared workspace values to the worker process before its license gate. */
export function applyWorkspaceProcessEnv(workspaceDir: string): void {
  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    process.env[key] = value;
  }
}

/** Workspace and per-repo values without worker-only runtime path markers. */
export function buildRepoCredentialEnv(
  repo: RepoConfig,
  workspaceDir: string,
): Record<string, string> {
  const repoFileEnv = repo.envFile
    ? parseEnvFile(isAbsolute(repo.envFile) ? repo.envFile : join(workspaceDir, repo.envFile))
    : {};
  return {
    ...parseEnvFile(workspaceEnvPath(workspaceDir)),
    ...repoFileEnv,
    ...repo.env,
  };
}

/**
 * Extract the `owner/repo` slug from a GitHub remote URL.
 *
 * @param remote - e.g. `git@github.com:acme/backend.git` or
 *                 `https://github.com/acme/backend`
 * @returns The slug, or null for non-GitHub remotes.
 */
export function gitHubSlugFromRemote(remote: string): string | null {
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? null;
}

interface RemoteLocation {
  host: string;
  path: string;
}

/** Parse a Git remote or base URL into a lower-case host and path. */
function parseRemoteLocation(value: string, assumeHttps: boolean): RemoteLocation | null {
  let trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("://")) {
    if (!assumeHttps) {
      // SCP-style remote: `git@host:group/repo.git` (the user is optional).
      const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
      if (!scp?.[1] || !scp[2]) return null;
      return { host: scp[1].toLowerCase(), path: scp[2] };
    }
    trimmed = `https://${trimmed}`;
  }
  try {
    const url = new URL(trimmed);
    return { host: url.hostname.toLowerCase(), path: url.pathname.replace(/^\/+/, "") };
  } catch {
    return null;
  }
}

/** Normalize a GitLab project path: no `.git`, no leading/trailing slashes. */
function normalizeGitLabProjectPath(path: string): string | null {
  let normalized = path.trim().replace(/^\/+|\/+$/g, "");
  normalized = normalized.replace(/\.git$/i, "").replace(/\/+$/g, "");
  return normalized || null;
}

/**
 * Extract the GitLab API project path from a remote URL.
 *
 * Only `gitlab.com` and hosts matching `GITLAB_BASE_URL` are treated as
 * GitLab; without a base URL, self-managed hosts are left alone.
 *
 * @param remote - e.g. `git@gitlab.com:group/sub/repo.git`
 * @param baseUrl - Effective `GITLAB_BASE_URL`, with or without protocol.
 * @returns `group/sub/repo`, or null for non-GitLab remotes.
 */
export function gitLabProjectFromRemote(remote: string, baseUrl?: string): string | null {
  const location = parseRemoteLocation(remote, false);
  if (!location) return null;
  const base = baseUrl ? parseRemoteLocation(baseUrl, true) : null;
  const isGitLabHost =
    location.host === "gitlab.com" || (base !== null && location.host === base.host);
  if (!isGitLabHost) return null;

  let projectPath = location.path;
  // A self-managed instance may live under a path prefix (`https://host/gitlab`).
  if (base !== null && base.host === location.host && base.path) {
    const prefix = base.path.replace(/\/+$/g, "");
    if (prefix && projectPath.startsWith(`${prefix}/`)) {
      projectPath = projectPath.slice(prefix.length + 1);
    }
  }
  return normalizeGitLabProjectPath(projectPath);
}

/**
 * Compose the environment for a task subprocess routed to one repo.
 *
 * Precedence (later wins): current process env < workspace `.env` < repo
 * `env_file` < inline `[repos.env]` < injected workspace values
 * (`WEBHOOK_QUEUE_DB`, workspace context, stable analytics config
 * directory, `GITHUB_REPO` for GitHub remotes and `GITLAB_PROJECT` for GitLab
 * remotes unless the repo layers already set them, and `PR_LABELS` from the
 * repo's `pr_labels` config).
 *
 * @param repo - Workspace repo the task routed to.
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 * @param options.actionedSource - Actioned-ticket source key to pin (see
 *                                 {@link ACTIONED_SOURCE_ENV}).
 * @param options.pipelineDefaultFile - Absolute path of the workspace default
 *                                      pipeline file, if one is configured.
 * @returns Environment record to pass to `runTaskViaCli` / `runAddressReviewViaCli`.
 */
export function buildRepoEnv(
  repo: RepoConfig,
  workspaceDir: string = resolveWorkspaceDir(),
  options: { actionedSource?: string; pipelineDefaultFile?: string } = {},
): Record<string, string | undefined> {
  const workspaceEnv = parseEnvFile(workspaceEnvPath(workspaceDir));
  const repoFileEnv = repo.envFile
    ? parseEnvFile(isAbsolute(repo.envFile) ? repo.envFile : join(workspaceDir, repo.envFile))
    : {};

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...workspaceEnv,
    ...repoFileEnv,
    ...repo.env,
  };

  // The subprocess runs in a throwaway worktree; keep runtime paths out of it.
  pinWorkerRuntimeEnv(env, workspaceDir);
  env[WORKSPACE_REPO_ENV] = repo.name;
  pinPipelineEnv(env, repo, workspaceDir, options);
  // `buildTeamTaskEnv` sets the team after layering; a non-team repo env must
  // never inherit a team name leaked from the shell.
  delete env[WORKSPACE_TEAM_ENV];
  if (options.actionedSource) {
    env[ACTIONED_SOURCE_ENV] = options.actionedSource;
  }

  if (!repoFileEnv.GITHUB_REPO && !repo.env.GITHUB_REPO) {
    const slug = gitHubSlugFromRemote(repo.remote);
    if (slug) {
      env.GITHUB_REPO = slug;
    }
  }

  if (!repoFileEnv.GITLAB_PROJECT && !repo.env.GITLAB_PROJECT) {
    const project = gitLabProjectFromRemote(repo.remote, env.GITLAB_BASE_URL);
    if (project) {
      env.GITLAB_PROJECT = project;
    }
  }

  // Config-driven PR labels win over a PR_LABELS the repo env layers carried;
  // when the config sets none, an env-provided value survives untouched.
  if (repo.prLabels && repo.prLabels.length > 0) {
    env.PR_LABELS = repo.prLabels.join(",");
  }

  return env;
}

/**
 * Clear and pin the workspace pipeline references for one repo.
 *
 * A task subprocess inherits the worker's process env (and, for a team task,
 * the team credential layers), so stale `DEVINTERN_WORKSPACE_PIPELINE_REPO` /
 * `DEVINTERN_WORKSPACE_PIPELINE_DEFAULT` values must be cleared before pinning
 * this repo's selection. Callers re-run this after every later layer so no
 * team `env_file` or inline `[teams.env]` value can re-route the pipeline.
 */
function pinPipelineEnv(
  env: Record<string, string | undefined>,
  repo: RepoConfig,
  workspaceDir: string,
  options: { pipelineDefaultFile?: string },
): void {
  delete env[WORKSPACE_PIPELINE_REPO_ENV];
  delete env[WORKSPACE_PIPELINE_DEFAULT_ENV];
  if (repo.pipelineFile) {
    env[WORKSPACE_PIPELINE_REPO_ENV] = isAbsolute(repo.pipelineFile)
      ? repo.pipelineFile
      : join(workspaceDir, repo.pipelineFile);
  }
  if (options.pipelineDefaultFile) {
    env[WORKSPACE_PIPELINE_DEFAULT_ENV] = options.pipelineDefaultFile;
  }
}

/** Team-only credential layers, excluding the shared workspace environment. */
function teamLayerEnv(team: TeamConfig, workspaceDir: string): Record<string, string> {
  const teamFileEnv = team.envFile
    ? parseEnvFile(isAbsolute(team.envFile) ? team.envFile : join(workspaceDir, team.envFile))
    : {};
  return { ...teamFileEnv, ...team.env };
}

/** Convert a team name to the uppercase env namespace used in workspace `.env`. */
function teamEnvNamespace(teamName: string): string {
  return teamName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/**
 * Project tracker/team-namespaced workspace variables onto the normal tracker
 * variable names. For example, `JIRA_PLATFORM_API_TOKEN` becomes
 * `JIRA_API_TOKEN` for team `platform`. `JIRA_PLATFORM_URL` is also accepted
 * as the concise alias for the existing `JIRA_BASE_URL` setting.
 */
function namespacedTeamEnv(
  workspaceEnv: Record<string, string>,
  team: TeamConfig,
): Record<string, string> {
  const trackerPrefix = team.tracker.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  const namespace = `${trackerPrefix}_${teamEnvNamespace(team.name)}_`;
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
 * Compose a team's own credential environment: workspace `.env`, then the
 * team's `env_file`, then inline team overrides.
 *
 * Used both for building the team's tracker client/detector in the worker
 * process and as a layer inside {@link buildTeamTaskEnv}.
 *
 * @param team - Team whose credentials to layer.
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 */
export function buildTeamEnv(
  team: TeamConfig,
  workspaceDir: string = resolveWorkspaceDir(),
): Record<string, string> {
  const workspaceEnv = parseEnvFile(workspaceEnvPath(workspaceDir));
  return {
    ...workspaceEnv,
    ...namespacedTeamEnv(workspaceEnv, team),
    ...teamLayerEnv(team, workspaceDir),
  };
}

/**
 * Compose the environment for a fleet task subprocess acquired by one team.
 *
 * Identical layering to {@link buildRepoEnv}, with the acquiring team's
 * credentials between the repo layers and the final pin:
 *
 * process env < workspace `.env` < repo `env_file` < `[repos.env]` <
 * team `env_file` < team inline < worker runtime paths and `TASK_TRACKER` pin.
 *
 * The team wins ties because its credentials describe the tracker that
 * acquired the task (status transitions must hit that board, even if a stale
 * single-repo config still carries another tracker's variables), and
 * `TASK_TRACKER` is pinned last so nothing can re-route the child CLI.
 *
 * @param repo - Workspace repo the task routed to.
 * @param team - Team that acquired the task.
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 * @param options.actionedSource - Actioned-ticket source key to pin (see
 *                                 {@link ACTIONED_SOURCE_ENV}).
 */
export function buildTeamTaskEnv(
  repo: RepoConfig,
  team: TeamConfig,
  workspaceDir: string = resolveWorkspaceDir(),
  options: { actionedSource?: string; pipelineDefaultFile?: string } = {},
): Record<string, string | undefined> {
  const env = buildRepoEnv(repo, workspaceDir, options);
  Object.assign(env, teamLayerEnv(team, workspaceDir));
  pinWorkerRuntimeEnv(env, workspaceDir);
  // The team layer merged after `buildRepoEnv` pinned the pipeline selection,
  // so re-pin it here: a team `env_file` or inline value must not re-route the
  // pipeline or resurrect a stale reference.
  pinPipelineEnv(env, repo, workspaceDir, options);
  env.TASK_TRACKER = team.tracker;
  env[WORKSPACE_TEAM_ENV] = team.name;
  return env;
}

/**
 * Compose credentials and task context for one error-monitor source.
 *
 * Precedence: process < workspace < repo < team < source env_file < source
 * inline env. Source-local layers let two Sentry projects use different auth
 * tokens without leaking either token into another repository's runs.
 */
export function buildErrorMonitorEnv(
  source: ErrorMonitorConfig,
  repo: RepoConfig,
  team: TeamConfig | undefined,
  workspaceDir: string = resolveWorkspaceDir(),
): Record<string, string | undefined> {
  const env = team ? buildTeamTaskEnv(repo, team, workspaceDir) : buildRepoEnv(repo, workspaceDir);
  const sourceFileEnv = source.envFile
    ? parseEnvFile(isAbsolute(source.envFile) ? source.envFile : join(workspaceDir, source.envFile))
    : {};
  const result = { ...env, ...sourceFileEnv, ...source.env };
  pinWorkerRuntimeEnv(result, workspaceDir);
  return result;
}

/**
 * Compose the environment for a workspace-context run that has no repository
 * (automations, estimations): the current process env with the worker runtime
 * paths pinned, so the child resolves auth and license state in the workspace.
 *
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 */
export function buildWorkspaceContextEnv(
  workspaceDir: string = resolveWorkspaceDir(),
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  pinWorkerRuntimeEnv(env, workspaceDir);
  return env;
}

/** Keep worker-owned paths and the subprocess marker above credential layers. */
function pinWorkerRuntimeEnv(env: Record<string, string | undefined>, workspaceDir: string): void {
  env.WEBHOOK_QUEUE_DB = workspaceDbPath(workspaceDir);
  env[ANALYTICS_CONFIG_DIR_ENV] = workspaceDir;
  env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
  env[WORKER_SUBPROCESS_ENV] = "1";
}
