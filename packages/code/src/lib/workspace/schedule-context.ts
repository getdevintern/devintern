/**
 * Run contexts (cwd + composed env) for scheduled workspace jobs:
 * `[[automations]]` occurrences and `[[estimations]]` sweeps. Each applies the
 * entry's own agent selection above every env layer.
 */

import { pickAgentSelection } from "../agent/selection";
import type { AutomationRunContext } from "../automation/acquirer";
import type { AutomationConfig } from "../automation/config";
import type { EstimationConfig } from "../automation/estimation-config";
import { findRepo, findTeam, resolveWorkspacePipelinePath } from "./config";
import type { WorkspaceConfig } from "./config";
import {
  buildRepoEnv,
  buildTeamWorkspaceContextEnv,
  buildWorkspaceContextEnv,
  WORKSPACE_TEAM_ENV,
} from "./env";
import type { RepoManagerLike } from "./fleet-executor";
import { automationsDir } from "./paths";

/**
 * Resolve where/how one scheduled `[[estimations]]` sweep runs.
 *
 * Always the workspace home: estimation is `--no-git` and tracker-only, so it
 * never clones, checks out, or locks a repository.
 *
 * - Without `team`: unchanged shared workspace env, with `[defaults].tracker`
 *   inherited from the worker process. A team marker leaked from the shell is
 *   cleared so the sweep is never attributed to a team.
 * - With `team`: that team's tracker and credential layers (see
 *   {@link buildTeamWorkspaceContextEnv}), attributed to the team via
 *   `DEVINTERN_WORKSPACE_TEAM` like the team's task runs.
 *
 * A team's fixed `repo` is deliberately ignored: it only picks the
 * destination of implement runs, while tracker coordinates (including
 * `GITHUB_REPO` for GitHub Issues) come from the team's own env, which the
 * worker already requires at startup to build that team's tracker client.
 *
 * @param estimation - The current (possibly live-reloaded) estimation entry.
 * @param config - The live workspace config (mutated in place by reloads).
 * @param workspaceDir - Workspace home.
 * @returns The run context, or null to skip the occurrence when the team is
 *          no longer configured.
 */
export function resolveWorkspaceEstimationContext(
  estimation: EstimationConfig,
  config: WorkspaceConfig,
  workspaceDir: string,
): AutomationRunContext | null {
  const agentSelection = pickAgentSelection(estimation);
  if (!estimation.team) {
    const env = buildWorkspaceContextEnv(workspaceDir, { agentSelection });
    delete env[WORKSPACE_TEAM_ENV];
    return { cwd: workspaceDir, env, release() {} };
  }
  const team = findTeam(config, estimation.team);
  if (!team) {
    console.error(
      `❌ [estimation:${estimation.id}] team "${estimation.team}" is not configured; skipping this occurrence.`,
    );
    return null;
  }
  return {
    cwd: workspaceDir,
    env: buildTeamWorkspaceContextEnv(team, workspaceDir, { agentSelection }),
    release() {},
  };
}

/** Resolve a scheduled run context while holding the repo lock during preparation. */
export async function resolveWorkspaceAutomationContext(
  automation: AutomationConfig,
  config: WorkspaceConfig,
  workspaceDir: string,
  repoManager: RepoManagerLike,
) {
  // Keep occurrence task files in the workspace home (next to repos/,
  // worktrees/, and the central DB) instead of inside a repo worktree.
  const taskFileDir = automationsDir(workspaceDir);
  // The entry's harness/model/effort override every env layer for its runs.
  const agentSelection = pickAgentSelection(automation);
  const repo = automation.repo
    ? findRepo(config, automation.repo)
    : config.repos.length === 1
      ? config.repos[0]
      : undefined;
  if (!repo)
    return {
      cwd: workspaceDir,
      env: buildWorkspaceContextEnv(workspaceDir, { agentSelection }),
      taskFileDir,
      release() {},
    };

  await repoManager.ensureBareClone(repo);
  await repoManager.fetch(repo.name);
  const cwd = await repoManager.ensureBaseWorktree(repo);
  return {
    cwd,
    env: buildRepoEnv(repo, workspaceDir, {
      pipelineDefaultFile: config.defaults.pipelineFile
        ? resolveWorkspacePipelinePath(workspaceDir, config.defaults.pipelineFile)
        : undefined,
      agentSelection,
    }),
    repo: repo.name,
    taskFileDir,
    release() {},
  };
}
