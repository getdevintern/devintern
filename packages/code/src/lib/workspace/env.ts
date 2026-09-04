/**
 * Per-repo environment composition for fleet task subprocesses.
 *
 * A workspace has one shared `.env`; each repo can layer an `env_file` and
 * inline `[repos.env]` overrides on top. The composed environment also pins
 * `WEBHOOK_QUEUE_DB` to the central workspace database, so the task
 * subprocess (which runs in a throwaway worktree) writes its queue state,
 * cursors, agent PRs, and run records to the shared fleet DB instead of a
 * per-worktree `.devintern-code/queue.db`.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

import type { ErrorMonitorConfig, RepoConfig, TeamConfig } from "./config";
import { resolveWorkspaceDir, workspaceDbPath, workspaceEnvPath } from "./paths";
import { ANALYTICS_CONFIG_DIR_ENV } from "../analytics";

export const WORKSPACE_REPO_ENV = "DEVINTERN_WORKSPACE_REPO";
export const WORKSPACE_TEAM_ENV = "DEVINTERN_WORKSPACE_TEAM";

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
 * Compose the environment for a task subprocess routed to one repo.
 *
 * Precedence (later wins): current process env < workspace `.env` < repo
 * `env_file` < inline `[repos.env]` < injected workspace values
 * (`WEBHOOK_QUEUE_DB`, stable analytics config directory, `GITHUB_REPO`
 * for GitHub remotes unless the repo layers already set it, and `PR_LABELS`
 * from the repo's `pr_labels` config).
 *
 * @param repo - Workspace repo the task routed to.
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 * @returns Environment record to pass to `runTaskViaCli` / `runAddressReviewViaCli`.
 */
export function buildRepoEnv(
  repo: RepoConfig,
  workspaceDir: string = resolveWorkspaceDir(),
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

  env.WEBHOOK_QUEUE_DB = workspaceDbPath(workspaceDir);
  env[ANALYTICS_CONFIG_DIR_ENV] = workspaceDir;
  env[WORKSPACE_REPO_ENV] = repo.name;

  if (!repoFileEnv.GITHUB_REPO && !repo.env.GITHUB_REPO) {
    const slug = gitHubSlugFromRemote(repo.remote);
    if (slug) {
      env.GITHUB_REPO = slug;
    }
  }

  // Config-driven PR labels win over a PR_LABELS the repo env layers carried;
  // when the config sets none, an env-provided value survives untouched.
  if (repo.prLabels && repo.prLabels.length > 0) {
    env.PR_LABELS = repo.prLabels.join(",");
  }

  return env;
}

/** Team-only credential layers, excluding the shared workspace environment. */
function teamLayerEnv(team: TeamConfig, workspaceDir: string): Record<string, string> {
  const teamFileEnv = team.envFile
    ? parseEnvFile(isAbsolute(team.envFile) ? team.envFile : join(workspaceDir, team.envFile))
    : {};
  return { ...teamFileEnv, ...team.env };
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
  return {
    ...parseEnvFile(workspaceEnvPath(workspaceDir)),
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
 * team `env_file` < team inline < `TASK_TRACKER` pin.
 *
 * The team wins ties because its credentials describe the tracker that
 * acquired the task (status transitions must hit that board, even if a stale
 * single-repo config still carries another tracker's variables), and
 * `TASK_TRACKER` is pinned last so nothing can re-route the child CLI.
 *
 * @param repo - Workspace repo the task routed to.
 * @param team - Team that acquired the task.
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 */
export function buildTeamTaskEnv(
  repo: RepoConfig,
  team: TeamConfig,
  workspaceDir: string = resolveWorkspaceDir(),
): Record<string, string | undefined> {
  const env = buildRepoEnv(repo, workspaceDir);
  Object.assign(env, teamLayerEnv(team, workspaceDir));
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
  return { ...env, ...sourceFileEnv, ...source.env };
}
