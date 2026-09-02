/** Fleet-level relay connection commands built on the verified pairing flow. */

import { existsSync } from "fs";

import { hasGitHubRelayRegistration, loadRelayState, runWorkerConnect } from "../relay-connect";
import type { RelayConnectDeps } from "../relay-connect";
import { loadWorkspaceConfig } from "./config";
import type { WorkspaceConfig } from "./config";
import { gitHubSlugFromRemote, parseEnvFile } from "./env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./paths";

const TRACKER_TARGETS = new Set(["linear", "asana", "trello", "azure-devops", "jira"]);

const WORKSPACE_CONNECT_HELP = `Usage: devintern workspace connect [target]

Connect the fleet workspace to the DevIntern relay. Relay state is stored in
the workspace home and shared by every repository in workspace.toml.

Targets:
  github (default)   Verify every unpaired GitHub repository through the App
  linear             Register a Linear webhook using the workspace .env
  asana              Register an Asana webhook using the workspace .env
  trello             Register a Trello webhook using the workspace .env
  azure-devops       Register Azure DevOps hooks using the workspace .env
  jira                Print Jira's one-time webhook setup instructions
  status              Show relay status and unverified workspace repositories

Each GitHub repository requires verified App authorization. Already verified
repositories are skipped safely.`;

export interface WorkspaceConnectDeps {
  workspaceDir?: string;
  workspacePath?: string;
  getAccessToken?: () => Promise<string>;
  runConnect?: typeof runWorkerConnect;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
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

/** Run `devintern workspace connect`. */
export async function runWorkspaceConnect(
  args: string[],
  deps: WorkspaceConnectDeps = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(WORKSPACE_CONNECT_HELP);
    return 0;
  }

  const target = args.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? "github";
  if (target !== "github" && target !== "status" && !TRACKER_TARGETS.has(target)) {
    console.error(
      `❌ Unsupported connect target '${target}'. ` +
        "Available: github, linear, asana, trello, azure-devops, jira, status.",
    );
    return 1;
  }

  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const configPath = deps.workspacePath ?? workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) {
    console.error(
      `❌ No workspace found at ${configPath}. Run \`devintern workspace init\` first.`,
    );
    return 1;
  }

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }

  // Match worker startup precedence: explicit shell values beat workspace .env.
  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const runConnect = deps.runConnect ?? runWorkerConnect;
  let accessTokenPromise: Promise<string> | undefined;
  const connectDeps: RelayConnectDeps = {
    workingDir: workspaceDir,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
    getAccessToken: deps.getAccessToken
      ? () => (accessTokenPromise ??= deps.getAccessToken!())
      : undefined,
  };

  if (target === "status") {
    const result = await runConnect(["status"], () => Promise.resolve(null), connectDeps);
    if (result !== 0) return result;

    const missing = unverifiedWorkspaceRelayRepos(config, workspaceDir);
    if (missing.length === 0) {
      console.log("   All workspace GitHub repositories are verified.");
    } else {
      console.log(`   Unverified workspace repositories: ${missing.join(", ")}`);
      console.log("   Run: devintern workspace connect github");
    }
    return 0;
  }

  if (target !== "github") {
    return runConnect([target], () => Promise.resolve(null), connectDeps);
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
