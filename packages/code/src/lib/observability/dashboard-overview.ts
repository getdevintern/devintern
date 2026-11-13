/**
 * `GET /api/overview` — capacity, harness failover, and tracker freshness for
 * the dashboard landing page.
 *
 * A separate endpoint instead of extending `GET /api/worker`: the status strip
 * polls `/api/worker` on every page, while this view also parses
 * `workspace.toml` and the workspace `.env`, so that cost stays on the
 * overview page and the `/api/worker` contract stays unchanged.
 *
 * Everything is derived from durable state (runs DB, `webhook_meta`, cursors,
 * `workspace.toml`), so a standalone dashboard reports the same picture as
 * one embedded in the worker.
 */

import { getHarness, parseHarnessList } from "@devintern/agent-harness";

import type { RunOrigin, RunRecord } from "../state/run-recorder";
import type { WorkspaceConfig } from "../workspace/config";
import { parseEnvFile } from "../workspace/env";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import type { ApiResponse, DashboardData, WorkerStatusView } from "./dashboard-api";
import { resolveWorkerStatus } from "./dashboard-api";
import { readDashboardFailoverState } from "./dashboard-db";
import type { DashboardFailoverState } from "./dashboard-db";
import { loadDashboardWorkspaceConfig } from "./dashboard-workspace";

/** One unfinished run, trimmed for the capacity panel. */
export interface OverviewRunningRun {
  id: number;
  origin: RunOrigin;
  taskKey?: string;
  /** Repo as recorded on the run (a workspace repo name or `owner/repo`). */
  repo?: string;
  /** Workspace repo the run was attributed to, when it matched one. */
  workspaceRepo?: string;
  team?: string;
  harness?: string;
  step?: string;
  startedAt: number;
}

export interface OverviewRepoCapacity {
  /** Workspace repo name, or the run's raw repo when it matched none. */
  repo: string;
  running: number;
  /** `[workspace.execution].max_concurrency_per_repo`; null without a config. */
  maxConcurrency: number | null;
  /** Whether the repo is declared in `workspace.toml`. */
  configured: boolean;
}

export interface OverviewCapacity {
  /** Unfinished (`in_progress`) runs in the runs database. */
  running: number;
  /** `[workspace.execution].max_concurrency`; null without a valid config. */
  maxConcurrency: number | null;
  /** Configured repos first (in config order), then unmatched run repos. */
  perRepo: OverviewRepoCapacity[];
  /** Running runs that carry no repo at all. */
  unattributed: number;
  runs: OverviewRunningRun[];
}

/**
 * Health of one chain entry from persisted usage-limit windows.
 * `unknown` means the persisted failover state could not be read.
 */
/**
 * `unconfirmed`: the harness's last usage-limit window has elapsed, but no run
 * on it has succeeded since, so the quota may still be exhausted (the worker
 * only learns otherwise when its next agent run hits the limit again).
 */
export type OverviewHarnessState = "healthy" | "limited" | "unconfirmed" | "unknown";

/** How far back an elapsed limit still makes a harness `unconfirmed`. */
export const UNCONFIRMED_LIMIT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface OverviewHarnessEntry {
  name: string;
  /** 0 = primary. */
  priority: number;
  /** Whether the name resolves to a registered harness. */
  known: boolean;
  active: boolean;
  state: OverviewHarnessState;
  /** Usage-limit window end (epoch ms), only while `limited`. */
  limitedUntil?: number;
  /** When the last usage limit was hit (epoch ms), only while `unconfirmed`. */
  lastLimitedAt?: number;
  /** When that last limit window ended (epoch ms), only while `unconfirmed`. */
  limitEndedAt?: number;
}

export interface OverviewHarnesses {
  /** Where `AGENT_HARNESS` came from (workspace `.env` wins, like the worker). */
  source: "workspace_env" | "process_env" | "default";
  entries: OverviewHarnessEntry[];
  /**
   * Entry the worker selects: the highest-priority one without an open
   * window (the primary while everything is limited). Null when unknown.
   */
  active: string | null;
  /** Active harness last persisted by the worker, for comparison. */
  persistedActive?: string;
  /** Every entry is inside a usage-limit window; new agent work is paused. */
  allExhausted: boolean;
  /** Earliest window end while exhausted (epoch ms). */
  resumesAt?: number;
  /** False when `webhook_meta` could not be read (entries are `unknown`). */
  stateAvailable: boolean;
}

export interface OverviewTrackerSource {
  /** Team name; absent for the single `[defaults]` poller. */
  team?: string;
  tracker: string;
  taskQuery?: string;
  repo?: string;
  /** Cursor key the poller writes (`<tracker>:<team>` or `<tracker>`). */
  cursorSource: string;
  /** When the poller last advanced its cursor (epoch ms). */
  lastPolledAt?: number;
  cursorValue?: string;
}

