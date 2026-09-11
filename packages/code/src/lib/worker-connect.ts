/** Workspace-only `devintern worker connect` orchestration. */

import { existsSync } from "fs";
import { dirname, resolve } from "path";

import { Utils } from "./utils";
import { parseGitLabHostAliases, parseGitRemoteUrl } from "./code-host";
import {
  connectRelayTarget,
  hasGitHubRelayRegistration,
  hasGitLabRelayRegistration,
  loadRelayState,
} from "./relay-connect";
import type { RelayConnectTarget, WorkspaceRelayConnectDeps } from "./relay-connect";
import { loadWorkspaceConfig } from "./workspace/config";
import type { WorkspaceConfig } from "./workspace/config";
import { buildRepoEnv, buildTeamEnv, gitHubSlugFromRemote, parseEnvFile } from "./workspace/env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./workspace/paths";
import { runWorkerSentrySetup } from "./worker-sentry-setup";
import type { SentrySetupPromptFn, SentryValidationOptions } from "./worker-sentry-setup";

const TRACKER_TARGETS = new Set(["linear", "asana", "trello", "azure-devops", "jira"]);

/**
 * Every target `worker connect` accepts. Single source of truth for command
 * validation and for bounding `worker_connect` analytics target cardinality.
 */
export const WORKER_CONNECT_TARGETS: ReadonlySet<string> = new Set([
  "all",
  "github",
  "gitlab",
  ...TRACKER_TARGETS,
  "sentry",
  "status",
]);

const WORKER_CONNECT_HELP = `Usage: devintern worker connect [target] [options]

Connect an integration to the workspace worker. Code-host and tracker targets use
the DevIntern relay; Sentry adds a directly polled error-monitor project.

Targets:
  github             Verify unpaired GitHub repositories through the App
  gitlab             Install relay hooks for GitLab.com or self-managed projects
  linear             Register a Linear webhook
  asana              Register an Asana webhook
  trello             Register a Trello webhook
  azure-devops       Register Azure DevOps hooks
  jira                Print Jira's one-time webhook setup instructions
  sentry              Add and validate a Sentry auto-fix project
  status              Show relay status and unverified workspace repositories

Options:
  --workspace <path>   Use this workspace.toml
  --team <name>        Use one team's tracker credentials
  --repo <name>        Repository that owns a Sentry project
  --disconnect         Remove managed GitLab hooks; polling remains enabled
  -h, --help           Display this help message

Tracker targets use the selected team's env_file/inline env over the workspace
.env. Team-scoped registrations let multiple teams use the same tracker. With no
target, GitHub and GitLab code hosts are connected.`;

export interface WorkerConnectCommandDeps {
  workspaceDir?: string;
  workspacePath?: string;
  getAccessToken?: () => Promise<string>;
  runConnect?: typeof connectRelayTarget;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  cwd?: string;
  prompt?: SentrySetupPromptFn;
  validateSentry?: (options: SentryValidationOptions) => Promise<number>;
  /**
   * Reuse a `parseConnectArgs` result from the caller so analytics attribution
   * and command execution share one parse instead of drifting apart.
   */
  parsed?: ParsedConnectArgs;
}

export interface ParsedConnectArgs {
  target: string;
  workspacePath?: string;
  team?: string;
  repo?: string;
  help: boolean;
  disconnect: boolean;
  error?: string;
}

/**
 * Parse `worker connect` arguments. Exported so the CLI entry point can parse
 * once and pass the result to the command via `deps.parsed`, keeping analytics
 * attribution and execution in sync.
 */
export function parseConnectArgs(args: string[]): ParsedConnectArgs {
  let target = "all";
  let workspacePath: string | undefined;
  let help = false;
  let team: string | undefined;
  let repo: string | undefined;
  let targetSet = false;
  let disconnect = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--workspace") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return {
          target,
          workspacePath,
          team,
          repo,
          help,
          disconnect,
          error: "--workspace requires a value.",
        };
      }
      workspacePath = value;
      index++;
    } else if (arg === "--team") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return {
          target,
          workspacePath,
          team,
          repo,
          help,
          disconnect,
          error: "--team requires a value.",
        };
      }
      team = value;
      index++;
    } else if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return {
          target,
          workspacePath,
          team,
          repo,
          help,
          disconnect,
          error: "--repo requires a value.",
        };
      }
      repo = value;
      index++;
    } else if (arg === "--disconnect") {
      disconnect = true;
    } else if (arg?.startsWith("-")) {
      return {
        target,
        workspacePath,
        team,
        repo,
        help,
        disconnect,
        error: `Unknown option: ${arg}`,
      };
    } else if (arg && !arg.startsWith("-")) {
      if (targetSet) {
        return {
          target,
          workspacePath,
          team,
          repo,
          help,
          disconnect,
          error: `Unexpected argument: ${arg}`,
        };
      }
      target = arg.toLowerCase();
      targetSet = true;
    }
  }
  return { target, workspacePath, team, repo, help, disconnect };
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

export interface WorkspaceGitLabRelayProject {
  repoName: string;
  instanceUrl: string;
  projectPath: string;
  env: Record<string, string | undefined>;
}

