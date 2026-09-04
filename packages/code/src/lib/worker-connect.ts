/** Workspace-only `devintern worker connect` orchestration. */

import { existsSync } from "fs";
import { dirname, resolve } from "path";

import { connectRelayTarget, hasGitHubRelayRegistration, loadRelayState } from "./relay-connect";
import type { RelayConnectTarget, WorkspaceRelayConnectDeps } from "./relay-connect";
import { loadWorkspaceConfig } from "./workspace/config";
import type { WorkspaceConfig } from "./workspace/config";
import { buildTeamEnv, gitHubSlugFromRemote, parseEnvFile } from "./workspace/env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./workspace/paths";

const TRACKER_TARGETS = new Set(["linear", "asana", "trello", "azure-devops", "jira"]);

const WORKER_CONNECT_HELP = `Usage: devintern worker connect [target] [options]

Connect the workspace worker to the DevIntern relay. GitHub connect verifies
every unpaired repository and stores shared relay state under the workspace
home.

Targets:
  github (default)   Verify unpaired GitHub repositories through the App
  linear             Register a Linear webhook
  asana              Register an Asana webhook
  trello             Register a Trello webhook
  azure-devops       Register Azure DevOps hooks
  jira                Print Jira's one-time webhook setup instructions
  status              Show relay status and unverified workspace repositories

Options:
  --workspace <path>   Use this workspace.toml
  --team <name>        Use one team's tracker credentials
  -h, --help           Display this help message

Tracker targets use the selected team's env_file/inline env over the workspace
.env. Team-scoped registrations let multiple teams use the same tracker.`;

export interface WorkerConnectCommandDeps {
  workspaceDir?: string;
  workspacePath?: string;
  getAccessToken?: () => Promise<string>;
  runConnect?: typeof connectRelayTarget;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ParsedConnectArgs {
  target: string;
  workspacePath?: string;
  team?: string;
  help: boolean;
  error?: string;
}

function parseConnectArgs(args: string[]): ParsedConnectArgs {
  let target = "github";
  let workspacePath: string | undefined;
  let help = false;
  let team: string | undefined;
  let targetSet = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--workspace") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { target, workspacePath, team, help, error: "--workspace requires a value." };
      }
      workspacePath = value;
      index++;
    } else if (arg === "--team") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { target, workspacePath, team, help, error: "--team requires a value." };
      }
      team = value;
      index++;
    } else if (arg?.startsWith("-")) {
      return { target, workspacePath, team, help, error: `Unknown option: ${arg}` };
    } else if (arg && !arg.startsWith("-")) {
      if (targetSet) {
        return { target, workspacePath, team, help, error: `Unexpected argument: ${arg}` };
      }
      target = arg.toLowerCase();
      targetSet = true;
    }
  }
  return { target, workspacePath, team, help };
}

/** GitHub slugs represented by the workspace, deduplicated in config order. */
export function workspaceRelayRepos(config: WorkspaceConfig): string[] {
  return [
    ...new Set(
      config.repos
        .map((repo) => repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))
        .filter((repo): repo is string => Boolean(repo)),
    ),
  ];
}

/** GitHub repositories that still need verified App pairing. */
export function unverifiedWorkspaceRelayRepos(
  config: WorkspaceConfig,
  workspaceDir: string,
): string[] {
  const state = loadRelayState(workspaceDir);
  return workspaceRelayRepos(config).filter((repo) => !hasGitHubRelayRegistration(state, repo));
}

