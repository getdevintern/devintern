/**
 * Per-worker relay identity.
 *
 * Every worker workspace registers its own identity with the relay
 * (`POST /v1/worker/register`), bound to its durable relay token. The relay
 * routes events for a registration (GitHub repository, GitLab project,
 * tracker source) only to the worker that owns it, so two workers on one
 * account never both act on the same event. A new identity starts at the
 * relay's current buffer head, so a freshly connected worker never replays
 * old events.
 *
 * Older relays answer 404 here; the worker then keeps the customer-level
 * delivery it always had.
 */

import { createHash } from "crypto";
import { hostname } from "os";
import { resolve } from "path";

import {
  describeOwnershipConflict,
  fetchRelayStatus,
  loadRelayState,
  parseOwnershipConflicts,
  relayResponseError,
  resolveRelayUrl,
  saveRelayState,
  verifiedGitHubRelayRepositories,
} from "./state";
import type {
  RelayConnectState,
  RelayOwnershipConflict,
  RelayRegistrationRef,
  RelayWorkerIdentity,
} from "./state";

const WORKER_ID_PATTERN = /^wkr_[a-f0-9]{32}$/;
const MAX_LABEL_LENGTH = 120;
const REGISTER_TIMEOUT_MS = 15_000;

/**
 * Label other workers of the account see for this one: the hostname plus a
 * short hash of the workspace path, so two workspaces on one host differ
 * without revealing the path.
 */
export function relayWorkerLabel(workspaceDir: string, host: string = hostname()): string {
  const hash = createHash("sha256").update(resolve(workspaceDir)).digest("hex").slice(0, 8);
  const name = [...(host || "worker")].filter((char) => char > " " && char !== "\x7f").join("");
  return `${name.slice(0, MAX_LABEL_LENGTH - 12) || "worker"}:ws-${hash}`;
}

/** Relay key of a GitLab project registration (matches the relay's code-host key). */
function gitLabRegistrationKey(instanceUrl: string, projectId: string): string {
  return `gitlab:${instanceUrl.replace(/\/+$/, "")}:${projectId}`;
}

/** Registrations this workspace connected, which its worker asks to own. */
export function relayWorkerClaims(state: RelayConnectState | null): RelayRegistrationRef[] {
  if (!state) return [];
  const claims: RelayRegistrationRef[] = [];
  for (const repository of verifiedGitHubRelayRepositories(state)) {
    claims.push({ kind: "repo", key: repository.repo });
  }
  for (const project of state.gitlabRepositories ?? []) {
    claims.push({
      kind: "code-host",
      key: gitLabRegistrationKey(project.instanceUrl, project.projectId),
    });
  }
  for (const source of state.sources ?? []) {
    claims.push({
      kind: "source",
      key: source.source,
      ...(source.team ? { team: source.team } : {}),
    });
  }
  return claims;
}

/** Display name for a registration ref (`acme/webapp`, `jira (team growth)`, ...). */
export function describeRegistrationRef(ref: RelayRegistrationRef): string {
  return ref.team ? `${ref.key} (team ${ref.team})` : ref.key;
}

export type RelayWorkerRegistration =
  /** The relay predates per-worker routing; delivery stays customer-level. */
  | { kind: "unsupported" }
  | {
      kind: "ok";
      worker: RelayWorkerIdentity;
      /** Whether this call created the identity (it then starts at `cursor`). */
      created: boolean;
      /** The relay buffer head right now. */
      cursor: number;
      claimed: RelayRegistrationRef[];
      conflicts: RelayOwnershipConflict[];
    };

export interface RegisterRelayWorkerOptions {
  relayToken: string;
  workingDir: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Move registrations another live worker owns to this worker. */
  takeover?: boolean;
  /** Override the label (tests); defaults to {@link relayWorkerLabel}. */
  label?: string;
}

function sameRef(a: RelayRegistrationRef, b: RelayRegistrationRef): boolean {
  return a.kind === b.kind && a.key === b.key && (a.team ?? "") === (b.team ?? "");
}

/** A parsed `POST /v1/worker/register` response. */
interface RegisterResponse {
  workerId: string;
  label?: string;
  created: boolean;
  cursor: number;
  claimed: RelayRegistrationRef[];
  conflicts: RelayOwnershipConflict[];
}

function parseRegisterResponse(raw: unknown): RegisterResponse {
  const data = (raw ?? {}) as {
    worker?: { workerId?: unknown; label?: unknown };
    created?: unknown;
    cursor?: unknown;
    claimed?: unknown;
    conflicts?: unknown;
  };
  const workerId = data.worker?.workerId;
  if (typeof workerId !== "string" || !WORKER_ID_PATTERN.test(workerId)) {
    throw new Error("relay returned an invalid worker identity");
  }
  const cursor = data.cursor;
  return {
    workerId,
    ...(typeof data.worker?.label === "string" ? { label: data.worker.label } : {}),
    created: data.created === true,
    cursor: typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
    claimed: Array.isArray(data.claimed)
      ? (data.claimed as RelayRegistrationRef[]).filter(
          (ref) => typeof ref?.key === "string" && typeof ref.kind === "string",
        )
      : [],
    conflicts: parseOwnershipConflicts(data.conflicts),
  };
}

