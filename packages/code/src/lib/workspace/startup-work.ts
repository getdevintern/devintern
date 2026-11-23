import type { InjectedTaskStore } from "../state/injected-tasks";
import type { ScheduledRetryStore } from "../state/run-retry";
import type { WorkspaceConfig } from "./config";

/** Whether the workspace config itself contains ongoing work. */
export function workspaceHasConfiguredWork(
  config: WorkspaceConfig,
  multiTeam: boolean,
  initialQuery: string | undefined,
): boolean {
  return (
    multiTeam ||
    Boolean(initialQuery) ||
    config.automations.length > 0 ||
    config.estimations.length > 0 ||
    config.errorMonitors.some((source) => source.enabled)
  );
}

/**
 * Whether startup has any work to keep the worker alive.
 *
 * Scheduled dashboard retries and queued/in-flight injected tasks are the
 * exceptions to the task-query requirement: the worker can still run to drain
 * them (and to recover an interrupted injected row under the post-lock hook).
 * A `running` injected row counts here because only that hook can resume or
 * fail it.
 */
export function workspaceHasStartupWork(
  config: WorkspaceConfig,
  retryQueue: Pick<ScheduledRetryStore, "hasPending">,
  injectedTasks: Pick<InjectedTaskStore, "hasPending" | "listRunning">,
  multiTeam: boolean,
  initialQuery: string | undefined,
): boolean {
  return (
    workspaceHasConfiguredWork(config, multiTeam, initialQuery) ||
    retryQueue.hasPending() ||
    injectedTasks.hasPending() ||
    injectedTasks.listRunning().length > 0
  );
}
