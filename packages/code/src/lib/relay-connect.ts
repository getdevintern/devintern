/**
 * Workspace relay pairing primitives.
 *
 * Connect is the interactive step: the CLI authenticates with the signed-in
 * Supabase session, the control plane confirms automation entitlement, and
 * (for GitHub / tracker sources) registers the callback. Pairing metadata and
 * the minted relay token persist under the workspace's `.devintern-code`
 * directory. The worker then long-polls with that durable relay token;
 * `LICENSE_KEY` remains the local unattended license gate for
 * `devintern worker`.
 */

import { createDefaultSupabaseAuthConfig, requireAuthenticatedUser } from "@devintern/auth";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import { saveGitHubAppRecord } from "./github-app-setup";

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
  /** Stable workspace team slug for team-scoped tracker registrations. */
  team?: string;
  createdAt: number;
  lastEventAt: number | null;
  /** Envelopes currently buffered for this registration, when reported by status. */
  buffered?: number;
}

export interface VerifiedGitHubRelayRepository {
  repo: string;
  installationId: number;
  repositoryId: number;
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
  /** Most recently verified association; retained for older state readers. */
  github?: {
    repo: string;
    installationId: number;
    repositoryId: number;
  };
  /** All verified GitHub repositories paired for this workspace. */
  githubRepositories?: VerifiedGitHubRelayRepository[];
}

function isVerifiedGitHubRepository(
  repository: VerifiedGitHubRelayRepository | undefined,
): repository is VerifiedGitHubRelayRepository {
  return Boolean(
    repository?.repo &&
    Number.isSafeInteger(repository.installationId) &&
    repository.installationId > 0 &&
    Number.isSafeInteger(repository.repositoryId) &&
    repository.repositoryId > 0,
  );
}

/** Verified immutable GitHub associations, including the legacy single-repo field. */
export function verifiedGitHubRelayRepositories(
  state: RelayConnectState | null,
): VerifiedGitHubRelayRepository[] {
  if (!state) return [];
  const repositories = [
    ...(state.githubRepositories ?? []),
    ...(state.github ? [state.github] : []),
  ].filter(isVerifiedGitHubRepository);
  const byRepositoryId = new Map<number, VerifiedGitHubRelayRepository>();
  for (const repository of repositories) {
    byRepositoryId.set(repository.repositoryId, {
      ...repository,
      repo: repository.repo.toLowerCase(),
    });
  }
  return [...byRepositoryId.values()];
}

/** Whether this pairing can receive central GitHub App events. */
export function hasGitHubRelayRegistration(
  state: RelayConnectState | null,
  repo?: string,
): boolean {
  if (!state?.relayToken) return false;
  const repositories = verifiedGitHubRelayRepositories(state);
  return repo
    ? repositories.some((repository) => repository.repo === repo.toLowerCase())
    : repositories.length > 0;
}

/**
 * Whether relay state can route central-App events for a repository.
 *
 * Verified immutable repository ids remain the source of truth for setup UI,
 * but older workers may already have a live repo registration without those
 * newer local fields. Runtime handling accepts that legacy registration so a
 * CLI upgrade does not disable an already-delivering relay.
 */
export function hasGitHubRelayRouting(state: RelayConnectState | null, repo?: string): boolean {
  if (!state?.relayToken) return false;
  if (hasGitHubRelayRegistration(state, repo)) return true;
  return state.registrations.some(
    (registration) =>
      registration.kind === "repo" &&
      (!repo || registration.key.toLowerCase() === repo.toLowerCase()),
  );
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
 * Load persisted connect state, or null when this workspace is not connected.
 *
 * @param workingDir - Workspace root (defaults to cwd for low-level callers)
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
  repo?: string;
  installationId?: number;
  repositoryId?: number;
}

export interface RelayConnectDeps {
  /** Absolute workspace root (defaults to cwd for low-level callers). */
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the on-disk Supabase session. */
  getAccessToken?: () => Promise<string>;
  /** Injectable pairing wait for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Observe the GitHub installation URL (CLI prints it by default). */
  onGitHubInstallUrl?: (url: string) => void;
}

export type RelayConnectTarget =
  | "github"
  | "linear"
  | "asana"
  | "trello"
  | "azure-devops"
  | "jira"
  | "status";

export interface WorkspaceRelayConnectDeps extends RelayConnectDeps {
  workingDir: string;
  /** GitHub repository selected from workspace.toml by the fleet orchestrator. */
  repo?: string;
  /** Stable workspace team slug for tracker registration. */
  team?: string;
  /** Explicit tracker credentials for a selected workspace team. */
  env?: Record<string, string | undefined>;
}

