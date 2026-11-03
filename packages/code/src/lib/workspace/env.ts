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
import {
  normalizeCodeHostUrl,
  parseGitLabHostAliases,
  parseGitRemoteUrl,
} from "../code-host/provider";

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

/**
 * Extract the GitLab API project path from a remote URL.
 *
 * Uses the canonical code-host parser so remotes resolve exactly as they do
 * for merge requests, relays, and worker connect (percent-decoding, subgroup
 * validation, and verified host aliases included). A remote only counts as
 * the tracker instance: `gitlab.com` remotes are ignored when `GITLAB_BASE_URL`
 * points at a self-managed instance, and self-managed remotes need a matching
 * base host and port (or a verified alias).
 *
 * @param remote - e.g. `git@gitlab.com:group/sub/repo.git`
 * @param baseUrl - Effective `GITLAB_BASE_URL`, with or without protocol.
 * @param hostAliases - SSH hostnames verified to alias the tracker instance.
 *                       Code-host aliases only qualify when the code host and
 *                       tracker resolve to the same URL (see {@link trackerHostAliases}).
 * @returns `group/sub/repo`, or null for non-GitLab remotes.
 */
export function gitLabProjectFromRemote(
  remote: string,
  baseUrl?: string,
  hostAliases: Iterable<string> = [],
): string | null {
  // Track the instance by host *and* port: `https://git.example.com:9443` is
  // not the tracker at `https://git.example.com:8443`, and its project path
  // must not be pinned against that instance.
  let baseHost: string | null = null;
  if (baseUrl?.trim()) {
    try {
      baseHost = new URL(normalizeCodeHostUrl(baseUrl)).host.toLowerCase();
    } catch {
      // An unusable base URL is a credential error; never guess the instance.
      return null;
    }
  }

  const parsed = parseGitRemoteUrl(remote, {
    gitlabBaseUrl: baseUrl,
    gitlabHostAliases: hostAliases,
    // The pin must not pair a project path from another port with the tracker.
    // Other parser consumers keep hostname matching for split git/web ports.
    requireHttpPort: true,
  });
  if (parsed?.provider !== "gitlab") return null;

  // A gitlab.com remote only belongs to this tracker when the tracker itself
  // is gitlab.com (or no base URL is configured). Otherwise the project path
  // would pair with a base URL from another host.
  const instanceHost = new URL(parsed.instanceUrl).host.toLowerCase();
  if (baseHost !== null && baseHost !== "gitlab.com" && instanceHost !== baseHost) {
    return null;
  }
  return parsed.projectPath;
}

/** Workspace/repo layer pairs used to compose and re-pin one repo environment. */
interface ComposedRepoEnv {
  env: Record<string, string | undefined>;
  /** `GITLAB_PROJECT` derived from the remote at the repo layers, if any. */
  derivedGitLabProject: string | null;
  /** Explicit repo-layer `GITLAB_PROJECT` (`env_file` or `[repos.env]`). */
  explicitGitLabProject: string | undefined;
}

/**
 * SSH host aliases that may classify a remote for the tracker pin.
 *
 * `GITLAB_CODE_HOST_ALIASES` aliases the *code host*, which can be a different
 * GitLab instance from `GITLAB_BASE_URL` (the tracker). Only when both URLs
 * resolve to the same instance may an alias identify a repo as belonging to
 * the tracker; otherwise an alias remote from the code host would be paired
 * with a project path on the tracker instance.
 */
function trackerHostAliases(env: Record<string, string | undefined>): string[] {
  const aliases = parseGitLabHostAliases(env.GITLAB_CODE_HOST_ALIASES);
  if (aliases.length === 0) return [];
  const baseUrl = env.GITLAB_BASE_URL?.trim();
  if (!baseUrl) return [];
  try {
    const codeHost = normalizeCodeHostUrl(env.GITLAB_CODE_HOST_URL?.trim() || "https://gitlab.com");
    return codeHost === normalizeCodeHostUrl(baseUrl) ? aliases : [];
  } catch {
    // An invalid code-host URL never widens which remotes belong to the tracker.
    return [];
  }
}

/**
 * Derive and pin `GITLAB_PROJECT` for one repo, or clear a stale derived pin.
 *
 * An explicit workspace, repo, or team value always wins: only a value this
 * function derived may be re-derived against a later layer, and
 * `previouslyPinned` identifies it. This keeps a workspace that centralizes
 * GitLab issues in one project from silently switching task runs to each
 * repo's code project.
 *
 * @returns The derived project path now present in `env`, or null.
 */
function applyGitLabProjectPin(
  env: Record<string, string | undefined>,
  repo: RepoConfig,
  options: {
    explicitProject?: string;
    previouslyPinned?: string | null;
  } = {},
): string | null {
  if (options.explicitProject) {
    return null;
  }
  const current = env.GITLAB_PROJECT;
  if (current && current !== options.previouslyPinned) {
    return null;
  }
  const derived = gitLabProjectFromRemote(
    repo.remote,
    env.GITLAB_BASE_URL,
    trackerHostAliases(env),
  );
  if (derived) {
    env.GITLAB_PROJECT = derived;
    return derived;
  }
  if (options.previouslyPinned && env.GITLAB_PROJECT === options.previouslyPinned) {
    delete env.GITLAB_PROJECT;
  }
  return null;
}

