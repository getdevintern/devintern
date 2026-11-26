/**
 * Relay connect state: persisted pairing records, the relay connect request,
 * and relay-token minting. Shared by the connect orchestration and the GitHub
 * pairing flow so neither imports the other.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { codeStateDirFor, resolveWorkspaceDir } from "../workspace/paths";

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
  kind: "repo" | "source" | "code-host";
  key: string;
  /** Stable workspace team slug for team-scoped tracker registrations. */
  team?: string;
  createdAt: number;
  lastEventAt: number | null;
  /** Envelopes currently buffered for this registration, when reported by status. */
  buffered?: number;
  provider?: string;
  instanceUrl?: string;
  projectId?: string;
  projectPath?: string;
  registrationId?: string;
  status?: string;
  hookId?: number;
  activatedAt?: number;
  /** Worker identity this registration routes to (newer relays; null when unowned). */
  ownerWorkerId?: string | null;
  ownerLabel?: string | null;
  ownerLastSeenAt?: number | null;
}

/** One relay registration a worker can own. */
export interface RelayRegistrationRef {
  kind: "repo" | "source" | "code-host";
  key: string;
  team?: string;
}

/** A registration another live worker of the same account owns. */
export interface RelayOwnershipConflict extends RelayRegistrationRef {
  ownerWorkerId: string;
  ownerLabel: string;
  /** Epoch milliseconds of the owner's last relay poll. */
  lastSeenAt: number;
}

/**
 * This workspace's relay worker identity. Events for registrations it owns
 * are delivered to it alone; see `docs/code/relay.md` (Multiple workers).
 */
export interface RelayWorkerIdentity {
  workerId: string;
  /** Human label shown to other workers: hostname plus a workspace path hash. */
  label: string;
  /** ISO timestamp of the registration that created this identity. */
  registeredAt: string;
  /** Relay buffer head when the identity was created; a worker with no cursor starts here. */
  startCursor: number;
  /** Registrations the relay routes to this worker, as of `checkedAt`. */
  owned?: RelayRegistrationRef[];
  /** Registrations this workspace serves that another live worker owns, as of `checkedAt`. */
  conflicts?: RelayOwnershipConflict[];
  /** ISO timestamp of the last successful identity registration. */
  checkedAt?: string;
}

/** A tracker source this workspace registered (so the worker can claim it). */
export interface RelaySourceRegistration {
  source: string;
  team?: string;
}

export interface VerifiedGitHubRelayRepository {
  repo: string;
  installationId: number;
  repositoryId: number;
}