export interface OverviewTrackers {
  /** `teams` for `[[teams]]`, `defaults` for the single poller, `none` otherwise. */
  mode: "teams" | "defaults" | "none";
  pollIntervalSeconds?: number;
  sources: OverviewTrackerSource[];
}

/** `GET /api/overview` body. */
export interface OverviewResponse {
  generatedAt: number;
  worker: WorkerStatusView;
  config: {
    status: "ok" | "missing" | "invalid";
    path: string;
    error?: string;
  };
  capacity: OverviewCapacity;
  harnesses: OverviewHarnesses;
  trackers: OverviewTrackers;
}

/** Normalize a git remote to `owner/repo` (best effort; null when unparseable). */
export function remoteSlug(remote: string): string | null {
  const trimmed = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@/\s]+@[^:/\s]+:(.+)$/);
  const path = scp ? scp[1] : trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i)?.[1];
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : null;
}

/** Map a run's recorded repo onto a configured workspace repo name. */
function matchWorkspaceRepo(
  runRepo: string | undefined,
  config: WorkspaceConfig | null,
): string | undefined {
  if (!runRepo || !config) return undefined;
  const lowered = runRepo.toLowerCase();
  const byName = config.repos.find((repo) => repo.name.toLowerCase() === lowered);
  if (byName) return byName.name;
  return config.repos.find((repo) => remoteSlug(repo.remote) === lowered)?.name;
}

/**
 * Capacity from unfinished runs vs the configured concurrency limits.
 *
 * Approximation: every `in_progress` run counts, including review/CI/conflict
 * runs (the per-repo cap only governs disposable-worktree task jobs) and rows
 * a crashed worker left behind before orphan recovery — pair it with
 * `worker.status`.
 */
export function buildCapacity(runs: RunRecord[], config: WorkspaceConfig | null): OverviewCapacity {
  const perRepoMax = config?.workspace.execution.maxConcurrencyPerRepo ?? null;
  const perRepo = new Map<string, OverviewRepoCapacity>();
  for (const repo of config?.repos ?? []) {
    perRepo.set(repo.name, {
      repo: repo.name,
      running: 0,
      maxConcurrency: perRepoMax,
      configured: true,
    });
  }
  let unattributed = 0;
  const trimmed = runs.map((run): OverviewRunningRun => {
    const workspaceRepo = matchWorkspaceRepo(run.repo, config);
    const key = workspaceRepo ?? run.repo;
    if (key) {
      const entry = perRepo.get(key) ?? {
        repo: key,
        running: 0,
        maxConcurrency: perRepoMax,
        configured: false,
      };
      entry.running += 1;
      perRepo.set(key, entry);
    } else {
      unattributed += 1;
    }
    return {
      id: run.id,
      origin: run.origin,
      taskKey: run.taskKey,
      repo: run.repo,
      workspaceRepo,
      team: run.team,
      harness: run.harness,
      step: run.step,
      startedAt: run.startedAt,
    };
  });
  return {
    running: runs.length,
    maxConcurrency: config?.workspace.execution.maxConcurrency ?? null,
    perRepo: [...perRepo.values()],
    unattributed,
    runs: trimmed,
  };
}

/**
 * Resolve the raw `AGENT_HARNESS` the worker would use. The workspace worker
 * applies the workspace `.env` over its process env at startup, so that file
 * wins; a non-workspace worker only has its process env.
 */