/**
 * Compose the environment for a task subprocess routed to one repo.
 *
 * Precedence (later wins): current process env < workspace `.env` < repo
 * `env_file` < inline `[repos.env]` < injected workspace values
 * (`WEBHOOK_QUEUE_DB`, workspace context, stable analytics config
 * directory, `GITHUB_REPO` for GitHub remotes and `GITLAB_PROJECT` for GitLab
 * remotes when no explicit workspace or repo value selects a project, and
 * `PR_LABELS` from the repo's `pr_labels` config).
 *
 * An explicit `GITLAB_PROJECT` from the workspace or repo layers is never
 * replaced: it may intentionally point the tracker at a different project
 * than the code repo (see {@link applyGitLabProjectPin}).
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
  return composeRepoEnv(repo, workspaceDir, options).env;
}

/** Compose one repo's environment plus the GitLab pin metadata callers re-derive. */
function composeRepoEnv(
  repo: RepoConfig,
  workspaceDir: string,
  options: { actionedSource?: string; pipelineDefaultFile?: string },
): ComposedRepoEnv {
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

  const explicitGitLabProject = repoFileEnv.GITLAB_PROJECT ?? repo.env.GITLAB_PROJECT;
  const derivedGitLabProject = applyGitLabProjectPin(env, repo, {
    explicitProject: explicitGitLabProject,
  });

  // Config-driven PR labels win over a PR_LABELS the repo env layers carried;
  // when the config sets none, an env-provided value survives untouched.
  if (repo.prLabels && repo.prLabels.length > 0) {
    env.PR_LABELS = repo.prLabels.join(",");
  }

  return { env, derivedGitLabProject, explicitGitLabProject };
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
 * Team layer applied over a repo environment: namespaced workspace values
 * (`<TRACKER>_<TEAM>_<SETTING>`) followed by the team's `env_file` and inline
 * overrides.
 *
 * Both layers must be applied together: the worker validates and polls with
 * {@link buildTeamEnv}, so a subprocess built without the namespaced values
 * (for example `GITLAB_PLATFORM_PROJECT`) would poll one tracker project and
 * then act on the repo-derived one.
 */
function teamOverlayEnv(
  workspaceEnv: Record<string, string>,
  team: TeamConfig,
  workspaceDir: string,
): Record<string, string> {
  return {
    ...namespacedTeamEnv(workspaceEnv, team),
    ...teamLayerEnv(team, workspaceDir),
  };
}

/**
 * Compose a team's own credential environment: workspace `.env`, then the
 * namespaced team values (`<TRACKER>_<TEAM>_<SETTING>`), then the team's
 * `env_file`, then inline team overrides.
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
    ...teamOverlayEnv(workspaceEnv, team, workspaceDir),
  };
}

/**
 * Compose the environment for a fleet task subprocess acquired by one team.
 *
 * Identical layering to {@link buildRepoEnv}, with the acquiring team's
 * credentials between the repo layers and the final pin:
 *
 * process env < workspace `.env` < repo `env_file` < `[repos.env]` <
 * namespaced workspace team values (`<TRACKER>_<TEAM>_<SETTING>`) < team
 * `env_file` < team inline < worker runtime paths and `TASK_TRACKER` pin.
 *
 * The team wins ties because its credentials describe the tracker that
 * acquired the task (status transitions must hit that board, even if a stale
 * single-repo config still carries another tracker's variables), and
 * `TASK_TRACKER` is pinned last so nothing can re-route the child CLI.
 *
 * Because the team layers can replace `GITLAB_BASE_URL`, the project derived
 * from the repo remote is re-derived against the team credentials: a pin that
 * no longer belongs to that instance is dropped instead of pairing a project
 * path with another host's API. An explicit repo or team `GITLAB_PROJECT`
 * always survives.
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
  const { env, derivedGitLabProject, explicitGitLabProject } = composeRepoEnv(
    repo,
    workspaceDir,
    options,
  );
  // Include the namespaced workspace team values here too, exactly as the
  // worker's own tracker client (`buildTeamEnv`) does; otherwise the poller and
  // the subprocess would resolve different tracker projects.
  const teamEnv = teamOverlayEnv(parseEnvFile(workspaceEnvPath(workspaceDir)), team, workspaceDir);
  Object.assign(env, teamEnv);
  pinWorkerRuntimeEnv(env, workspaceDir);
  // The team layer merged after the repo layers pinned the pipeline selection,
  // so re-pin it here: a team `env_file` or inline value must not re-route the
  // pipeline or resurrect a stale reference.
  pinPipelineEnv(env, repo, workspaceDir, options);
  // The team layer can also point `GITLAB_BASE_URL` at another instance, so the
  // project derived from the repo remote may belong to a different host. Re-derive
  // against the team credentials and drop the stale pin rather than send the
  // tracker to `<team base>/api/v4/projects/<project from another host>`.
  applyGitLabProjectPin(env, repo, {
    explicitProject: explicitGitLabProject ?? teamEnv.GITLAB_PROJECT,
    previouslyPinned: derivedGitLabProject,
  });
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
