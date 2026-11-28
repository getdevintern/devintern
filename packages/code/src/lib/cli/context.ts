import type { ResolvedHarness } from "@devintern/agent-harness";
import { RUN_ORIGIN_ENV } from "../observability/analytics";
import type { HeldLocks } from "../task/ticket-lock";
import type { ManualWorkspaceRun } from "../workspace/manual-run";
import type { TaskTrackerClient } from "../trackers/client";
import type { ProgramOptions } from "./program";

/** A task actively being processed, so signal/error paths can leave feedback. */
export interface ActiveTaskContext {
  taskKey: string;
  tracker: TaskTrackerClient;
  projectKey: string;
  movedToInProgress: boolean;
  /**
   * Set when this run attempted a PR on a supported code host and it failed
   * (5xx, rate limit, expired token). The worker then leaves the ticket
   * unmarked so the next poll retries delivery.
   */
  prCreationFailure?: string;
  /**
   * Set whenever this run pushed its branch but the requested PR could not be
   * created on a supported code host, permanent or retryable. The pipeline
   * records such a run as `failed` instead of `succeeded`.
   */
  prDeliveryFailure?: PrDeliveryFailure;
  /**
   * Set when the run's stacked base closed without merging (or could not be
   * followed) mid-run: the actionable reason the run escalates with.
   */
  stackBlocked?: string;
  /**
   * Set when delivery accepted a run with nothing to commit because the agent
   * reported `status=noop`: the `noop: …` outcome reason the run is recorded
   * with.
   */
  noopDeliveryReason?: string;
}

/** A PR that was requested after a successful push but could not be created. */
export interface PrDeliveryFailure {
  message: string;
  /** Auth, not found, validation, or missing config: a re-run cannot fix it. */
  permanent: boolean;
}

/**
 * Mutable state shared across one CLI run. Extracted from the entrypoint so
 * command and pipeline modules can share options, the resolved agent, the
 * single-instance lock, and the in-flight task without importing `index.ts`.
 */
export const runContext = {
  options: undefined as unknown as ProgramOptions,
  resolvedAgent: undefined as unknown as ResolvedHarness,
  autoReviewIterationCap: undefined as number | undefined,
  /** Checkout and per-ticket locks, released together on exit. */
  lockManager: null as HeldLocks | null,
  /** Workspace repo this manual run resolved from the checkout's `origin`. */
  manualWorkspace: null as ManualWorkspaceRun | null,
  activeTaskContext: null as ActiveTaskContext | null,
};

/** Whether this process was spawned by the worker/scheduler rather than a person. */
export function isWorkerTaskProcess(): boolean {
  const origin = process.env[RUN_ORIGIN_ENV];
  return (
    origin === "worker" ||
    origin === "error_monitor" ||
    origin === "scheduled" ||
    origin === "estimate" ||
    origin === "manual" ||
    origin === "local"
  );
}