const RELAY_CONNECT_TARGETS = new Set<RelayConnectTarget>([
  "github",
  "linear",
  "asana",
  "trello",
  "azure-devops",
  "jira",
  "status",
]);

async function resolveAccessToken(deps: RelayConnectDeps = {}): Promise<string> {
  if (deps.getAccessToken) {
    return deps.getAccessToken();
  }
  const workingDirs = [...new Set([deps.workingDir ?? process.cwd(), process.cwd()])];
  let lastError: unknown;
  for (const workingDir of workingDirs) {
    try {
      const user = await requireAuthenticatedUser(
        createDefaultSupabaseAuthConfig(authSessionPath(workingDir)),
        "devintern login",
      );
      return user.accessToken;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
  const sameCustomer = existing?.customerId === minted.customerId;
  const state: RelayConnectState = {
    relayUrl,
    customerId: minted.customerId,
    connectedAt: new Date().toISOString(),
    registrations: sameCustomer ? existing.registrations : [],
    relayToken: minted.relayToken,
    github: sameCustomer ? existing.github : undefined,
    githubRepositories: sameCustomer ? existing.githubRepositories : undefined,
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
  const previousForCustomer = previous?.customerId === data.customerId ? previous : null;
  const verifiedRepository =
    data.repo && typeof data.installationId === "number" && typeof data.repositoryId === "number"
      ? {
          repo: data.repo.toLowerCase(),
          installationId: data.installationId,
          repositoryId: data.repositoryId,
        }
      : undefined;
  const githubRepositories = verifiedGitHubRelayRepositories(previousForCustomer);
  if (verifiedRepository && isVerifiedGitHubRepository(verifiedRepository)) {
    const existingIndex = githubRepositories.findIndex(
      (repository) =>
        repository.repositoryId === verifiedRepository.repositoryId ||
        repository.repo === verifiedRepository.repo,
    );
    if (existingIndex === -1) githubRepositories.push(verifiedRepository);
    else githubRepositories[existingIndex] = verifiedRepository;
  }
  const state: RelayConnectState = {
    relayUrl,
    customerId: data.customerId,
    connectedAt: new Date().toISOString(),
    registrations: data.registrations,
    relayToken: relayToken ?? previousForCustomer?.relayToken,
    github: verifiedRepository ?? previousForCustomer?.github,
    githubRepositories,
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
  sleep?: (ms: number) => Promise<void>;
  onInstallUrl?: (url: string) => void;
}): Promise<RelayConnectState> {
  const deps: RelayConnectDeps = {
    workingDir: options.workingDir,
    relayUrl: options.relayUrl,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
  };
  const { relayToken } = await ensureRelayToken(options.accessToken, deps);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const workingDir = options.workingDir ?? process.cwd();

  const response = await connectRequest(
    options.accessToken,
    { action: "begin-github-pairing", repo: options.repo },
    deps,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }

  const pairing = (await response.json()) as {
    installUrl: string;
    pairingStatusUrl: string;
    expiresAt: number;
  };
  if (!pairing.installUrl || !pairing.pairingStatusUrl || !pairing.expiresAt) {
    throw new Error("relay returned an invalid GitHub pairing");
  }
  (options.onInstallUrl ?? deps.onGitHubInstallUrl)?.(pairing.installUrl);

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < pairing.expiresAt) {
    const statusResponse = await fetchImpl(pairing.pairingStatusUrl, {
      headers: { Authorization: `Bearer ${options.accessToken}` },
    });
    if (statusResponse.ok) {
      const data = (await statusResponse.json()) as ConnectResponse & {
        status: "pending" | "complete";
      };
      if (data.status === "complete") {
        return mergeConnectState(workingDir, relayUrl, data, relayToken);
      }
    } else if (statusResponse.status === 404) {
      throw new Error("GitHub pairing expired; run the connect command again");
    }
    await sleep(2000);
  }
  throw new Error("GitHub pairing timed out; run the connect command again");
}

/**
 * Register a tracker source with the relay, returning its ingest URL.
 *
 * @param options - Source name, optional client-generated signing secret
 */
export async function registerRelaySource(options: {
  source: string;
  team?: string;
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
      team: options.team,
      secret: options.secret,
    },
    deps,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as ConnectResponse & { ingestUrl: string };
  if (options.team) {
    const registration = data.registrations.find(
      (candidate) =>
        candidate.kind === "source" &&
        (candidate.team === options.team || candidate.key === `${options.source}:${options.team}`),
    );
    if (!registration) {
      throw new Error(
        "relay does not support team-scoped tracker registrations; " +
          "upgrade the relay control plane before using this CLI",
      );
    }
    // Accept the transitional compound-key representation while always
    // persisting an explicit team dimension for current state readers.
    registration.team = options.team;
  }
  const state = mergeConnectState(workingDir, relayUrl, data, relayToken);
  return { ingestUrl: data.ingestUrl, state };
}

/** Random 32-byte hex secret for webhook signing (Linear). */
function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatTimestamp(epochMs: number | null): string {
  return epochMs === null ? "never" : new Date(epochMs).toLocaleString();
}

/**
 * Connect one relay target using workspace-scoped state.
 *
 * @param target - Relay source to connect
 * @param deps - Optional injectables for tests
 * @returns Process exit code
 */
export async function connectRelayTarget(
  target: string,
  deps: WorkspaceRelayConnectDeps,
): Promise<number> {
  if (!RELAY_CONNECT_TARGETS.has(target as RelayConnectTarget)) {
    console.error(
      `❌ Unsupported connect target '${target}'. ` +
        "Available: github, linear, asana, trello, azure-devops, jira, status.",
    );
    return 1;
  }
  const repo = target === "github" ? deps.repo : undefined;
  const env = deps.env ?? process.env;
  const workingDir = deps.workingDir;
  const resolvedDeps: RelayConnectDeps = { ...deps, workingDir };

  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(resolvedDeps);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }

  const connectOpts = {
    accessToken,
    workingDir,
    team: deps.team,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
  };

  if (target === "status") {
    try {
      const { relayToken } = await ensureRelayToken(accessToken, resolvedDeps);
      const status = await fetchRelayStatus({ relayToken, ...resolvedDeps });
      console.log(`📡 Relay: ${resolveRelayUrl()}`);
      console.log(`   Customer: ${status.customerId} (${status.licenseSource})`);
      console.log(`   Buffered envelopes: ${status.buffered}`);
      if (status.registrations.length === 0) {
        console.log("   No registrations yet. Run: devintern worker connect");
      }
      for (const reg of status.registrations) {
        const team = reg.team ? ` (team: ${reg.team})` : "";
        const buffered = reg.buffered === undefined ? "" : `, buffered: ${reg.buffered}`;
        console.log(
          `   - ${reg.kind}:${reg.key}${team} (last event: ${formatTimestamp(reg.lastEventAt)}${buffered})`,
        );
      }
      return 0;
    } catch (error) {
      console.error(`❌ Relay status failed: ${(error as Error).message}`);
      return 1;
    }
  }

  if (target === "linear") {
    const apiKey = env.LINEAR_API_KEY;
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
    const apiToken = env.ASANA_API_TOKEN;
    const projectGid = env.ASANA_DEFAULT_PROJECT_GID;
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
    const apiKey = env.TRELLO_API_KEY;
    const apiToken = env.TRELLO_API_TOKEN;
    const boardId = env.TRELLO_DEFAULT_BOARD_ID;
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
    const organization = env.AZURE_DEVOPS_ORG;
    const pat = env.AZURE_DEVOPS_PAT;
    const project = env.AZURE_DEVOPS_PROJECT;
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

  if (!repo) {
    console.error("❌ GitHub relay connection requires a workspace repository.");
    return 1;
  }

  try {
    let installUrl = "";
    const state = await connectGitHubRepo({
      repo,
      ...connectOpts,
      sleep: deps.sleep,
      onInstallUrl(url) {
        installUrl = url;
        deps.onGitHubInstallUrl?.(url);
        console.log("Open this URL to install and authorize the DevIntern GitHub App:");
        console.log(`   ${url}`);
        console.log("Waiting for GitHub verification...");
      },
    });
    console.log(`✅ Connected ${repo} to the relay (${state.relayUrl})`);
    console.log(`   Customer: ${state.customerId}`);
    console.log(`   GitHub App authorization verified${installUrl ? "." : ""}`);
    saveGitHubAppRecord(
      {
        repo: state.github?.repo.toLowerCase() ?? repo.toLowerCase(),
        enabled: true,
        connectedAt: new Date().toISOString(),
        installationId: state.github?.installationId,
        repositoryId: state.github?.repositoryId,
      },
      workingDir,
    );
    console.log("   Keep GITHUB_TOKEN configured locally for GitHub API reads/writes.");
    console.log("   Run the worker as usual: devintern worker");
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