/** GitLab projects represented by workspace remotes, deduplicated by instance and path. */
export function workspaceGitLabRelayProjects(
  config: WorkspaceConfig,
  workspaceDir: string,
): WorkspaceGitLabRelayProject[] {
  const projects = new Map<string, WorkspaceGitLabRelayProject>();
  for (const repo of config.repos) {
    const env = buildRepoEnv(repo, workspaceDir);
    const remote = parseGitRemoteUrl(repo.remote, {
      gitlabBaseUrl: env.GITLAB_CODE_HOST_URL,
      gitlabHostAliases: parseGitLabHostAliases(env.GITLAB_CODE_HOST_ALIASES),
    });
    if (remote?.provider !== "gitlab") continue;
    const key = `${remote.instanceUrl.toLowerCase()}\n${remote.projectPath.toLowerCase()}`;
    if (!projects.has(key)) {
      projects.set(key, {
        repoName: repo.name,
        instanceUrl: remote.instanceUrl,
        projectPath: remote.projectPath,
        env,
      });
    }
  }
  return [...projects.values()];
}

/** Run the public, workspace-only `devintern worker connect` command. */
export async function runWorkerConnectCommand(
  args: string[],
  deps: WorkerConnectCommandDeps = {},
): Promise<number> {
  const parsed = deps.parsed ?? parseConnectArgs(args);
  if (parsed.help) {
    console.log(WORKER_CONNECT_HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`❌ ${parsed.error}`);
    return 1;
  }
  if (!WORKER_CONNECT_TARGETS.has(parsed.target)) {
    console.error(
      `❌ Unsupported connect target '${parsed.target}'. ` +
        "Available: github, gitlab, linear, asana, trello, azure-devops, jira, sentry, status.",
    );
    return 1;
  }
  if (
    parsed.team &&
    (parsed.target === "github" ||
      parsed.target === "gitlab" ||
      parsed.target === "all" ||
      parsed.target === "status" ||
      parsed.target === "sentry")
  ) {
    console.error("❌ --team is only valid for tracker connect targets.");
    return 1;
  }
  if (parsed.repo && parsed.target !== "sentry") {
    console.error("❌ --repo is only valid for Sentry connect.");
    return 1;
  }
  if (parsed.disconnect && parsed.target !== "gitlab") {
    console.error("❌ --disconnect is only valid for the GitLab connect target.");
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

  if (parsed.target === "all") {
    let accessTokenPromise: Promise<string> | undefined;
    const sharedDeps: WorkerConnectCommandDeps = {
      ...deps,
      parsed: undefined,
      workspaceDir,
      workspacePath: configPath,
      getAccessToken: deps.getAccessToken
        ? () => (accessTokenPromise ??= deps.getAccessToken!())
        : undefined,
    };
    let failures = 0;
    if (workspaceRelayRepos(config).length > 0) {
      if ((await runWorkerConnectCommand(["github"], sharedDeps)) !== 0) failures++;
    } else {
      console.log("   No GitHub repositories found; skipping GitHub relay setup.");
    }
    if (workspaceGitLabRelayProjects(config, workspaceDir).length > 0) {
      if ((await runWorkerConnectCommand(["gitlab"], sharedDeps)) !== 0) failures++;
    } else {
      console.log("   No GitLab repositories found; skipping GitLab relay setup.");
    }
    return failures === 0 ? 0 : 1;
  }

  if (parsed.target === "sentry") {
    if (!deps.prompt && !process.stdin.isTTY) {
      console.error("❌ 'devintern worker connect sentry' is interactive; run it in a terminal.");
      return 1;
    }
    let repoName = parsed.repo;
    if (!repoName && config.repos.length > 1) {
      const remote = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
        cwd: deps.cwd ?? process.cwd(),
      });
      if (remote.success) {
        repoName = config.repos.find((repo) => repo.remote === remote.output.trim())?.name;
      }
    }
    const result = await runWorkerSentrySetup({
      workspaceDir,
      repoName,
      prompt: deps.prompt,
      validateSentry: deps.validateSentry,
    });
    return result.ok ? 0 : 1;
  }

  const target = parsed.target as RelayConnectTarget;

  let accessTokenPromise: Promise<string> | undefined;
  const connectDeps: WorkspaceRelayConnectDeps = {
    workingDir: workspaceDir,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
    getAccessToken: deps.getAccessToken
      ? () => (accessTokenPromise ??= deps.getAccessToken!())
      : undefined,
  };

  if (target !== "github" && target !== "gitlab" && target !== "status") {
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
    const relayState = loadRelayState(workspaceDir);
    const gitlabProjects = workspaceGitLabRelayProjects(config, workspaceDir);
    const missingGitLab = gitlabProjects.filter(
      (project) =>
        !hasGitLabRelayRegistration(relayState, project.instanceUrl, project.projectPath),
    );
    if (gitlabProjects.length > 0 && missingGitLab.length === 0) {
      console.log("   All workspace GitLab projects have local relay registrations.");
    } else if (missingGitLab.length > 0) {
      console.log(
        `   GitLab projects without local relay registration: ${missingGitLab.map((project) => project.projectPath).join(", ")}`,
      );
      console.log("   Run: devintern worker connect gitlab");
    }
    return 0;
  }

  if (target === "gitlab") {
    const projects = workspaceGitLabRelayProjects(config, workspaceDir);
    if (projects.length === 0) {
      console.error("❌ No GitLab repositories found in workspace.toml.");
      return 1;
    }
    let failures = 0;
    for (const project of projects) {
      console.log(`🔗 Connecting GitLab project ${project.projectPath} (${project.repoName}).`);
      const result = await runConnect("gitlab", {
        ...connectDeps,
        env: project.env,
        gitlabProject: {
          instanceUrl: project.instanceUrl,
          projectPath: project.projectPath,
        },
        disconnectGitLab: parsed.disconnect,
      });
      if (result !== 0) failures++;
    }
    if (failures > 0) {
      console.error(`❌ ${failures} GitLab project hook setup(s) failed; polling remains enabled.`);
      return 1;
    }
    console.log("✅ All workspace GitLab projects are connected for relay delivery.");
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
