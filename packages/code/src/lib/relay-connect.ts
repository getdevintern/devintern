/**
 * `devintern worker connect` — pair this project's worker with the Mode 2
 * control plane (relay).
 *
 * Connect is the interactive step: the CLI authenticates with the signed-in
 * Supabase session, the control plane confirms automation entitlement, and
 * (for GitHub / tracker sources) registers the callback. Pairing metadata and
 * the minted relay token persist in `.devintern-code/relay.json` (gitignored
 * with the rest of that directory). The worker then long-polls with that
 * durable relay token; `LICENSE_KEY` remains the local unattended license
 * gate for `devintern worker`.
 */

import { createDefaultSupabaseAuthConfig, requireAuthenticatedUser } from "@devintern/auth";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

export const DEFAULT_RELAY_URL = "https://relay.devintern.com";

/**
 * Login of the DevIntern AI App bot that acts on relay-managed PRs. Its
 * private key stays on DevIntern infrastructure, so a local worker can never
 * resolve this identity via App auth — instead the worker injects it as a
 * mention alias (GITHUB_BOT_ALIASES, see `botMentionAliases`) so that
 * `@devintern-ai` mentions on relay PRs trigger review addressing.
 */
export const RELAY_BOT_LOGIN = "devintern-ai";

export interface RelayRegistration {
  kind: "repo" | "source";
  key: string;
  createdAt: number;
  lastEventAt: number | null;
}

export interface RelayConnectState {
  relayUrl: string;
  customerId: string;
  connectedAt: string;
  registrations: RelayRegistration[];
  /**
   * Durable worker credential (`drt_…`), minted once at connect. Returned by
   * the relay exactly once; only its hash is stored server-side.
   */
  relayToken?: string;
}

/** Resolve the relay URL: env override, else the hosted default. */
export function resolveRelayUrl(): string {
  return (process.env.WORKER_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, "");
}

function relayStatePath(workingDir: string): string {
  return join(resolve(workingDir, ".devintern-code"), "relay.json");
}

function authSessionPath(workingDir: string): string {
  return join(resolve(workingDir, ".devintern-code"), ".auth-session.json");
}

/**
 * Load persisted connect state, or null when this project is not connected.
 *
 * @param workingDir - Project root (defaults to cwd)
 */
export function loadRelayState(workingDir: string = process.cwd()): RelayConnectState | null {
  const path = relayStatePath(workingDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as RelayConnectState;
    return state.relayUrl && state.customerId ? state : null;
  } catch {
    return null;
  }
}

