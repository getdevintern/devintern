import type { ResolvedHarness } from "@devintern/agent-harness";
import { RUN_ORIGIN_ENV } from "../observability/analytics";
import type { LockManager } from "../lock-manager";
import type { TaskTrackerClient } from "../trackers/client";
import type { ProgramOptions } from "./program";

/** A task actively being processed, so signal/error paths can leave feedback. */
export interface ActiveTaskContext {
  taskKey: string;
  tracker: TaskTrackerClient;
  projectKey: string;
  movedToInProgress: boolean;
}

/**
 * Mutable state shared across one CLI run. Extracted from the entrypoint so
 * command and pipeline modules can share options, the resolved agent, the
 * single-instance lock, and the in-flight task without importing `index.ts`.
 */
export const runContext = {
  options: undefined as unknown as ProgramOptions,
  resolvedAgent: undefined as unknown as ResolvedHarness,
  lockManager: null as LockManager | null,
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
    origin === "manual"
  );
}
