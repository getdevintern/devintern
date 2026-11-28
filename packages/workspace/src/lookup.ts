import { execFile } from "node:child_process";

import { readEnvFile } from "./env-file.ts";
import { resolveWorkspaceDir, workspaceEnvPath } from "./paths.ts";
import {
  matchWorkspaceRepo,
  readWorkspaceFile,
  repoCredentialEnv,
  repoCredentialTeam,
  teamCredentialEnv,
} from "./repos.ts";
import type { WorkspaceRepo, WorkspaceTeam } from "./repos.ts";

/** A checkout's entry in the DevIntern workspace. */
export interface WorkspaceRepoMatch {
  workspaceDir: string;
  repo: WorkspaceRepo;
  /** The one team fixed to the repo, whose credentials {@link env} includes. */
  team?: WorkspaceTeam;
  /**
   * The repo's credential env (see {@link repoCredentialEnv}), with the
   * layers of its single fixed team on top (see {@link teamCredentialEnv})
   * when it has exactly one. `TASK_TRACKER` falls back to `[defaults].tracker`
   * when no env layer sets it.
   */
  env: Record<string, string>;
}

/**
 * Read a checkout's `origin` remote URL.
 *
 * @returns The URL, or null outside a git repo, without an `origin`, or
 *          without git installed
 */
export function readOriginRemote(dir: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      { timeout: 10_000 },
      (error, stdout) => {
        const remote = error ? "" : String(stdout).trim();
        done(remote || null);
      },
    );
  });
}

/**
 * Find the workspace entry for the checkout at `dir`: by its `origin`
 * remote, else by a path-registered entry containing `dir`.
 *
 * @param options.dir - Directory inside the checkout
 * @param options.workspaceDir - Workspace home (defaults to `~/.devintern`)
 * @param options.origin - The checkout's `origin` URL; read with git when omitted
 * @returns Null without a readable `workspace.toml` or a matching entry
 */
export async function findWorkspaceRepo(options: {
  dir: string;
  workspaceDir?: string;
  origin?: string | null;
}): Promise<WorkspaceRepoMatch | null> {
  const workspaceDir = options.workspaceDir ?? resolveWorkspaceDir();
  const file = readWorkspaceFile(workspaceDir);
  if (!file || file.repos.length === 0) return null;
  const origin =
    options.origin !== undefined ? options.origin : await readOriginRemote(options.dir);
  const repo = matchWorkspaceRepo(file.repos, { origin, dir: options.dir });
  if (!repo) return null;
  const env = repoCredentialEnv(repo, workspaceDir);
  const team = repoCredentialTeam(file.teams, repo.name);
  if (team) {
    Object.assign(
      env,
      teamCredentialEnv(team, workspaceDir, readEnvFile(workspaceEnvPath(workspaceDir))),
    );
  }
  if (!env.TASK_TRACKER && file.defaultTracker) env.TASK_TRACKER = file.defaultTracker;
  return { workspaceDir, repo, ...(team ? { team } : {}), env };
}
