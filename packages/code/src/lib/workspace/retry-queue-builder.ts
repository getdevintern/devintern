/**
 * Dashboard retry drain wiring: runs each scheduled retry through the fleet
 * executor and, for tracker tickets, the source's native-blocker gate.
 */

import { parseEnvInteger } from "../config/env-integer";
import type { ScheduledRetryStore } from "../state/run-retry";
import { getWorkerFailover } from "../worker/failover";
import { findTeam } from "./config";
import {
  createGatedFleetTaskExecutor,
  fleetTaskArgs,
  resolveActionedSource,
} from "./fleet-executor";
import type { FleetExecutorDeps } from "./fleet-executor";
import { workspaceDbPath } from "./paths";
import { RetryQueueAcquirer } from "./retry-acquirer";
import type { TrackerDependencyGate } from "./tracker-dependency-gate";

/**
 * Build the dashboard retry drain acquirer: claims durable retry rows and runs
 * each through the fleet executor with the persisted repo/team pinned and
 * `--force` prepended.
 */
export function buildRetryQueueAcquirer(
  deps: FleetExecutorDeps,
  store: ScheduledRetryStore,
  verbose?: boolean,
  dependencyGateFor?: (team: string | undefined) => TrackerDependencyGate | undefined,
): RetryQueueAcquirer {
  return new RetryQueueAcquirer({
    store,
    runDbPath: workspaceDbPath(deps.workspaceDir),
    execute: async (taskKey, routable, retry, queueClaim) => {
      const retryTeam = retry.team ? findTeam(deps.config, retry.team) : undefined;
      // Dashboard retries are tracker tickets: run them through their
      // source's native-blocker gate like a poll would, so a ticket still
      // waiting does not start out of order and a stacked one keeps its base
      // (the gate's verdict feeds `STACKED_ON_ENV`).
      const sourceGate = dependencyGateFor?.(retry.team);
      let held: string | undefined;
      const dependencyGate: TrackerDependencyGate | undefined = sourceGate
        ? async (key, repo) => {
            const outcome = await sourceGate(key, repo);
            if (outcome.kind !== "ready") held = outcome.reason;
            return outcome;
          }
        : undefined;
      const result = await createGatedFleetTaskExecutor(
        {
          ...deps,
          ...(retryTeam ? { team: retryTeam } : {}),
          actionedSource: resolveActionedSource(deps.config, retryTeam),
        },
        // The persisted repo/team make retries deterministic even when
        // task keys overlap or the original route depended on labels.
        {
          extraArgs: () => ["--force", ...fleetTaskArgs(deps.config)],
          repo: retry.repo,
          queueClaim,
          source: "retry",
          // Pin the run this retry targets so session pickup resumes its
          // branch and prior report instead of the just-opened run.
          pickupRunId: retry.runId,
          dependencyGate,
        },
      )(taskKey, routable);
      if (result === "waiting") {
        // Settle the row instead of requeueing it: the drain stops at a
        // deferred row, so a long wait would hold up every later retry. The
        // poller still re-checks the ticket and starts it once unblocked.
        throw new Error(`not started, ${held ?? "blockers not satisfied"}`);
      }
      return result;
    },
    intervalSeconds: parseEnvInteger("WORKER_RETRY_INTERVAL_SECONDS", 5, { min: 1 }),
    isPaused: () => getWorkerFailover()?.allExhausted() ?? false,
    verbose,
  });
}
