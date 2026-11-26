/**
 * GitHub App pairing: browser-free verification through an existing
 * installation, the browser pairing (begin, record, poll), and the owner-only
 * record that lets `worker connect github --status` finish a pairing later.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { saveGitHubAppRecord } from "../code-host/github/app-setup";
import { redactSecrets } from "../observability/worker-logs";
import {
  connectRequest,
  ensureRelayToken,
  loadRelayState,
  mergeConnectState,
  parseOwnershipConflicts,
  relayConfigDir,
  RelayOwnershipConflictError,
  relayResponseError,
  resolveRelayUrl,
  verifiedGitHubRelayRepositories,
  verifiedRepositoriesFromResponse,
  workerFields,
} from "./state";
import type {
  ConnectResponse,
  RelayConnectDeps,
  RelayConnectState,
  RelayOwnershipConflict,
  VerifiedGitHubRelayRepository,
} from "./state";

/** A repository the relay could not verify without a browser pairing. */
export interface UnverifiedGitHubRelayRepository {
  repo: string;
  /** Relay reason code, e.g. `not_installed`. */
  reason: string;
}

/** Result of a browser-free GitHub repository verification. */
export type GitHubRepoVerificationResult =
  | { kind: "unsupported" }
  | {
      kind: "ok";
      state: RelayConnectState;
      /** Requested repositories that are now verified in relay state. */
      verified: VerifiedGitHubRelayRepository[];
      /** Requested repositories that still need the browser pairing. */
      unverified: UnverifiedGitHubRelayRepository[];
      /** Verified repositories another worker of the account serves (unattended verify). */
      conflicts: RelayOwnershipConflict[];
    };

interface VerifyResponse extends ConnectResponse {
  unverified?: Array<{ repo?: unknown; reason?: unknown }>;
  conflicts?: unknown;
}

function normalizeRepoList(repos: string[]): string[] {
  return [
    ...new Set(repos.map((repo) => repo.trim().toLowerCase()).filter((repo) => repo.length > 0)),
  ];
}

/**
 * Whether a failed verification response means the relay cannot verify
 * without a browser: older relays reject the connect action (400) or lack the
 * data-plane route (404), and 503 means the relay is not configured for it.
 */
async function isVerificationUnsupported(response: Response): Promise<boolean> {
  if (response.status === 404 || response.status === 503) return true;
  if (response.status !== 400) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.includes("unsupported action");
}

/** Merge a 200 verification response into relay state and report requested repos. */
async function applyVerificationResponse(
  response: Response,
  requested: string[],
  workingDir: string,
  relayUrl: string,
  relayToken: string | undefined,
): Promise<GitHubRepoVerificationResult> {
  if (!response.ok) {
    if (await isVerificationUnsupported(response)) return { kind: "unsupported" };
    throw await relayResponseError(response);
  }
  const data = (await response.json().catch(() => null)) as VerifyResponse | null;
  if (!data || typeof data.customerId !== "string" || !data.customerId) {
    throw new Error("relay returned an invalid GitHub verification response");
  }
  const reasons = new Map<string, string>();
  for (const entry of Array.isArray(data.unverified) ? data.unverified : []) {
    if (typeof entry?.repo !== "string") continue;
    reasons.set(
      entry.repo.toLowerCase(),
      typeof entry.reason === "string" ? entry.reason : "unverified",
    );
  }
  // Leave relay state untouched when nothing new verified.
  const newlyVerified = verifiedRepositoriesFromResponse(data).length > 0;
  const existing = newlyVerified ? null : loadRelayState(workingDir);
  const state = existing ?? mergeConnectState(workingDir, relayUrl, data, relayToken);
  // The relay is authoritative for the repos it was asked about: a repo it
  // reports unverified (e.g. the App lost access) stays unverified even when
  // local state still lists it from an earlier pairing.
  const verified = verifiedGitHubRelayRepositories(state).filter(
    (repository) => requested.includes(repository.repo) && !reasons.has(repository.repo),
  );
  const unverified = requested
    .filter((repo) => !verified.some((repository) => repository.repo === repo))
    .map((repo) => ({ repo, reason: reasons.get(repo) ?? "unverified" }));
  if (newlyVerified) {
    for (const repository of verified) {
      saveGitHubAppRecord(
        {
          repo: repository.repo,
          enabled: true,
          connectedAt: new Date().toISOString(),
          installationId: repository.installationId,
          repositoryId: repository.repositoryId,
        },
        workingDir,
      );
    }
  }
  return {
    kind: "ok",
    state,
    verified,
    unverified,
    conflicts: parseOwnershipConflicts(data.conflicts),
  };
}

