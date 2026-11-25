/**
 * Manual CLI runs inside a checkout of a workspace repository.
 *
 * `devintern TASK-123` started in a checkout whose `origin` matches a
 * `[[repos]]` entry (manual-only or not) runs in place, but takes its
 * configuration and state from the workspace instead of the checkout's
 * `.devintern-code/`: the same env layers a worker task gets (shared `.env`,
 * the repo's `env_file` and `[repos.env]`, pipeline references), the
 * workspace queue DB, auth session, license cache, telemetry, and prompt
 * overrides. It stays a manual run: the worker-subprocess marker is not set.
 */

import { existsSync, realpathSync } from "fs";
import { resolve, sep } from "path";

import { parseGitLabHostAliases, parseGitRemoteUrl } from "../code-host";
import type { CodeHostRepository } from "../code-host";
import {
  isWorkerSubprocess,
  setManualWorkspaceStateDir,
  WORKER_SUBPROCESS_ENV,
} from "../config/config-dir";
import { Utils } from "../utils";
import { loadWorkspaceConfig, resolveWorkspacePipelinePath } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { ANALYTICS_CONFIG_DIR_ENV } from "../observability/analytics";
import {
  buildRepoCredentialEnv,
  buildRepoEnv,
  WORKSPACE_PIPELINE_DEFAULT_ENV,
  WORKSPACE_PIPELINE_REPO_ENV,
  WORKSPACE_REPO_ENV,
} from "./env";
import { ensureWorkspaceCodeState, resolveWorkspaceDir, workspaceConfigPath } from "./paths";

/** Workspace state and pipeline keys a manual run takes even with `--env-file`. */
const RUNTIME_KEYS = [
  "WEBHOOK_QUEUE_DB",
  "DEVINTERN_WORKSPACE_DIR",
  WORKSPACE_REPO_ENV,
  ANALYTICS_CONFIG_DIR_ENV,
  WORKSPACE_PIPELINE_REPO_ENV,
  WORKSPACE_PIPELINE_DEFAULT_ENV,
];

/** A workspace repository a manual run in the current checkout belongs to. */
export interface ManualWorkspaceRun {
  workspaceDir: string;
  config: WorkspaceConfig;
  repo: RepoConfig;
}

/** Remote URL parse options for one repo (GitLab instance and host aliases). */
export function remoteParseOptions(repo: RepoConfig, workspaceDir: string) {
  const credentials = buildRepoCredentialEnv(repo, workspaceDir);
  return {
    gitlabBaseUrl: credentials.GITLAB_CODE_HOST_URL ?? process.env.GITLAB_CODE_HOST_URL,
    gitlabHostAliases: parseGitLabHostAliases(
      credentials.GITLAB_CODE_HOST_ALIASES ?? process.env.GITLAB_CODE_HOST_ALIASES,
    ),
  };
}

/** Whether two parsed remotes name the same project on the same host. */
type RemoteProject = Pick<CodeHostRepository, "provider" | "instanceUrl" | "projectPath">;

export function sameRemoteProject(a: RemoteProject, b: RemoteProject): boolean {
  const path = (value: string) => (a.provider === "github" ? value.toLowerCase() : value);
  return (
    a.provider === b.provider &&
    a.instanceUrl === b.instanceUrl &&
    path(a.projectPath) === path(b.projectPath)
  );
}

/**
 * Find the `[[repos]]` entry whose remote names the same project as `origin`.
 *
 * @returns The first matching repo, or null when none matches
 */
export function findRepoForOrigin(
  config: WorkspaceConfig,
  origin: string,
  workspaceDir: string,
): RepoConfig | null {
  for (const repo of config.repos) {
    if (!repo.remote) continue;
    const options = remoteParseOptions(repo, workspaceDir);
    const current = parseGitRemoteUrl(origin.trim(), options);
    const registered = parseGitRemoteUrl(repo.remote, options);
    if (current && registered && sameRemoteProject(current, registered)) return repo;
  }
  return null;
}