/** Safe, durable identity for one relay-managed GitLab project hook. */
export interface VerifiedGitLabRelayRepository {
  instanceUrl: string;
  projectId: string;
  projectPath: string;
  hookId: number;
  registrationId: string;
  connectedAt: string;
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
  /** Relay-managed GitLab hooks. Webhook signing material is never persisted here. */
  gitlabRepositories?: VerifiedGitLabRelayRepository[];
  /** Tracker sources registered from this workspace. */
  sources?: RelaySourceRegistration[];
  /** Per-worker relay identity (newer relays). */
  worker?: RelayWorkerIdentity;
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

/** Return an exact active GitLab association for an instance and immutable project id. */
export function gitLabRelayRepository(
  state: RelayConnectState | null,
  instanceUrl: string,
  projectId: string,
): VerifiedGitLabRelayRepository | undefined {
  if (!state?.relayToken) return undefined;
  const normalizedInstance = instanceUrl.replace(/\/+$/, "").toLowerCase();
  return state.gitlabRepositories?.find(
    (repository) =>
      repository.instanceUrl.replace(/\/+$/, "").toLowerCase() === normalizedInstance &&
      repository.projectId === projectId,
  );
}

/** Whether a GitLab project path has a completed local relay registration. */
export function hasGitLabRelayRegistration(
  state: RelayConnectState | null,
  instanceUrl: string,
  projectPath: string,
): boolean {
  if (!state?.relayToken) return false;
  const instance = instanceUrl.replace(/\/+$/, "").toLowerCase();
  const path = projectPath.toLowerCase();
  return Boolean(
    state.gitlabRepositories?.some(
      (repository) =>
        repository.instanceUrl.replace(/\/+$/, "").toLowerCase() === instance &&
        repository.projectPath.toLowerCase() === path,
    ),
  );
}

/** Resolve the relay URL: env override, else the hosted default. */
export function resolveRelayUrl(): string {
  return (process.env.WORKER_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, "");
}

export function relayConfigDir(workingDir: string): string {
  return codeStateDirFor(workingDir);
}

function relayStatePath(workingDir: string): string {
  return join(relayConfigDir(workingDir), "relay.json");
}

export function authSessionPath(workingDir: string): string {
  return join(relayConfigDir(workingDir), ".auth-session.json");
}

/**
 * Load persisted connect state, or null when this workspace is not connected.
 *
 * @param workingDir - Workspace root (defaults to cwd for low-level callers)
 */
export function loadRelayState(
  workingDir: string = resolveWorkspaceDir(),
): RelayConnectState | null {
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

/** Persist connect state beside the auth session. */
export function saveRelayState(
  state: RelayConnectState,
  workingDir: string = resolveWorkspaceDir(),
): void {
  const path = relayStatePath(workingDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface ConnectResponse {
  customerId: string;
  licenseSource: string;
  registrations: RelayRegistration[];
  repo?: string;
  /** Repositories requested by this pairing. */
  repos?: string[];
  /** Repositories the installation verified, when the relay reports them. */
  repositories?: Array<{ repo: string; installationId: number; repositoryId: number }>;
  installationId?: number;
  repositoryId?: number;
}

export interface RelayConnectDeps {
  /** Absolute workspace root (defaults to cwd for low-level callers). */
  workingDir?: string;
  /** This workspace's relay worker id, sent with registrations (newer relays). */
  workerId?: string;
  /** Move registrations another live worker owns to this worker. */
  takeover?: boolean;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the on-disk Supabase session. */
  getAccessToken?: () => Promise<string>;
  /** Injectable pairing wait for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Observe the GitHub installation URL (CLI prints it by default). */
  onGitHubInstallUrl?: (url: string) => void;
}

/** Relay error code for a registration another live worker of the account owns. */
export const OWNERSHIP_CONFLICT_CODE = "registration_owned_by_other_worker";

/** The relay refused a registration because another live worker owns it. */
export class RelayOwnershipConflictError extends Error {
  readonly code = OWNERSHIP_CONFLICT_CODE;
  constructor(
    message: string,
    readonly conflicts: RelayOwnershipConflict[],
  ) {
    super(message);
    this.name = "RelayOwnershipConflictError";
  }
}

/** Parse relay conflict entries, dropping malformed ones. */
export function parseOwnershipConflicts(raw: unknown): RelayOwnershipConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: Record<string, unknown> | null) => {
    if (
      !entry ||
      (entry.kind !== "repo" && entry.kind !== "source" && entry.kind !== "code-host") ||
      typeof entry.key !== "string" ||
      typeof entry.ownerWorkerId !== "string" ||
      typeof entry.ownerLabel !== "string" ||
      typeof entry.lastSeenAt !== "number"
    ) {
      return [];
    }
    return [
      {
        kind: entry.kind,
        key: entry.key,
        ...(typeof entry.team === "string" ? { team: entry.team } : {}),
        ownerWorkerId: entry.ownerWorkerId,
        ownerLabel: entry.ownerLabel,
        lastSeenAt: entry.lastSeenAt,
      },
    ];
  });
}

/** One line naming who owns a conflicting registration. */
export function describeOwnershipConflict(conflict: RelayOwnershipConflict): string {
  const name = conflict.team ? `${conflict.key} (team ${conflict.team})` : conflict.key;
  return `${name} is served by worker "${conflict.ownerLabel}" (last seen ${new Date(conflict.lastSeenAt).toISOString()})`;
}

/**
 * Error for a failed relay response: a typed ownership conflict for 409
 * `registration_owned_by_other_worker`, otherwise the relay's `error` text.
 */
export async function relayResponseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
    conflicts?: unknown;
  } | null;
  const message =
    typeof body?.error === "string" ? body.error : `relay returned HTTP ${response.status}`;
  if (response.status === 409 && body?.code === OWNERSHIP_CONFLICT_CODE) {
    return new RelayOwnershipConflictError(message, parseOwnershipConflicts(body.conflicts));
  }
  return new Error(message);
}