/**
 * Verify GitHub repositories without a browser using the signed-in session
 * (`/v1/connect` action `verify-github-repos`). Only repositories under an
 * installation this customer already paired can verify this way.
 *
 * @returns `unsupported` when the relay predates the action
 */
export async function verifyGitHubReposWithSession(options: {
  repos: string[];
  accessToken: string;
  relayToken?: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  workerId?: string;
  takeover?: boolean;
}): Promise<GitHubRepoVerificationResult> {
  const repos = normalizeRepoList(options.repos);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const response = await connectRequest(
    options.accessToken,
    { action: "verify-github-repos", repos, ...workerFields(options) },
    { relayUrl, fetchImpl: options.fetchImpl },
  );
  return applyVerificationResponse(
    response,
    repos,
    options.workingDir ?? process.cwd(),
    relayUrl,
    options.relayToken,
  );
}

/**
 * Verify GitHub repositories without a browser using the worker's durable
 * relay token (`/v1/github/verify`). Used by the worker, which never opens a
 * browser.
 *
 * @returns `unsupported` when the relay predates the route
 */
export async function verifyGitHubReposWithRelayToken(options: {
  repos: string[];
  relayToken: string;
  workingDir: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubRepoVerificationResult> {
  const repos = normalizeRepoList(options.repos);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${relayUrl}/v1/github/verify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.relayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repos }),
  });
  return applyVerificationResponse(
    response,
    repos,
    options.workingDir,
    relayUrl,
    options.relayToken,
  );
}

/** Options shared by the GitHub pairing entry points. */
export interface GitHubRepoPairingOptions {
  /**
   * Repositories to verify with one App installation. All must belong to the
   * same GitHub account so one installation selection can grant them all.
   */
  repos: string[];
  accessToken: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Observe repositories verified through an existing installation (no browser). */
  onVerified?: (repos: string[]) => void;
  /** This workspace's relay worker id (newer relays). */
  workerId?: string;
  /** Move repositories another live worker owns to this worker. */
  takeover?: boolean;
}

/**
 * Verify what an existing installation already covers, then ask the relay for a
 * browser pairing for the rest. Never waits for the browser step.
 */
export async function startGitHubRepoPairing(
  options: GitHubRepoPairingOptions,
): Promise<GitHubPairingStart & { relayToken: string }> {
  const deps: RelayConnectDeps = {
    workingDir: options.workingDir,
    relayUrl: options.relayUrl,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    workerId: options.workerId,
    takeover: options.takeover,
  };
  const requested = normalizeRepoList(options.repos);
  if (requested.length === 0) {
    throw new Error("At least one repository is required to pair with the relay.");
  }

  const { relayToken } = await ensureRelayToken(options.accessToken, deps);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const workingDir = options.workingDir ?? process.cwd();

  // Repositories under an installation this customer already paired (for
  // example "All repositories" access) verify without a browser. Any failure
  // here falls back to the browser pairing, which works with every relay.
  let repos = requested;
  try {
    const verification = await verifyGitHubReposWithSession({
      repos: requested,
      accessToken: options.accessToken,
      relayToken,
      workingDir,
      relayUrl,
      fetchImpl: options.fetchImpl,
      workerId: options.workerId,
      takeover: options.takeover,
    });
    if (verification.kind === "unsupported") {
      console.log(
        "ℹ️  This relay cannot verify GitHub repositories without a browser; using the GitHub App pairing.",
      );
    } else {
      if (verification.verified.length > 0) {
        options.onVerified?.(verification.verified.map((repository) => repository.repo));
      }
      if (verification.unverified.length === 0) {
        return { kind: "verified", state: verification.state, relayToken };
      }
      for (const entry of verification.unverified) {
        if (entry.reason === "not_paired_or_installed") {
          console.log(
            `ℹ️  ${entry.repo}: the App installation isn't linked to this account yet; authorizing once links it.`,
          );
        }
      }
      repos = verification.unverified.map((entry) => entry.repo);
    }
  } catch (error) {
    // Another worker owns a repository: a browser pairing would be refused too.
    if (error instanceof RelayOwnershipConflictError) throw error;
    console.warn(
      `⚠️  Browser-free GitHub verification failed (${(error as Error).message}); ` +
        "continuing with the GitHub App pairing.",
    );
  }

  const pairing = await beginGitHubPairing(options.accessToken, repos, relayUrl, {
    ...deps,
    workingDir,
  });
  return { kind: "pending", pairing, relayToken };
}

