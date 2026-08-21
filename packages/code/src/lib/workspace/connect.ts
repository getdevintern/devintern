/**
 * `devintern workspace connect` — pair the whole workspace (fleet) with the
 * Mode 2 control plane in one step.
 *
 * Single-repo `worker connect` stores pairing inside a checkout
 * (`.devintern-code/relay.json`), so every repo needs its own connect. The
 * workspace variant stores one pairing for the fleet at `~/.devintern/
 * relay.json` and registers every GitHub remote in `workspace.toml` (plus,
 * optionally, each team's tracker source) against the same customer buffer.
 * The fleet worker then starts its relay acquirer from that state without
 * any per-repo connect.
 *
 * Re-connect is idempotent: an existing durable token is reused unless
 * `--force` re-mints it (matching single-repo semantics — tokens are never
 * silently replaced).
 */

import { existsSync } from "fs";

import {
  connectTrackerSource,
  DEFAULT_RELAY_URL,
  ensureRelayToken,
  fetchRelayStatus,
  isTrackerConnectTarget,
  loadRelayState,
  loadRelayStateFrom,
  registerGitHubRepo,
  resolveAccessToken,
} from "../relay-connect";
import type { RelayConnectState } from "../relay-connect";
import { loadWorkspaceConfig } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { gitHubSlugFromRemote, parseEnvFile } from "./env";
import {
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceEnvPath,
  workspaceRelayPath,
} from "./paths";

const WORKSPACE_CONNECT_HELP = `Usage: devintern workspace connect [target] [options]

Pair the whole workspace with the DevIntern relay (Mode 2) from one place:
the pairing and its durable drt_... token live in ~/.devintern/relay.json,
so no per-repo \`worker connect\` or checkout-local .devintern-code/relay.json
is needed.

Sign in first (\`devintern login\`). Connect verifies your session and
automation entitlement, mints the relay token once, then registers sources.
LICENSE_KEY remains only the local unattended license gate when you run
\`devintern worker\`; it is never a relay credential.

Targets:
  github (default)   Register every [[repos]] GitHub remote with the control
                     plane; non-GitHub remotes are skipped with a note
  linear             Self-register a Linear webhook (uses LINEAR_API_KEY)
  asana              Self-register an Asana webhook (uses ASANA_API_TOKEN and
                     ASANA_DEFAULT_PROJECT_GID)
  trello             Self-register a Trello webhook (uses TRELLO_API_KEY,
                     TRELLO_API_TOKEN, TRELLO_DEFAULT_BOARD_ID)
  azure-devops       Self-register work item service hooks (uses
                     AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, AZURE_DEVOPS_PROJECT)
  jira               Print manual admin webhook setup with your ingest URL
  status             Show fleet-wide registrations and buffer freshness

Tracker credentials are read from the shared workspace .env (the same file
the fleet worker uses).

Options:
  --force             Re-mint the relay token even if one is already stored
  -h, --help          Display this help message

Environment variables:
  WORKER_RELAY_URL     Relay base URL (default: ${DEFAULT_RELAY_URL})
  LINEAR_API_KEY       Required for \`connect linear\`
  ASANA_API_TOKEN      Required for \`connect asana\`
  ASANA_DEFAULT_PROJECT_GID  Required for \`connect asana\`
  TRELLO_API_KEY       Required for \`connect trello\`
  TRELLO_API_TOKEN     Required for \`connect trello\`
  TRELLO_DEFAULT_BOARD_ID    Required for \`connect trello\`
  AZURE_DEVOPS_ORG     Required for \`connect azure-devops\`
  AZURE_DEVOPS_PAT     Required for \`connect azure-devops\`
  AZURE_DEVOPS_PROJECT Required for \`connect azure-devops\``;

export interface WorkspaceConnectDeps {
  /** Explicit workspace home (defaults to `~/.devintern`). */
  workspaceDir?: string;
  /** Explicit workspace.toml path (defaults to `<workspaceDir>/workspace.toml`). */
  workspacePath?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the on-disk Supabase session. */
  getAccessToken?: () => Promise<string>;
}

/**
 * Resolve which workspace repos have a GitHub `owner/repo` slug.
 *
 * An explicit `[repos.env].GITHUB_REPO` wins; otherwise the slug is parsed
 * from the remote URL. Non-GitHub remotes yield no slug.
 */
export function workspaceRepoSlugs(config: WorkspaceConfig): Array<{
  repo: RepoConfig;
  slug: string | null;
}> {
  return config.repos.map((repo) => ({
    repo,
    slug: repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote),
  }));
}

/**
 * Load the workspace-scoped relay connect state, or null when the fleet has
 * never been connected.
 */
export function loadWorkspaceRelayState(
  workspaceDir: string = resolveWorkspaceDir(),
): RelayConnectState | null {
  return loadRelayStateFrom(workspaceRelayPath(workspaceDir));
}

/**
 * Resolve the relay credentials the fleet worker should long-poll with.
 *
 * Workspace-scoped state (`~/.devintern/relay.json`) wins over a legacy
 * per-checkout `.devintern-code/relay.json`, so one fleet daemon can run
 * without any per-repo connect.
 */
export function resolveFleetRelayCredentials(
  options: { workspaceDir?: string; cwd?: string } = {},
): { relayToken?: string; relayUrl?: string } {
  const state =
    loadWorkspaceRelayState(options.workspaceDir ?? resolveWorkspaceDir()) ??
    loadRelayState(options.cwd ?? process.cwd());
  return { relayToken: state?.relayToken, relayUrl: state?.relayUrl };
}

/**
 * CLI flow for `devintern workspace connect ...`.
 *
 * @param args - Argv after "connect"
 * @param deps - Optional injectables for tests
 * @returns Process exit code
 */