export function resolveHarnessChainSource(workspaceDir: string): {
  raw: string | undefined;
  source: OverviewHarnesses["source"];
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

/**
 * Harness chain health from persisted usage-limit windows.
 *
 * Mirrors {@link import("../agent/harness-failover").HarnessFailover}'s
 * selection: expired windows are healthy, and the active entry is the
 * highest-priority one without an open window. Install checks are skipped
 * (they spawn processes and this endpoint is polled).
 *
 * Gap: startup-failure cooldowns (`HarnessFailover.unavailable`, a 60 s
 * process-only skip for a harness that cannot start under the sandbox) are
 * deliberately not persisted, so this view cannot show them; `persistedActive`
 * is the closest signal when it disagrees with `active`.
 *
 * @param names - Priority-ordered canonical chain names
 * @param state - Persisted failover state, or null when unreadable
 * @param nowMs - Clock for window expiry
 */
export function buildHarnesses(
  names: string[],
  state: DashboardFailoverState | null,
  nowMs: number,
  source: OverviewHarnesses["source"],
  /** Harness name → start (epoch ms) of its most recent succeeded run. */
  lastSuccessAt: Record<string, number> = {},
): OverviewHarnesses {
  const limitedUntil = (name: string): number | undefined => {
    const until = state?.rateLimits[name];
    return until !== undefined && until > nowMs ? until : undefined;
  };
  const activeIndex = state
    ? Math.max(
        0,
        names.findIndex((name) => limitedUntil(name) === undefined),
      )
    : -1;
  const allExhausted =
    state !== null && names.length > 0 && names.every((name) => limitedUntil(name) !== undefined);
  // An elapsed window is not proof the quota is back: only a run that
  // succeeded after the limit was hit confirms it.
  const unconfirmedLimit = (name: string) => {
    const last = state?.lastLimits?.[name];
    if (!last || last.untilMs > nowMs || nowMs - last.untilMs > UNCONFIRMED_LIMIT_LOOKBACK_MS) {
      return undefined;
    }
    const success = lastSuccessAt[name];
    return success !== undefined && success >= last.hitAt ? undefined : last;
  };
  const entries = names.map((name, index): OverviewHarnessEntry => {
    const until = limitedUntil(name);
    const unconfirmed = until === undefined ? unconfirmedLimit(name) : undefined;
    return {
      name,
      priority: index,
      known: getHarness(name) !== undefined,
      active: index === activeIndex,
      state:
        state === null
          ? "unknown"
          : until !== undefined
            ? "limited"
            : unconfirmed
              ? "unconfirmed"
              : "healthy",
      limitedUntil: until,
      lastLimitedAt: unconfirmed?.hitAt,
      limitEndedAt: unconfirmed?.untilMs,
    };
  });
  const windows = entries.flatMap((entry) =>
    entry.limitedUntil === undefined ? [] : [entry.limitedUntil],
  );
  return {
    source,
    entries,
    active: activeIndex >= 0 ? (names[activeIndex] ?? null) : null,
    persistedActive: state?.activeHarness ?? undefined,
    allExhausted,
    resumesAt: allExhausted ? Math.min(...windows) : undefined,
    stateAvailable: state !== null,
  };
}

/** Tracker sources the worker polls, with their cursor freshness. */
export function buildTrackers(
  config: WorkspaceConfig | null,
  cursors: { source: string; cursorValue: string; updatedAt: number }[],
): OverviewTrackers {
  if (!config) return { mode: "none", sources: [] };
  const bySource = new Map(cursors.map((cursor) => [cursor.source, cursor]));
  const withCursor = (
    source: Omit<OverviewTrackerSource, "lastPolledAt" | "cursorValue">,
  ): OverviewTrackerSource => {
    const cursor = bySource.get(source.cursorSource);
    return { ...source, lastPolledAt: cursor?.updatedAt, cursorValue: cursor?.cursorValue };
  };
  const pollIntervalSeconds = config.defaults.pollIntervalSeconds;
  if (config.teams.length > 0) {
    return {
      mode: "teams",
      pollIntervalSeconds,
      sources: config.teams.map((team) =>
        withCursor({
          team: team.name,
          tracker: team.tracker,
          taskQuery: team.taskQuery,
          repo: team.repo,
          cursorSource: `${team.tracker}:${team.name}`,
        }),
      ),
    };
  }
  if (config.defaults.tracker && config.defaults.taskQuery) {
    return {
      mode: "defaults",
      pollIntervalSeconds,
      sources: [
        withCursor({
          tracker: config.defaults.tracker,
          taskQuery: config.defaults.taskQuery,
          cursorSource: config.defaults.tracker,
        }),
      ],
    };
  }
  return { mode: "none", pollIntervalSeconds, sources: [] };
}

/** Start time of each harness's most recent succeeded run. */
export function lastSuccessByHarness(
  runs: { harness?: string; status: string; startedAt: number }[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const run of runs) {
    if (run.status !== "succeeded" || !run.harness) continue;
    result[run.harness] = Math.max(result[run.harness] ?? 0, run.startedAt);
  }
  return result;
}

/**
 * Build the `GET /api/overview` body.
 *
 * @param data - Dashboard data source
 * @param nowMs - Clock (tests)
 */
export function buildOverview(data: DashboardData, nowMs: number = Date.now()): OverviewResponse {
  const configPath = workspaceConfigPath(data.workspaceDir);
  const load = loadDashboardWorkspaceConfig(configPath);
  const config = load.status === "ok" ? load.config : null;
  const chain = resolveHarnessChainSource(data.workspaceDir);
  // The worker persists failover state into its queue DB (the workspace DB in
  // fleet mode; the same file as run history for an embedded dashboard).
  const failover = readDashboardFailoverState(data.queueDbPath);
  const activity = data.getTaskActivity().runs;
  return {
    generatedAt: nowMs,
    worker: resolveWorkerStatus(data.workingDir, data.workspaceDir),
    config: {
      status: load.status,
      path: configPath,
      error: load.status === "ok" ? undefined : load.error,
    },
    capacity: buildCapacity(
      activity.filter((run) => run.status === "in_progress"),
      config,
    ),
    harnesses: buildHarnesses(
      parseHarnessList(chain.raw),
      failover,
      nowMs,
      chain.source,
      lastSuccessByHarness(activity),
    ),
    trackers: buildTrackers(config, data.getCursors()),
  };
}

/** `GET /api/overview` — capacity, harness chain health, tracker freshness. */
export function handleOverview(data: DashboardData): ApiResponse {
  return { status: 200, body: buildOverview(data) };
}