/**
 * Register a GitHub repo with the relay and persist the connect state.
 *
 * @param options - Repo slug plus signed-in access token
 */
export async function connectGitHubRepo(
  options: GitHubRepoPairingOptions & {
    onInstallUrl?: (url: string, pairing: PendingGitHubPairing) => void;
  },
): Promise<RelayConnectState> {
  const start = await startGitHubRepoPairing(options);
  if (start.kind === "verified") return start.state;
  const { pairing, relayToken } = start;
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const workingDir = options.workingDir ?? process.cwd();
  options.onInstallUrl?.(pairing.installUrl, pairing);

  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < pairing.expiresAt) {
    const polled = await pollGitHubPairing({
      pairing,
      accessToken: options.accessToken,
      relayToken,
      workingDir,
      relayUrl,
      fetchImpl: options.fetchImpl,
    });
    if (polled.kind === "complete") {
      clearPendingGitHubPairing(workingDir);
      return polled.state;
    }
    if (polled.kind === "expired") {
      clearPendingGitHubPairing(workingDir);
      throw new Error("GitHub pairing expired; run the connect command again");
    }
    // Transient relay trouble (5xx, 429) keeps retrying until the deadline;
    // anything else (401, 403, 409, ...) cannot fix itself, so stop.
    if (polled.kind === "failure" && !isTransientPairingFailure(polled)) {
      throw new Error(describeGitHubPairingFailure(polled));
    }
    await sleep(2000);
  }
  clearPendingGitHubPairing(workingDir);
  throw new Error("GitHub pairing timed out; run the connect command again");
}

/** A GitHub App pairing that began but has not been confirmed yet. */
export interface PendingGitHubPairing {
  /** Relay pairing id (the last segment of the status URL). */
  id: string;
  installUrl: string;
  /** GitHub App user-authorization URL carrying the pairing state (newer relays). */
  authorizeUrl?: string;
  /** Whether the DevIntern App is already installed on the account (newer relays). */
  appInstalled?: boolean;
  pairingStatusUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  repos: string[];
  relayUrl: string;
}

/** An `authorizeUrl` is only trusted when it is an https URL on github.com. */
export function parseAuthorizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "github.com" && !host.endsWith(".github.com"))) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Lines telling the user which URL to open for a pending pairing. */
export function describePairingInstructions(pairing: PendingGitHubPairing): string[] {
  const { authorizeUrl, installUrl } = pairing;
  if (authorizeUrl && pairing.appInstalled === true) {
    const owner = pairing.repos[0]?.split("/")[0] ?? "this account";
    return [
      `The DevIntern App is already installed on ${owner}. Authorize it to link this worker:`,
      `   ${authorizeUrl}`,
      "To change which repositories it can access:",
      `   ${installUrl}`,
    ];
  }
  const lines = [
    "Open this URL to install and authorize the DevIntern GitHub App:",
    `   ${installUrl}`,
  ];
  if (authorizeUrl) {
    lines.push(
      "If GitHub shows the App's settings page instead of an install, open this to finish:",
      `   ${authorizeUrl}`,
    );
  }
  return lines;
}