/** Run the public, workspace-only `devintern worker connect` command. */
export async function runWorkerConnectCommand(
  args: string[],
  deps: WorkerConnectCommandDeps = {},
): Promise<number> {
  const parsed = parseConnectArgs(args);
  if (parsed.help) {
    console.log(WORKER_CONNECT_HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`❌ ${parsed.error}`);
    return 1;
  }
  if (
    parsed.target !== "github" &&
    parsed.target !== "status" &&
    !TRACKER_TARGETS.has(parsed.target)
  ) {
    console.error(
      `❌ Unsupported connect target '${parsed.target}'. ` +
        "Available: github, linear, asana, trello, azure-devops, jira, status.",
    );
    return 1;
  }
  const target = parsed.target as RelayConnectTarget;
  if (parsed.team && (target === "github" || target === "status")) {
    console.error("❌ --team is only valid for tracker connect targets.");
    return 1;
  }

  const selectedWorkspacePath = deps.workspacePath ?? parsed.workspacePath;
  const workspaceDir =
    deps.workspaceDir ??
    (selectedWorkspacePath ? dirname(resolve(selectedWorkspacePath)) : resolveWorkspaceDir());
  const configPath = selectedWorkspacePath
    ? resolve(selectedWorkspacePath)
    : workspaceConfigPath(workspaceDir);
  const runConnect = deps.runConnect ?? connectRelayTarget;

  if (!existsSync(configPath)) {
    console.error(`❌ No workspace found at ${configPath}. Run \`devintern worker init\` first.`);
    return 1;
  }

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }

  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  let accessTokenPromise: Promise<string> | undefined;
  const connectDeps: WorkspaceRelayConnectDeps = {
    workingDir: workspaceDir,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
    getAccessToken: deps.getAccessToken
      ? () => (accessTokenPromise ??= deps.getAccessToken!())
      : undefined,
  };

  if (target !== "github" && target !== "status") {
    const matchingTeams = config.teams.filter(
      (team) => team.tracker.toLowerCase() === target.toLowerCase(),
    );
    if (matchingTeams.length > 1 && !parsed.team) {
      console.error(
        `❌ ${matchingTeams.length} teams use ${target} (${matchingTeams.map((team) => team.name).join(", ")}). ` +
          "Select one with --team <name>.",
      );
      return 1;
    }
    const selectedTeam = parsed.team
      ? config.teams.find((team) => team.name === parsed.team)
      : matchingTeams[0];
    if (parsed.team && !selectedTeam) {
      console.error(`❌ Unknown workspace team '${parsed.team}'.`);
      return 1;
    }
    if (selectedTeam && selectedTeam.tracker.toLowerCase() !== target.toLowerCase()) {
      console.error(`❌ Team '${selectedTeam.name}' uses ${selectedTeam.tracker}, not ${target}.`);
      return 1;
    }
    if (selectedTeam) {
      connectDeps.team = selectedTeam.name;
      connectDeps.env = { ...process.env, ...buildTeamEnv(selectedTeam, workspaceDir) };
      console.log(`🔗 Connecting ${target} for team '${selectedTeam.name}'.`);
    }
  }

  if (target === "status") {
    const result = await runConnect("status", connectDeps);
    if (result !== 0) return result;

    const missing = unverifiedWorkspaceRelayRepos(config, workspaceDir);
    if (missing.length === 0) {
      console.log("   All workspace GitHub repositories are verified.");
    } else {
      console.log(`   Unverified workspace repositories: ${missing.join(", ")}`);
      console.log("   Run: devintern worker connect github");
    }
    return 0;
  }

  if (target !== "github") {
    return runConnect(target, connectDeps);
  }

  const repos = workspaceRelayRepos(config);
  if (repos.length === 0) {
    console.error("❌ No GitHub repositories found in workspace.toml.");
    return 1;
  }

  const state = loadRelayState(workspaceDir);
  let failures = 0;
  for (const repo of repos) {
    if (hasGitHubRelayRegistration(state, repo)) {
      console.log(`✅ ${repo} is already verified; skipping.`);
      continue;
    }
    const result = await runConnect("github", { ...connectDeps, repo });
    if (result !== 0) failures++;
  }

  if (failures > 0) {
    console.error(`❌ ${failures} workspace repository pairing(s) failed.`);
    return 1;
  }
  console.log("✅ All workspace GitHub repositories are verified for relay delivery.");
  return 0;
}
