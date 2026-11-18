/** `/api/overview` response types (see packages/code/src/lib/observability/dashboard-overview.ts). */

import type { RunOrigin, WorkerStatus } from "@/lib/api";

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
  /** `max_concurrency_per_repo`; null without a valid config. */
  maxConcurrency: number | null;
  /** Whether the repo is declared in `workspace.toml`. */
  configured: boolean;
}

export interface OverviewCapacity {
  /** Unfinished (`in_progress`) runs. */
  running: number;
  /** `max_concurrency`; null without a valid config. */
  maxConcurrency: number | null;
  /** Configured repos first (config order), then unmatched run repos. */
  perRepo: OverviewRepoCapacity[];
  /** Running runs without any repo. */
  unattributed: number;
  runs: OverviewRunningRun[];
}

/**
 * `unknown` = persisted failover state could not be read. `unconfirmed` = the
 * last usage-limit window elapsed but no run has succeeded on the harness since,
 * so its quota may still be exhausted.
 */
export type OverviewHarnessState = "healthy" | "limited" | "unconfirmed" | "unknown";

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
  /** When that limit window ended (epoch ms), only while `unconfirmed`. */
  limitEndedAt?: number;
}

export interface OverviewHarnesses {
  /** Where `AGENT_HARNESS` came from (workspace `.env` wins, like the worker). */
  source: "workspace_env" | "process_env" | "default";
  entries: OverviewHarnessEntry[];
  /** Highest-priority entry without an open window (primary when exhausted); null when unknown. */
  active: string | null;
  /** Active harness last persisted by the worker. */
  persistedActive?: string;
  /** Every entry is limited; new agent work is paused. */
  allExhausted: boolean;
  /** Earliest window end while exhausted (epoch ms). */
  resumesAt?: number;
  /** False when persisted failover state could not be read. */
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
  mode: "teams" | "defaults" | "none";
  pollIntervalSeconds?: number;
  sources: OverviewTrackerSource[];
}

/** `GET /api/overview` body. */
export interface OverviewResponse {
  generatedAt: number;
  worker: WorkerStatus;
  config: { status: "ok" | "missing" | "invalid"; path: string; error?: string };
  capacity: OverviewCapacity;
  harnesses: OverviewHarnesses;
  trackers: OverviewTrackers;
}