/** The single URL a person (or agent) should open next. */
export function pairingNextUrl(pairing: PendingGitHubPairing): string {
  return pairing.authorizeUrl && pairing.appInstalled === true
    ? pairing.authorizeUrl
    : pairing.installUrl;
}

function pendingPairingPath(workingDir: string): string {
  return join(relayConfigDir(workingDir), "github-pairing.json");
}

/** Remember an unfinished pairing so `--status` can complete it later (owner-only file). */
export function savePendingGitHubPairing(pairing: PendingGitHubPairing, workingDir: string): void {
  const path = pendingPairingPath(workingDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pairing, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Load the unfinished pairing, or null when none was recorded or it is unreadable. */
export function loadPendingGitHubPairing(workingDir: string): PendingGitHubPairing | null {
  try {
    const data = JSON.parse(
      readFileSync(pendingPairingPath(workingDir), "utf8"),
    ) as Partial<PendingGitHubPairing>;
    if (
      typeof data.id === "string" &&
      typeof data.installUrl === "string" &&
      typeof data.pairingStatusUrl === "string" &&
      typeof data.expiresAt === "number" &&
      typeof data.relayUrl === "string" &&
      Array.isArray(data.repos)
    ) {
      const authorizeUrl = parseAuthorizeUrl(data.authorizeUrl);
      const appInstalled = typeof data.appInstalled === "boolean" ? data.appInstalled : undefined;
      return {
        ...(data as PendingGitHubPairing),
        authorizeUrl,
        appInstalled: authorizeUrl ? appInstalled : undefined,
      };
    }
  } catch {
    // Missing or corrupt: treat as no pending pairing.
  }
  return null;
}

/** Forget the unfinished pairing. */
export function clearPendingGitHubPairing(workingDir: string): void {
  rmSync(pendingPairingPath(workingDir), { force: true });
}

/** Ask the relay for a GitHub App pairing and remember it for `--status`. */
async function beginGitHubPairing(
  accessToken: string,
  repos: string[],
  relayUrl: string,
  deps: RelayConnectDeps,
): Promise<PendingGitHubPairing> {
  const response = await connectRequest(
    accessToken,
    { action: "begin-github-pairing", repo: repos[0], repos, ...workerFields(deps) },
    deps,
  );
  if (!response.ok) {
    throw await relayResponseError(response);
  }
  const data = (await response.json()) as {
    installUrl: string;
    pairingStatusUrl: string;
    expiresAt: number;
    authorizeUrl?: unknown;
    appInstalled?: unknown;
  };
  if (!data.installUrl || !data.pairingStatusUrl || !data.expiresAt) {
    throw new Error("relay returned an invalid GitHub pairing");
  }
  const pairing: PendingGitHubPairing = {
    id:
      data.pairingStatusUrl
        .replace(/[?#].*$/, "")
        .split("/")
        .filter(Boolean)
        .at(-1) ?? "",
    installUrl: data.installUrl,
    ...authorizeFields(data.authorizeUrl, data.appInstalled),
    pairingStatusUrl: data.pairingStatusUrl,
    expiresAt: data.expiresAt,
    repos,
    relayUrl,
  };
  savePendingGitHubPairing(pairing, deps.workingDir ?? process.cwd());
  return pairing;
}

function authorizeFields(
  authorizeUrl: unknown,
  appInstalled: unknown,
): Pick<PendingGitHubPairing, "authorizeUrl" | "appInstalled"> {
  const url = parseAuthorizeUrl(authorizeUrl);
  if (!url) return {};
  return { authorizeUrl: url, ...(typeof appInstalled === "boolean" ? { appInstalled } : {}) };
}

/** Machine-readable reason a pairing check failed at the relay. */
export type GitHubPairingFailureCode =
  | "relay_unauthorized"
  | "relay_unavailable"
  | "relay_rejected";

export type GitHubPairingFailure = {
  kind: "failure";
  code: GitHubPairingFailureCode;
  /** HTTP status the relay answered with. */
  status: number;
  /** Short, redacted excerpt of the relay's error body (may be empty). */
  detail: string;
};

export type GitHubPairingPoll =
  | { kind: "complete"; state: RelayConnectState }
  | { kind: "pending" }
  | { kind: "expired" }
  | GitHubPairingFailure;

const MAX_RELAY_ERROR_DETAIL = 200;

/** A short, single-line, secret-redacted excerpt of a relay error body. */
async function relayErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown } | null;
    const field = parsed?.error ?? parsed?.message;
    if (typeof field === "string") message = field;
  } catch {
    // Not JSON: use the raw text.
  }
  const flat = redactSecrets(message).replace(/\s+/g, " ").trim();
  return flat.length > MAX_RELAY_ERROR_DETAIL
    ? `${flat.slice(0, MAX_RELAY_ERROR_DETAIL)}...`
    : flat;
}

/** Classify a non-OK pairing status response (404 means expired and is handled by the caller). */
function pairingFailureCode(status: number): GitHubPairingFailureCode {
  if (status === 401 || status === 403) return "relay_unauthorized";
  if (status === 429 || status >= 500) return "relay_unavailable";
  return "relay_rejected";
}

/** Whether a failed pairing check is worth retrying within the wait window. */
export function isTransientPairingFailure(poll: GitHubPairingFailure): boolean {
  return poll.code === "relay_unavailable";
}

/** One-line description of a failed pairing check, with the next step. */
export function describeGitHubPairingFailure(poll: GitHubPairingFailure): string {
  const suffix = poll.detail ? `: ${poll.detail}` : "";
  if (poll.code === "relay_unauthorized") {
    return (
      `The relay rejected the session (HTTP ${poll.status})${suffix}. The session expired or is invalid; ` +
      "run `devintern worker login <method> --no-wait`, then check again."
    );
  }
  if (poll.code === "relay_unavailable") {
    return `The relay is unavailable (HTTP ${poll.status})${suffix}. Retry later.`;
  }
  return `The relay rejected the pairing check (HTTP ${poll.status})${suffix}.`;
}

/** Check a pairing once; merges relay state when the App authorization completed. */
export async function pollGitHubPairing(options: {
  pairing: PendingGitHubPairing;
  accessToken: string;
  relayToken?: string;
  workingDir: string;
  relayUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubPairingPoll> {
  // Only ever send the session token to the relay it was issued for.
  if (new URL(options.pairing.pairingStatusUrl).origin !== new URL(options.relayUrl).origin) {
    throw new Error(
      "The pending pairing belongs to a different relay; run `devintern worker connect github` again.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.pairing.pairingStatusUrl, {
    headers: { Authorization: `Bearer ${options.accessToken}` },
  });
  if (response.ok) {
    const data = (await response.json()) as ConnectResponse & { status: "pending" | "complete" };
    if (data.status === "complete") {
      const state = mergeConnectState(
        options.workingDir,
        options.relayUrl,
        data,
        options.relayToken,
      );
      for (const repository of verifiedGitHubRelayRepositories(state).filter((entry) =>
        options.pairing.repos.includes(entry.repo),
      )) {
        saveGitHubAppRecord(
          {
            repo: repository.repo,
            enabled: true,
            connectedAt: new Date().toISOString(),
            installationId: repository.installationId,
            repositoryId: repository.repositoryId,
          },
          options.workingDir,
        );
      }
      return { kind: "complete", state };
    }
    return { kind: "pending" };
  }
  if (response.status === 404) return { kind: "expired" };
  return {
    kind: "failure",
    code: pairingFailureCode(response.status),
    status: response.status,
    detail: await relayErrorDetail(response),
  };
}

/** Outcome of beginning a pairing without waiting for the browser step. */
export type GitHubPairingStart =
  | { kind: "verified"; state: RelayConnectState }
  | { kind: "pending"; pairing: PendingGitHubPairing };