/** Real path of a directory, or its resolved path when it cannot be read. */
function realDir(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/**
 * Find the path-registered repo whose directory is `dir` or contains it
 * (the deepest one wins, so nested checkouts resolve to their own entry).
 */
export function findRepoForPath(config: WorkspaceConfig, dir: string): RepoConfig | null {
  const target = realDir(dir);
  let best: { repo: RepoConfig; length: number } | null = null;
  for (const repo of config.repos) {
    if (!repo.path) continue;
    const root = realDir(repo.path);
    if (target !== root && !target.startsWith(root + sep)) continue;
    if (!best || root.length > best.length) best = { repo, length: root.length };
  }
  return best?.repo ?? null;
}

/**
 * Find the entry for a checkout: by its `origin` remote first, then by a
 * path-registered entry containing `dir`.
 */
export function findRepoForCheckout(
  config: WorkspaceConfig,
  checkout: { origin: string | null; dir: string },
  workspaceDir: string,
): RepoConfig | null {
  const byOrigin = checkout.origin
    ? findRepoForOrigin(config, checkout.origin, workspaceDir)
    : null;
  return byOrigin ?? findRepoForPath(config, checkout.dir);
}

/**
 * Resolve the workspace repository the checkout at `cwd` belongs to.
 *
 * Returns null inside worker task subprocesses (they already carry their
 * composed environment), without a `workspace.toml`, or when no `[[repos]]`
 * entry matches the checkout's `origin` or directory. An invalid
 * `workspace.toml` is reported and treated as no match, so a manual run
 * keeps working.
 */
export async function findWorkspaceRepoForCheckout(
  options: { cwd?: string; workspaceDir?: string } = {},
): Promise<ManualWorkspaceRun | null> {
  if (isWorkerSubprocess()) return null;
  const workspaceDir = options.workspaceDir ?? resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return null;

  const originResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
    cwd: options.cwd,
  });
  const origin = originResult.success && originResult.output.trim() ? originResult.output : null;

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (error) {
    console.warn(`⚠️  Ignoring ${configPath} for this run: ${(error as Error).message}`);
    return null;
  }
  const repo = findRepoForCheckout(
    config,
    { origin, dir: options.cwd ?? process.cwd() },
    workspaceDir,
  );
  return repo ? { workspaceDir, config, repo } : null;
}

/**
 * Apply the workspace repo's environment and state locations to this process.
 *
 * Layers match a worker task (`buildRepoEnv`): workspace values win over the
 * shell, the repo's `env_file` and `[repos.env]` over the shared `.env`. The
 * worker-subprocess marker is removed so the run keeps manual semantics
 * (interactive prompts, telemetry, the checkout's own git state).
 */
export function applyManualWorkspaceRun(
  run: ManualWorkspaceRun,
  options: {
    /**
     * Apply only the runtime and pipeline keys, never the env layers. Set
     * with `--env-file`, which must stay the only source of credentials and
     * tracker settings for the run.
     */
    runtimeOnly?: boolean;
    /**
     * Create `<workspace>/state/code/` and move legacy `.devintern-code/`
     * state into it (default true). Read-only commands pass false so they
     * never write to the workspace.
     */
    ensureState?: boolean;
  } = {},
): void {
  const pipelineDefaultFile = run.config.defaults.pipelineFile
    ? resolveWorkspacePipelinePath(run.workspaceDir, run.config.defaults.pipelineFile)
    : undefined;
  const env = buildRepoEnv(run.repo, run.workspaceDir, { pipelineDefaultFile });
  delete env[WORKER_SUBPROCESS_ENV];
  // An explicit WEBHOOK_QUEUE_DB is a documented override; only worker tasks
  // are forced onto the workspace DB.
  if (process.env.WEBHOOK_QUEUE_DB) env.WEBHOOK_QUEUE_DB = process.env.WEBHOOK_QUEUE_DB;
  const keys = options.runtimeOnly ? RUNTIME_KEYS : Object.keys(env);
  for (const key of keys) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env[WORKER_SUBPROCESS_ENV];
  if (options.ensureState !== false) ensureWorkspaceCodeState(run.workspaceDir);
  setManualWorkspaceStateDir(run.workspaceDir);
}
