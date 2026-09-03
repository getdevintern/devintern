/** Workspace-aware `devintern worker connect` orchestration. */

import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { findEnvFile } from "@devintern/utils";

import { hasGitHubRelayRegistration, loadRelayState, runWorkerConnect } from "./relay-connect";
import type { RelayConnectDeps } from "./relay-connect";
import { loadWorkspaceConfig } from "./workspace/config";
import type { WorkspaceConfig } from "./workspace/config";
import { gitHubSlugFromRemote, parseEnvFile } from "./workspace/env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./workspace/paths";

const TRACKER_TARGETS = new Set(["linear", "asana", "trello", "azure-devops", "jira"]);

const WORKER_CONNECT_HELP = `Usage: devintern worker connect [target] [options]

Connect the worker to the DevIntern relay. With a workspace, GitHub connect
verifies every unpaired repository and stores shared relay state under the
workspace home. Without a workspace, it connects the current repository.

Targets:
  github (default)   Verify unpaired GitHub repositories through the App
  linear             Register a Linear webhook
  asana              Register an Asana webhook
  trello             Register a Trello webhook
  azure-devops       Register Azure DevOps hooks
  jira                Print Jira's one-time webhook setup instructions
  status              Show relay status and unverified workspace repositories

Options:
  --repo <owner/name>  Connect only this GitHub repository
  --workspace <path>   Use this workspace.toml
  -h, --help           Display this help message

Tracker targets read credentials from the workspace .env, or the nearest
project .env without a workspace. Explicit shell variables take precedence.`;

export interface WorkerConnectCommandDeps {
  workspaceDir?: string;
  workspacePath?: string;
  getAccessToken?: () => Promise<string>;
  runConnect?: typeof runWorkerConnect;
  findProjectEnv?: () => string | null;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ParsedConnectArgs {
  target: string;
  repo?: string;
  workspacePath?: string;
  help: boolean;
}

function parseConnectArgs(args: string[]): ParsedConnectArgs {
  let target = "github";
  let repo: string | undefined;
  let workspacePath: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--repo" && args[index + 1]) {
      repo = args[++index];
    } else if (arg === "--workspace" && args[index + 1]) {
      workspacePath = args[++index];
    } else if (arg && !arg.startsWith("-")) {
      target = arg.toLowerCase();
    }
  }
  return { target, repo, workspacePath, help };
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

/** Run the public, workspace-aware `devintern worker connect` command. */
export async function runWorkerConnectCommand(
  args: string[],
  detectRepo: () => Promise<string | null>,
  deps: WorkerConnectCommandDeps = {},
): Promise<number> {
  const parsed = parseConnectArgs(args);
  if (parsed.help) {
    console.log(WORKER_CONNECT_HELP);
    return 0;
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

  for (const option of ["--repo", "--workspace"]) {
    const optionIndex = args.indexOf(option);
    if (optionIndex !== -1 && (!args[optionIndex + 1] || args[optionIndex + 1]?.startsWith("-"))) {
      console.error(`❌ ${option} requires a value.`);
      return 1;
    }
  }

  const selectedWorkspacePath = deps.workspacePath ?? parsed.workspacePath;
  const workspaceDir =
    deps.workspaceDir ??
    (selectedWorkspacePath ? dirname(resolve(selectedWorkspacePath)) : resolveWorkspaceDir());
  const configPath = selectedWorkspacePath
    ? resolve(selectedWorkspacePath)
    : workspaceConfigPath(workspaceDir);
  const runConnect = deps.runConnect ?? runWorkerConnect;

  if (!existsSync(configPath)) {
    if (selectedWorkspacePath || deps.workspaceDir) {
      console.error(`❌ No workspace found at ${configPath}.`);
      return 1;
    }
    const findProjectEnvironment =
      deps.findProjectEnv ?? (() => findEnvFile({ configDirName: ".devintern-code" }));
    const projectEnvPath = findProjectEnvironment();
    if (projectEnvPath) {
      for (const [key, value] of Object.entries(parseEnvFile(projectEnvPath))) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
    const standaloneArgs =
      parsed.target === "github" && parsed.repo
        ? [parsed.target, "--repo", parsed.repo]
        : [parsed.target];
    return runConnect(standaloneArgs, detectRepo, {
      relayUrl: deps.relayUrl,
      fetchImpl: deps.fetchImpl,
      getAccessToken: deps.getAccessToken,
    });
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
  const connectDeps: RelayConnectDeps = {
    workingDir: workspaceDir,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
    getAccessToken: deps.getAccessToken
      ? () => (accessTokenPromise ??= deps.getAccessToken!())
      : undefined,
  };

  if (parsed.target === "status") {
    const result = await runConnect(["status"], detectRepo, connectDeps);
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

  if (parsed.target !== "github") {
    return runConnect([parsed.target], detectRepo, connectDeps);
  }

  if (parsed.repo) {
    return runConnect(["github", "--repo", parsed.repo], detectRepo, connectDeps);
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
    const result = await runConnect(
      ["github", "--repo", repo],
      () => Promise.resolve(repo),
      connectDeps,
    );
    if (result !== 0) failures++;
  }

  if (failures > 0) {
    console.error(`❌ ${failures} workspace repository pairing(s) failed.`);
    return 1;
  }
  console.log("✅ All workspace GitHub repositories are verified for relay delivery.");
  return 0;
}
