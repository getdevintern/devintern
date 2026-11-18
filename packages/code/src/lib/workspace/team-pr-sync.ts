/**
 * Workspace-level helpers for `sync_team_prs` (team-PR base sync).
 *
 * Opting a repo in extends the review poller's automatic base sync from the
 * agent's own PRs to teammates' open PRs. Conflict resolution on those
 * branches hands someone else's code to the coding agent, so the feature is
 * gated on an explicit agent sandbox in each opted-in repo's *effective*
 * environment — the same layering (`buildRepoEnv`: process env → workspace
 * `.env` → repo `env_file` → inline `[repos.env]`) the fleet resolver
 * subprocess actually runs with.
 */

import { getSandboxProvider } from "@devintern/agent-harness";

import type { WorkspaceConfig } from "./config";
import { buildRepoEnv, gitHubSlugFromRemote } from "./env";

/**
 * GitHub slugs (`owner/repo`) of repos opted into team-PR base sync, resolved
 * the same way `fleetGitHubSlugs` resolves the fleet's GitHub repos. Read
 * from the live config on every call so reloads apply.
 */
export function teamPrSyncSlugs(config: WorkspaceConfig): string[] {
  const slugs = config.repos
    .filter((repo) => repo.syncTeamPrs === true)
    .map((repo) => repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))
    .filter((slug): slug is string => Boolean(slug));
  return [...new Set(slugs)];
}

/**
 * Opted-in repos whose effective `AGENT_SANDBOX` would run the agent
 * unsandboxed.
 *
 * Only an explicit, registered provider (`native`, `nono`, `docker`, …)
 * counts. Unset and `none` are refused, and so is `auto`: it degrades to
 * running unsandboxed (with only a warning) when no detected provider
 * supports the harness, which cannot be decided reliably ahead of the run
 * (provider availability and the harness can change between startup and a
 * resolver run, and the reload validator is synchronous).
 *
 * @returns One `"<repo> (AGENT_SANDBOX=<value>)"` entry per offending repo.
 */
export function teamPrSyncSandboxProblems(
  config: WorkspaceConfig,
  workspaceDir?: string,
): string[] {
  const problems: string[] = [];
  for (const repo of config.repos) {
    if (repo.syncTeamPrs !== true) continue;
    const value = buildRepoEnv(repo, workspaceDir).AGENT_SANDBOX?.trim() ?? "";
    if (value && value !== "none" && value !== "auto" && getSandboxProvider(value)) continue;
    problems.push(`${repo.name} (AGENT_SANDBOX=${value || "<unset>"})`);
  }
  return problems;
}

/**
 * Refuse a configuration that enables `sync_team_prs` without an explicit
 * agent sandbox. Used at worker startup and as part of live-reload validation.
 *
 * @throws Listing every offending repo and its effective `AGENT_SANDBOX`.
 */
export function assertTeamPrSyncSandbox(config: WorkspaceConfig, workspaceDir?: string): void {
  const problems = teamPrSyncSandboxProblems(config, workspaceDir);
  if (problems.length === 0) return;
  throw new Error(
    "sync_team_prs requires an explicit agent sandbox provider (AGENT_SANDBOX=native, nono, " +
      "or docker; `auto` and `none` are refused) because base-syncing teammates' PRs hands " +
      "their code to the coding agent. Set AGENT_SANDBOX in the workspace .env, the repo's " +
      "env_file, or [repos.env] (see `devintern sandbox`), or remove sync_team_prs from: " +
      problems.join(", "),
  );
}