/** `workerId`/`takeover` connect-body fields; empty for relays without worker identities. */
export function workerFields(deps: RelayConnectDeps): Record<string, unknown> {
  return deps.workerId
    ? { workerId: deps.workerId, ...(deps.takeover ? { takeover: true } : {}) }
    : {};
}

export async function connectRequest(
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
 * Ensure `state/code/relay.json` holds a usable relay token, minting one
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
    gitlabRepositories: sameCustomer ? existing.gitlabRepositories : undefined,
    sources: sameCustomer ? existing.sources : undefined,
    // The identity survives a re-issued token: the next registration rebinds it by id.
    worker: sameCustomer ? existing.worker : undefined,
  };
  saveRelayState(state, workingDir);
  return { relayToken: minted.relayToken, state };
}

export function mergeConnectState(
  workingDir: string,
  relayUrl: string,
  data: ConnectResponse,
  relayToken: string | undefined,
): RelayConnectState {
  const previous = loadRelayState(workingDir);
  const previousForCustomer = previous?.customerId === data.customerId ? previous : null;
  const verified = verifiedRepositoriesFromResponse(data);
  const githubRepositories = verifiedGitHubRelayRepositories(previousForCustomer);
  for (const repository of verified) {
    if (!isVerifiedGitHubRepository(repository)) continue;
    const existingIndex = githubRepositories.findIndex(
      (candidate) =>
        candidate.repositoryId === repository.repositoryId || candidate.repo === repository.repo,
    );
    if (existingIndex === -1) githubRepositories.push(repository);
    else githubRepositories[existingIndex] = repository;
  }
  const state: RelayConnectState = {
    relayUrl,
    customerId: data.customerId,
    connectedAt: new Date().toISOString(),
    registrations: Array.isArray(data.registrations)
      ? data.registrations
      : (previousForCustomer?.registrations ?? []),
    relayToken: relayToken ?? previousForCustomer?.relayToken,
    github: verified[0] ?? previousForCustomer?.github,
    githubRepositories,
    gitlabRepositories: previousForCustomer?.gitlabRepositories,
    sources: previousForCustomer?.sources,
    worker: previousForCustomer?.worker,
  };
  saveRelayState(state, workingDir);
  return state;
}

/**
 * Read the repositories a pairing verified.
 *
 * Newer relays return one entry per repository; older relays only return the
 * single primary repository fields, which stay supported.
 */
export function verifiedRepositoriesFromResponse(
  data: ConnectResponse,
): VerifiedGitHubRelayRepository[] {
  const listed = (data.repositories ?? [])
    .filter(
      (repository): repository is { repo: string; installationId: number; repositoryId: number } =>
        typeof repository?.repo === "string" &&
        typeof repository.installationId === "number" &&
        typeof repository.repositoryId === "number",
    )
    .map((repository) => ({
      repo: repository.repo.toLowerCase(),
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
    }));
  if (listed.length > 0) return listed;
  if (
    data.repo &&
    typeof data.installationId === "number" &&
    typeof data.repositoryId === "number"
  ) {
    return [
      {
        repo: data.repo.toLowerCase(),
        installationId: data.installationId,
        repositoryId: data.repositoryId,
      },
    ];
  }
  return [];
}

export interface RelayStatusResponse {
  customerId: string;
  licenseSource: string;
  buffered: number;
  registrations: RelayRegistration[];
  /** This token's worker identity; null for an identity-less token (newer relays). */
  worker?: { workerId: string; label: string; lastSeenAt: number } | null;
  /** Every worker identity of the account (newer relays). */
  workers?: Array<{ workerId: string; label: string; lastSeenAt: number; stale?: boolean }>;
  /** Present when this token has no identity while other workers do. */
  upgrade?: { code: string; message: string };
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
}): Promise<RelayStatusResponse> {
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${relayUrl}/v1/status`, {
    headers: { Authorization: `Bearer ${options.relayToken}` },
  });
  if (!response.ok) {
    throw await relayResponseError(response);
  }
  return (await response.json()) as RelayStatusResponse;
}