/** Persist connect state to `.devintern-code/relay.json`. */
export function saveRelayState(state: RelayConnectState, workingDir: string = process.cwd()): void {
  const path = relayStatePath(workingDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

interface ConnectResponse {
  customerId: string;
  licenseSource: string;
  registrations: RelayRegistration[];
}

export interface RelayConnectDeps {
  /** Absolute project root (defaults to cwd). */
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the on-disk Supabase session. */
  getAccessToken?: () => Promise<string>;
}

async function resolveAccessToken(deps: RelayConnectDeps = {}): Promise<string> {
  if (deps.getAccessToken) {
    return deps.getAccessToken();
  }
  const workingDir = deps.workingDir ?? process.cwd();
  const user = await requireAuthenticatedUser(
    createDefaultSupabaseAuthConfig(authSessionPath(workingDir)),
    "devintern login",
  );
  return user.accessToken;
}

async function connectRequest(
  accessToken: string,
  body: Record<string, unknown>,
  deps: RelayConnectDeps = {},
): Promise<Response> {
  const relayUrl = (deps.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  return fetchImpl(`${relayUrl}/v1/connect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Mint a durable relay token via `/v1/connect` action `issue-token`.
 *
 * @param accessToken - Supabase access token from `devintern login`
 */
export async function issueRelayToken(
  accessToken: string,
  deps: RelayConnectDeps = {},
): Promise<{ customerId: string; licenseSource: string; relayToken: string }> {
  const response = await connectRequest(accessToken, { action: "issue-token" }, deps);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    customerId: string;
    licenseSource: string;
    relayToken: string;
  };
  if (!data.relayToken?.startsWith("drt_")) {
    throw new Error("relay did not return a relay token");
  }
  return data;
}

/**
 * Ensure `.devintern-code/relay.json` holds a usable relay token, minting one
 * when missing (or when `force` is set).
 */
export async function ensureRelayToken(
  accessToken: string,
  deps: RelayConnectDeps & { force?: boolean } = {},
): Promise<{ relayToken: string; state: RelayConnectState }> {
  const workingDir = deps.workingDir ?? process.cwd();
  const relayUrl = (deps.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const existing = loadRelayState(workingDir);
  if (existing?.relayToken && !deps.force) {
    return { relayToken: existing.relayToken, state: existing };
  }

  const minted = await issueRelayToken(accessToken, deps);
  const state: RelayConnectState = {
    relayUrl,
    customerId: minted.customerId,
    connectedAt: new Date().toISOString(),
    registrations: existing?.registrations ?? [],
    relayToken: minted.relayToken,
  };
  saveRelayState(state, workingDir);
  return { relayToken: minted.relayToken, state };
}

function mergeConnectState(
  workingDir: string,
  relayUrl: string,
  data: ConnectResponse,
  relayToken: string | undefined,
): RelayConnectState {
  const previous = loadRelayState(workingDir);
  const state: RelayConnectState = {
    relayUrl,
    customerId: data.customerId,
    connectedAt: new Date().toISOString(),
    registrations: data.registrations,
    relayToken: relayToken ?? previous?.relayToken,
  };
  saveRelayState(state, workingDir);
  return state;
}

/**
 * Register a GitHub repo with the relay and persist the connect state.
 *
 * @param options - Repo slug plus signed-in access token
 */
export async function connectGitHubRepo(options: {
  repo: string;
  accessToken: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<RelayConnectState> {
  const deps: RelayConnectDeps = {
    workingDir: options.workingDir,
    relayUrl: options.relayUrl,
    fetchImpl: options.fetchImpl,
  };
  const { relayToken } = await ensureRelayToken(options.accessToken, deps);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const workingDir = options.workingDir ?? process.cwd();

  const response = await connectRequest(
    options.accessToken,
    { action: "register-repo", repo: options.repo },
    deps,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as ConnectResponse;
  return mergeConnectState(workingDir, relayUrl, data, relayToken);
}

/**
 * Register a tracker source with the relay, returning its ingest URL.
 *
 * @param options - Source name, optional client-generated signing secret
 */
export async function registerRelaySource(options: {
  source: string;
  accessToken: string;
  secret?: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ingestUrl: string; state: RelayConnectState }> {
  const deps: RelayConnectDeps = {
    workingDir: options.workingDir,
    relayUrl: options.relayUrl,
    fetchImpl: options.fetchImpl,
  };
  const { relayToken } = await ensureRelayToken(options.accessToken, deps);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const workingDir = options.workingDir ?? process.cwd();

  const response = await connectRequest(
    options.accessToken,
    {
      action: "register-source",
      source: options.source,
      secret: options.secret,
    },
    deps,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as ConnectResponse & { ingestUrl: string };
  const state = mergeConnectState(workingDir, relayUrl, data, relayToken);
  return { ingestUrl: data.ingestUrl, state };
}

/** Random 32-byte hex secret for webhook signing (Linear). */
function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CONNECT_HELP = `Usage: devintern worker connect [target] [options]

Pair this project's worker with the DevIntern relay (Mode 2): source webhooks
reach DevIntern's ingest, are stripped to reference envelopes (never code,
comments, or credentials), and your worker picks them up instantly instead of
waiting for the next poll.

Sign in first (\`devintern login\`). Connect verifies your session and
automation entitlement, then mints a durable relay token for worker polling.
LICENSE_KEY is still required for the local unattended license gate when you
run \`devintern worker\`.

Targets:
  github (default)   Register this repo for GitHub App webhook delivery
  linear             Self-register a Linear webhook (uses LINEAR_API_KEY)
  asana              Self-register an Asana webhook (uses ASANA_API_TOKEN and
                     ASANA_DEFAULT_PROJECT_GID)
  trello             Self-register a Trello webhook (uses TRELLO_API_KEY,
                     TRELLO_API_TOKEN, TRELLO_DEFAULT_BOARD_ID)
  azure-devops       Self-register work item service hooks (uses
                     AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, AZURE_DEVOPS_PROJECT)
  jira               Print manual admin webhook setup with your ingest URL
  status             Show relay registrations and event freshness

Options:
  --repo <owner/name>  GitHub repo to register (default: auto-detected)
  -h, --help           Display this help message

Environment variables:
  LICENSE_KEY              Required for unattended \`devintern worker\` runs
  WORKER_RELAY_URL         Relay base URL (default: ${DEFAULT_RELAY_URL})
  LINEAR_API_KEY           Required for \`connect linear\`
  ASANA_API_TOKEN          Required for \`connect asana\`
  ASANA_DEFAULT_PROJECT_GID  Required for \`connect asana\`
  TRELLO_API_KEY           Required for \`connect trello\`
  TRELLO_API_TOKEN         Required for \`connect trello\`
  TRELLO_DEFAULT_BOARD_ID  Required for \`connect trello\`
  AZURE_DEVOPS_ORG         Required for \`connect azure-devops\`
  AZURE_DEVOPS_PAT         Required for \`connect azure-devops\`
  AZURE_DEVOPS_PROJECT     Required for \`connect azure-devops\``;

function formatTimestamp(epochMs: number | null): string {
  return epochMs === null ? "never" : new Date(epochMs).toLocaleString();
}

/**
 * CLI flow for `devintern worker connect ...`.
 *
 * @param args - Argv after "connect"
 * @param detectRepo - Returns the current repo's `owner/name` slug (GitHub only)
 * @param deps - Optional injectables for tests
 * @returns Process exit code
 */
export async function runWorkerConnect(
  args: string[],
  detectRepo: () => Promise<string | null>,
  deps: RelayConnectDeps = {},
): Promise<number> {
  let target = "github";
  let repoFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(CONNECT_HELP);
      return 0;
    } else if (arg === "--repo" && args[i + 1]) {
      repoFlag = args[i + 1];
      i++;
    } else if (arg && !arg.startsWith("-")) {
      target = arg;
    }
  }

  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(deps);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }

  const connectOpts = {
    accessToken,
    workingDir: deps.workingDir,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
  };

  if (target === "status") {
    try {
      const { relayToken } = await ensureRelayToken(accessToken, deps);
      const status = await fetchRelayStatus({ relayToken, ...deps });
      console.log(`📡 Relay: ${resolveRelayUrl()}`);
      console.log(`   Customer: ${status.customerId} (${status.licenseSource})`);
      console.log(`   Buffered envelopes: ${status.buffered}`);
      if (status.registrations.length === 0) {
        console.log("   No registrations yet. Run: devintern worker connect");
      }
      for (const reg of status.registrations) {
        console.log(
          `   - ${reg.kind}:${reg.key} (last event: ${formatTimestamp(reg.lastEventAt)})`,
        );
      }
      return 0;
    } catch (error) {
      console.error(`❌ Relay status failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target === "linear") {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      console.error("❌ LINEAR_API_KEY is required to register a Linear webhook.");
      return 1;
    }
    try {
      const secret = generateWebhookSecret();
      const { ingestUrl } = await registerRelaySource({
        source: "linear",
        secret,
        ...connectOpts,
      });
      const { LinearClient } = await import("@devintern/task-trackers");
      const webhook = await new LinearClient({ apiKey }).createWebhook(ingestUrl, secret);
      console.log(
        `✅ Linear webhook registered (${webhook.id}); Issue events now relay instantly.`,
      );
      console.log("   Undo in Linear: Settings > API > Webhooks.");
      return 0;
    } catch (error) {
      console.error(`❌ Linear connect failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target === "asana") {
    const apiToken = process.env.ASANA_API_TOKEN;
    const projectGid = process.env.ASANA_DEFAULT_PROJECT_GID;
    if (!apiToken || !projectGid) {
      console.error(
        "❌ ASANA_API_TOKEN and ASANA_DEFAULT_PROJECT_GID are required to register an Asana webhook.",
      );
      return 1;
    }
    try {
      const { ingestUrl } = await registerRelaySource({ source: "asana", ...connectOpts });
      const { AsanaClient } = await import("@devintern/task-trackers");
      // Asana handshakes with the relay during creation (X-Hook-Secret).
      const webhook = await new AsanaClient({ apiToken }).createWebhook(projectGid, ingestUrl);
      console.log(
        `✅ Asana webhook registered (${webhook.gid}); task events on project ${projectGid} now relay instantly.`,
      );
      console.log("   Undo via the Asana API: DELETE /webhooks/" + webhook.gid);
      return 0;
    } catch (error) {
      console.error(`❌ Asana connect failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target === "trello") {
    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_API_TOKEN;
    const boardId = process.env.TRELLO_DEFAULT_BOARD_ID;
    if (!apiKey || !apiToken || !boardId) {
      console.error(
        "❌ TRELLO_API_KEY, TRELLO_API_TOKEN, and TRELLO_DEFAULT_BOARD_ID are required to register a Trello webhook.",
      );
      return 1;
    }
    try {
      const { ingestUrl } = await registerRelaySource({ source: "trello", ...connectOpts });
      const { TrelloClient } = await import("@devintern/task-trackers");
      const webhook = await new TrelloClient({ apiKey, apiToken }).createWebhook(
        ingestUrl,
        boardId,
      );
      console.log(
        `✅ Trello webhook registered (${webhook.id}); card events on board ${boardId} now relay instantly.`,
      );
      console.log("   Delivery auth relies on the private ingest URL; keep it secret.");
      return 0;
    } catch (error) {
      console.error(`❌ Trello connect failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target === "azure-devops") {
    const organization = process.env.AZURE_DEVOPS_ORG;
    const pat = process.env.AZURE_DEVOPS_PAT;
    const project = process.env.AZURE_DEVOPS_PROJECT;
    if (!organization || !pat || !project) {
      console.error(
        "❌ AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT are required to register Azure DevOps service hooks.",
      );
      return 1;
    }
    try {
      const { ingestUrl } = await registerRelaySource({
        source: "azure-devops",
        ...connectOpts,
      });
      const { AzureDevOpsClient } = await import("@devintern/task-trackers");
      const client = new AzureDevOpsClient({ organization, pat, defaultProject: project });
      const { ids } = await client.createWorkItemWebhooks(ingestUrl);
      console.log(
        `✅ Azure DevOps service hooks registered (${ids.join(", ")}); work item events on ${project} now relay instantly.`,
      );
      console.log("   Undo in Azure DevOps: Project settings > Service hooks.");
      return 0;
    } catch (error) {
      console.error(`❌ Azure DevOps connect failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target === "jira") {
    try {
      const { ingestUrl } = await registerRelaySource({ source: "jira", ...connectOpts });
      console.log("✅ Jira ingest URL registered. Jira webhooks need one-time admin setup:");
      console.log("");
      console.log("   1. Open Jira: Settings (gear) > System > WebHooks > Create a WebHook");
      console.log(`   2. URL: ${ingestUrl}`);
      console.log("   3. Events: Issue - created, updated (optionally scope with a JQL filter)");
      console.log("   4. Save. Issue events now relay instantly.");
      console.log("");
      console.log("   Keep the URL secret; it authenticates deliveries for your account.");
      return 0;
    } catch (error) {
      console.error(`❌ Jira connect failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target !== "github") {
    console.error(
      `❌ Unsupported connect target '${target}'. ` +
        "Available: github, linear, asana, trello, azure-devops, jira, status.",
    );
    return 1;
  }

  const repo = repoFlag ?? (await detectRepo());
  if (!repo) {
    console.error(
      "❌ Could not detect a GitHub repository. Pass one explicitly:\n" +
        "   devintern worker connect github --repo owner/name",
    );
    return 1;
  }

  try {
    const state = await connectGitHubRepo({ repo, ...connectOpts });
    console.log(`✅ Connected ${repo} to the relay (${state.relayUrl})`);
    console.log(`   Customer: ${state.customerId}`);
    console.log("");
    console.log("Next steps:");
    console.log("   1. Install the DevIntern AI GitHub App on this repository:");
    console.log("      https://github.com/apps/devintern-ai");
    console.log("   2. Run the worker as usual: devintern worker [--query ...]");
    console.log("      It now receives PR events through the relay within seconds.");
    return 0;
  } catch (error) {
    console.error(`❌ Relay connect failed: ${(error as Error).message}`);
    return 1;
  }
}

interface StatusResponse {
  customerId: string;
  licenseSource: string;
  buffered: number;
  registrations: RelayRegistration[];
}

/**
 * Fetch live relay status for this customer (data plane: relay token).
 *
 * @param options - Relay token and optional relay URL / fetch override
 */
export async function fetchRelayStatus(options: {
  relayToken: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<StatusResponse> {
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${relayUrl}/v1/status`, {
    headers: { Authorization: `Bearer ${options.relayToken}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }
  return (await response.json()) as StatusResponse;
}
