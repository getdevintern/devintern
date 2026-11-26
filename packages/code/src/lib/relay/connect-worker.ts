/**
 * Connect outcomes and the per-worker identity step every relay connect
 * target runs first (see `worker-identity.ts`).
 */

import type { PendingGitHubPairing } from "./github-pairing";
import { ensureRelayToken, RelayOwnershipConflictError } from "./state";
import type { RelayConnectDeps, RelayOwnershipConflict } from "./state";
import {
  describeRegistrationRef,
  describeWorkerConflicts,
  registerRelayWorker,
  takeoverCommand,
} from "./worker-identity";

/** Structured result of one relay connect attempt. */
export type ConnectOutcome =
  | { kind: "connected"; target: string; repos?: string[]; relayUrl?: string }
  | { kind: "pending"; target: "github"; pairing: PendingGitHubPairing }
  | { kind: "not_signed_in"; target: string; error: string }
  | {
      kind: "failed";
      target: string;
      error: string;
      code?: string;
      /** Registrations another live worker owns (`registration_owned_by_other_worker`). */
      conflicts?: RelayOwnershipConflict[];
    };

/** Failure outcome for an error, keeping ownership conflicts machine-readable. */
export function failureOutcome(target: string, error: unknown): ConnectOutcome {
  if (error instanceof RelayOwnershipConflictError) {
    return {
      kind: "failed",
      target,
      error: error.message,
      code: error.code,
      conflicts: error.conflicts,
    };
  }
  return { kind: "failed", target, error: (error as Error).message };
}

/** Inputs of {@link connectWorkerIdentity}. */
export interface ConnectWorkerIdentityDeps {
  workingDir: string;
  accessToken: string;
  /** Deps for minting the relay token when none is stored. */
  relayDeps: RelayConnectDeps;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  team?: string;
  takeover?: boolean;
  onOutcome?: (outcome: ConnectOutcome) => void;
}

/** Registration kind a connect target owns, for picking its relevant conflicts. */
function conflictsForTarget(
  target: string,
  team: string | undefined,
  conflicts: RelayOwnershipConflict[],
): RelayOwnershipConflict[] {
  if (target === "status") return [];
  if (target === "github") return conflicts.filter((conflict) => conflict.kind === "repo");
  if (target === "gitlab") return conflicts.filter((conflict) => conflict.kind === "code-host");
  return conflicts.filter(
    (conflict) =>
      conflict.kind === "source" &&
      conflict.key === target &&
      (conflict.team ?? "") === (team ?? ""),
  );
}

/**
 * Register (or reuse) this workspace's relay worker identity before a
 * connect target runs, claiming what the workspace already connected.
 *
 * Registrations of this target that another live worker owns fail the
 * connect with `registration_owned_by_other_worker` unless `--takeover` moved
 * them. A relay without per-worker routing, or a transient registration
 * error, leaves the connect on account-level routing.
 */
export async function connectWorkerIdentity(
  target: string,
  deps: ConnectWorkerIdentityDeps,
): Promise<{ workerId?: string } | { failed: true }> {
  let registration;
  try {
    const { relayToken } = await ensureRelayToken(deps.accessToken, deps.relayDeps);
    registration = await registerRelayWorker({
      relayToken,
      workingDir: deps.workingDir,
      relayUrl: deps.relayUrl,
      fetchImpl: deps.fetchImpl,
      takeover: deps.takeover,
    });
  } catch (error) {
    console.warn(
      `⚠️  Could not register this worker with the relay (${(error as Error).message}); ` +
        "continuing with account-level routing.",
    );
    return {};
  }
  if (registration.kind === "unsupported") return {};
  const { worker, conflicts, claimed } = registration;
  console.log(`🪪 Relay worker: ${worker.label} (${worker.workerId})`);
  if (deps.takeover && claimed.length > 0) {
    console.log(`   Now served by this worker: ${claimed.map(describeRegistrationRef).join(", ")}`);
  }
  const relevant = conflictsForTarget(target, deps.team, conflicts);
  for (const line of describeWorkerConflicts(
    conflicts.filter((conflict) => !relevant.includes(conflict)),
  )) {
    console.warn(`⚠️  ${line}`);
  }
  if (relevant.length > 0) {
    const message =
      `${relevant.map((conflict) => describeRegistrationRef(conflict)).join(", ")} ` +
      `${relevant.length === 1 ? "is" : "are"} served by another worker on this account. ` +
      `Re-run with --takeover to move ${relevant.length === 1 ? "it" : "them"} here: ${takeoverCommand(relevant[0]!)}`;
    for (const line of describeWorkerConflicts(relevant)) console.error(`❌ ${line}`);
    deps.onOutcome?.(failureOutcome(target, new RelayOwnershipConflictError(message, relevant)));
    return { failed: true };
  }
  return { workerId: worker.workerId };
}