export async function runWorkspaceConnect(
  args: string[],
  deps: WorkspaceConnectDeps = {},
): Promise<number> {
  let target = "github";
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(WORKSPACE_CONNECT_HELP);
      return 0;
    } else if (arg === "--force") {
      force = true;
    } else if (arg && !arg.startsWith("-")) {
      target = arg.toLowerCase();
    }
  }

  const knownTargets = ["github", "status", "linear", "asana", "trello", "azure-devops", "jira"];
  if (!knownTargets.includes(target)) {
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

  // Tracker credentials live in the shared workspace .env; apply them the
  // same way the fleet worker does so connect matches what runs unattended.
  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    process.env[key] = value;
  }

  let accessToken: string;
  try {
    accessToken = deps.getAccessToken ? await deps.getAccessToken() : await resolveAccessToken();
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }

  const connectOpts = {
    accessToken,
    statePath: workspaceRelayPath(workspaceDir),
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
  };

  if (target === "status") {
    return runWorkspaceConnectStatus(config, connectOpts);
  }

  if (isTrackerConnectTarget(target)) {
    return connectTrackerSource(target, connectOpts);
  }

  return connectWorkspaceRepos(config, connectOpts, force);
}

/** Register every GitHub remote in the workspace with the control plane. */
async function connectWorkspaceRepos(
  config: WorkspaceConfig,
  connectOpts: {
    accessToken: string;
    statePath: string;
    relayUrl?: string;
    fetchImpl?: typeof fetch;
  },
  force: boolean,
): Promise<number> {
  const githubEntries: Array<{ slug: string }> = [];
  for (const { repo, slug } of workspaceRepoSlugs(config)) {
    if (slug === null) {
      console.log(`ℹ️  Skipping ${repo.name}: remote is not a GitHub repository (${repo.remote})`);
      continue;
    }
    githubEntries.push({ slug });
  }
  if (githubEntries.length === 0) {
    console.error(
      "❌ No GitHub repos found in the workspace; nothing to register.\n" +
        "   Add [[repos]] entries with github.com remotes (or set [repos.env].GITHUB_REPO).",
    );
    return 1;
  }

  let failures = 0;
  try {
    // One mint per connect run, no matter how many repos register.
    const { relayToken } = await ensureRelayToken(connectOpts.accessToken, {
      statePath: connectOpts.statePath,
      force,
      relayUrl: connectOpts.relayUrl,
      fetchImpl: connectOpts.fetchImpl,
    });
    for (const { slug } of githubEntries) {
      try {
        const state = await registerGitHubRepo({
          repo: slug,
          accessToken: connectOpts.accessToken,
          relayToken,
          statePath: connectOpts.statePath,
          relayUrl: connectOpts.relayUrl,
          fetchImpl: connectOpts.fetchImpl,
        });
        console.log(`✅ Registered ${slug} (${state.relayUrl})`);
      } catch (error) {
        failures++;
        console.error(`❌ Could not register ${slug}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.error(`❌ Relay connect failed: ${(error as Error).message}`);
    return 1;
  }

  if (failures > 0) {
    console.error(`❌ ${failures} repo(s) failed to register.`);
    return 1;
  }

  console.log("");
  console.log(`Fleet pairing stored at ${connectOpts.statePath}`);
  console.log("Next steps:");
  console.log("   1. Install the DevIntern AI GitHub App on each repository:");
  console.log("      https://github.com/apps/devintern-ai");
  console.log("   2. Start the fleet worker: devintern worker");
  console.log("      It now receives PR and task events through the relay.");
  return 0;
}

/** Fleet-wide registrations plus buffer freshness. */
async function runWorkspaceConnectStatus(
  config: WorkspaceConfig,
  connectOpts: {
    accessToken: string;
    statePath: string;
    relayUrl?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<number> {
  const relayUrl =
    (connectOpts.relayUrl ?? process.env.WORKER_RELAY_URL)?.replace(/\/+$/, "") ?? "";
  try {
    const { relayToken } = await ensureRelayToken(connectOpts.accessToken, {
      statePath: connectOpts.statePath,
      relayUrl: connectOpts.relayUrl,
      fetchImpl: connectOpts.fetchImpl,
    });
    const status = await fetchRelayStatus({
      relayToken,
      relayUrl: connectOpts.relayUrl,
      fetchImpl: connectOpts.fetchImpl,
    });
    console.log(`📡 Relay: ${relayUrl || DEFAULT_RELAY_URL}`);
    console.log(`   Customer: ${status.customerId} (${status.licenseSource})`);
    console.log(`   Buffered envelopes: ${status.buffered}`);
    if (status.registrations.length === 0) {
      console.log("   No registrations yet. Run: devintern workspace connect");
    }
    for (const reg of status.registrations) {
      console.log(`   - ${reg.kind}:${reg.key} (last event: ${formatTimestamp(reg.lastEventAt)})`);
    }

    const registered = new Set(
      status.registrations.filter((reg) => reg.kind === "repo").map((reg) => reg.key.toLowerCase()),
    );
    const missing = workspaceRepoSlugs(config)
      .map((entry) => entry.slug)
      .filter((slug): slug is string => slug !== null && !registered.has(slug.toLowerCase()));
    if (missing.length > 0) {
      console.log(`   Not registered yet: ${missing.join(", ")}`);
      console.log("   Run: devintern workspace connect");
    }
    return 0;
  } catch (error) {
    console.error(`❌ Relay status failed: ${(error as Error).message}`);
    return 1;
  }
}

function formatTimestamp(epochMs: number | null): string {
  return epochMs === null ? "never" : new Date(epochMs).toLocaleString();
}