/**
 * Registrations the relay routes to `workerId` now. When status is
 * unavailable, the previously known ones (minus new conflicts) plus the
 * ones just claimed.
 */
async function ownedRegistrations(
  registered: RegisterResponse,
  prior: RelayWorkerIdentity | undefined,
  options: { relayToken: string; relayUrl: string; fetchImpl: typeof fetch },
): Promise<RelayRegistrationRef[]> {
  try {
    const status = await fetchRelayStatus(options);
    return status.registrations
      .filter((registration) => registration.ownerWorkerId === registered.workerId)
      .map((registration) => ({
        kind: registration.kind,
        key: registration.key,
        ...(registration.team ? { team: registration.team } : {}),
      }));
  } catch {
    const kept = (prior?.owned ?? []).filter(
      (ref) => !registered.conflicts.some((conflict) => sameRef(conflict, ref)),
    );
    return [
      ...kept,
      ...registered.claimed.filter((ref) => !kept.some((entry) => sameRef(entry, ref))),
    ];
  }
}

/**
 * Register (or reuse) this workspace's relay worker identity, claim the
 * registrations it connected, and persist the result in `relay.json`.
 *
 * @returns `unsupported` for relays without per-worker routing
 * @throws When the relay rejects the request (401, 403, 5xx, ...)
 */
export async function registerRelayWorker(
  options: RegisterRelayWorkerOptions,
): Promise<RelayWorkerRegistration> {
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const previous = loadRelayState(options.workingDir);
  const label = options.label ?? relayWorkerLabel(options.workingDir);
  const claims = relayWorkerClaims(previous);
  const response = await fetchImpl(`${relayUrl}/v1/worker/register`, {
    method: "POST",
    // Worker startup waits on this; a hung relay must not stall it.
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${options.relayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label,
      ...(previous?.worker?.workerId ? { workerId: previous.worker.workerId } : {}),
      ...(claims.length > 0 ? { claims } : {}),
      ...(options.takeover ? { takeover: true } : {}),
    }),
  });
  if (response.status === 404 || response.status === 405) return { kind: "unsupported" };
  if (!response.ok) throw await relayResponseError(response);

  const registered = parseRegisterResponse(await response.json().catch(() => null));
  const prior = previous?.worker?.workerId === registered.workerId ? previous.worker : undefined;
  const keepPrior = prior !== undefined && !registered.created;
  const now = new Date().toISOString();
  const worker: RelayWorkerIdentity = {
    workerId: registered.workerId,
    label: registered.label ?? label,
    registeredAt: keepPrior ? prior.registeredAt : now,
    // Keep the creation-time head: events that arrived between connect and
    // the first worker start are this worker's to process.
    startCursor: keepPrior ? prior.startCursor : registered.cursor,
    owned: await ownedRegistrations(registered, prior, {
      relayToken: options.relayToken,
      relayUrl,
      fetchImpl,
    }),
    conflicts: registered.conflicts,
    checkedAt: now,
  };
  const latest = loadRelayState(options.workingDir);
  if (latest) saveRelayState({ ...latest, worker }, options.workingDir);
  return {
    kind: "ok",
    worker,
    created: registered.created,
    cursor: registered.cursor,
    claimed: registered.claimed,
    conflicts: registered.conflicts,
  };
}

/** The `worker connect` command that moves a registration to this worker. */
export function takeoverCommand(ref: RelayRegistrationRef): string {
  if (ref.kind === "repo") return "devintern worker connect github --takeover";
  if (ref.kind === "code-host") return "devintern worker connect gitlab --takeover";
  return `devintern worker connect ${ref.key}${ref.team ? ` --team ${ref.team}` : ""} --takeover`;
}

/** Human warning lines for registrations another worker owns, with the takeover command. */
export function describeWorkerConflicts(conflicts: RelayOwnershipConflict[]): string[] {
  return conflicts.map(
    (conflict) =>
      `${describeOwnershipConflict(conflict)}; this worker does not receive its events. ` +
      `To move it here: ${takeoverCommand(conflict)}`,
  );
}

/** Relay identity as `worker status` / `GET /api/worker` report it (never the token). */
export interface RelayWorkerView {
  relayUrl: string;
  workerId: string;
  label: string;
  owned: RelayRegistrationRef[];
  conflicts: Array<RelayRegistrationRef & { ownerLabel: string; lastSeenAt: string }>;
  /** ISO timestamp of the last successful registration. */
  checkedAt: string | null;
}

/** This workspace's relay worker identity from local state, or null when none is registered. */
export function relayWorkerView(workspaceDir: string): RelayWorkerView | null {
  let state: RelayConnectState | null;
  try {
    state = loadRelayState(workspaceDir);
  } catch {
    return null;
  }
  const worker = state?.worker;
  if (!state || !worker) return null;
  return {
    relayUrl: state.relayUrl,
    workerId: worker.workerId,
    label: worker.label,
    owned: worker.owned ?? [],
    conflicts: (worker.conflicts ?? []).map((conflict) => ({
      kind: conflict.kind,
      key: conflict.key,
      ...(conflict.team ? { team: conflict.team } : {}),
      ownerLabel: conflict.ownerLabel,
      lastSeenAt: new Date(conflict.lastSeenAt).toISOString(),
    })),
    checkedAt: worker.checkedAt ?? null,
  };
}
