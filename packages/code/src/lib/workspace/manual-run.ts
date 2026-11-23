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

import { existsSync } from "fs";

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
import { buildRepoCredentialEnv, buildRepoEnv } from "./env";
import { ensureWorkspaceCodeState, resolveWorkspaceDir, workspaceConfigPath } from "./paths";

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
    const options = remoteParseOptions(repo, workspaceDir);
    const current = parseGitRemoteUrl(origin.trim(), options);
    const registered = parseGitRemoteUrl(repo.remote, options);
    if (current && registered && sameRemoteProject(current, registered)) return repo;
  }
  return null;
}

/**
 * Resolve the workspace repository the checkout at `cwd` belongs to.
 *
 * Returns null inside worker task subprocesses (they already carry their
 * composed environment), without a `workspace.toml`, without an `origin`
 * remote, or when no `[[repos]]` entry matches. An invalid `workspace.toml`
 * is reported and treated as no match, so a manual run keeps working.
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
  if (!originResult.success) return null;

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (error) {
    console.warn(`⚠️  Ignoring ${configPath} for this run: ${(error as Error).message}`);
    return null;
  }
  const repo = findRepoForOrigin(config, originResult.output, workspaceDir);
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
export function applyManualWorkspaceRun(run: ManualWorkspaceRun): void {
  const pipelineDefaultFile = run.config.defaults.pipelineFile
    ? resolveWorkspacePipelinePath(run.workspaceDir, run.config.defaults.pipelineFile)
    : undefined;
  const env = buildRepoEnv(run.repo, run.workspaceDir, { pipelineDefaultFile });
  delete env[WORKER_SUBPROCESS_ENV];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env[WORKER_SUBPROCESS_ENV];
  ensureWorkspaceCodeState(run.workspaceDir);
  setManualWorkspaceStateDir(run.workspaceDir);
}
