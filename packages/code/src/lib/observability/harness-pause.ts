/**
 * Read-only view of whether the worker's harness chain is usage-limited.
 *
 * Shared by the dashboard Overview (`dashboard-overview.ts`) and
 * `devintern worker add` (which warns when a new task cannot start yet). It
 * only reads the workspace `.env`, the process env, and the persisted
 * `rate_limit:*` windows in the workspace DB: no processes are spawned and no
 * harness install checks run, so it is cheap enough for a CLI hot path.
 */

import { parseHarnessList } from "@devintern/agent-harness";

import { parseEnvFile } from "../workspace/env";
import { workspaceEnvPath } from "../workspace/paths";
import { readDashboardFailoverState } from "./dashboard-db";

/** Where the effective `AGENT_HARNESS` came from. */
export type HarnessChainSource = "workspace_env" | "process_env" | "default";

/**
 * Resolve the raw `AGENT_HARNESS` the worker would use. The workspace worker
 * applies the workspace `.env` over its process env at startup, so that file
 * wins; a non-workspace worker only has its process env.
 */
export function resolveHarnessChainSource(workspaceDir: string): {
  raw: string | undefined;
  source: HarnessChainSource;
} {
  let fromWorkspace: string | undefined;
  try {
    fromWorkspace = parseEnvFile(workspaceEnvPath(workspaceDir)).AGENT_HARNESS;
  } catch {
    fromWorkspace = undefined;
  }
  if (fromWorkspace?.trim()) return { raw: fromWorkspace, source: "workspace_env" };
  const fromProcess = process.env.AGENT_HARNESS;
  if (fromProcess?.trim()) return { raw: fromProcess, source: "process_env" };
  return { raw: undefined, source: "default" };
}

/** The worker's harness chain is exhausted: every entry has an open window. */
export interface WorkerHarnessPause {
  /** Ordered chain (priority first), as the worker parses `AGENT_HARNESS`. */
  chain: string[];
  /** Where the chain came from. */
  source: HarnessChainSource;
  /**
   * Earliest open window (epoch ms): when it elapses the worker resumes,
   * matching `HarnessFailover.earliestResetMs`.
   */
  untilMs: number;
}

/**
 * Whether every entry of the worker's harness chain has an open persisted
 * usage-limit window.
 *
 * Best-effort: any read failure (missing/corrupt DB, unreadable `.env`)
 * yields null, as does a chain with at least one healthy entry. Process-only
 * startup-failure cooldowns are not persisted and so are not considered.
 *
 * @param workspaceDir - Workspace home (for the `.env`)
 * @param dbPath - Workspace DB holding the `rate_limit:*` windows
 * @param nowMs - Clock (tests)
 */
export function readWorkerHarnessPause(
  workspaceDir: string,
  dbPath: string,
  nowMs: number = Date.now(),
): WorkerHarnessPause | null {
  try {
    const { raw, source } = resolveHarnessChainSource(workspaceDir);
    const chain = parseHarnessList(raw);
    if (chain.length === 0) return null;
    const failover = readDashboardFailoverState(dbPath);
    if (!failover) return null;
    let untilMs = Number.POSITIVE_INFINITY;
    for (const name of chain) {
      const window = failover.rateLimits[name];
      if (window === undefined || !(window > nowMs)) return null;
      untilMs = Math.min(untilMs, window);
    }
    return { chain, source, untilMs };
  } catch {
    return null;
  }
}
