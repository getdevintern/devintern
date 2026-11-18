/** `/api/workspace` response types (see packages/code/src/lib/observability/dashboard-workspace.ts). */

/** Redacted env source: location plus variable NAMES only (never values). */
export interface WorkspaceEnvFileView {
  /** Path as written in `workspace.toml`. */
  path: string;
  resolvedPath: string;
  exists: boolean;
  keys: string[];
}

export interface WorkspaceScheduleView {
  cron?: string;
  interval?: string;
}

export interface WorkspaceTeamView {
  name: string;
  tracker: string;
  taskQuery?: string;
  repo?: string;
  envFile?: WorkspaceEnvFileView;
  /** Inline `[teams.env]` key names. */
  envKeys: string[];
}

export interface WorkspaceRepoView {
  name: string;
  /** Remote with embedded credentials removed. */
  remote: string;
  defaultBranch?: string;
  prLabels?: string[];
  pipelineFile?: string;
  envFile?: WorkspaceEnvFileView;
  envKeys: string[];
}

export interface WorkspaceRoutingRule {
  repo: string;
  team?: string;
  project?: string;
  components: string[];
  labels: string[];
}

export interface WorkspaceAutomationView extends WorkspaceScheduleView {
  id: string;
  enabled: boolean;
  repo?: string;
  openPr: boolean;
  allowNoChanges: boolean;
  prompt: string;
  /** Per-automation agent harness override; absent inherits the workspace agent. */
  harness?: string;
  /** Per-automation model override; absent keeps the harness default. */
  model?: string;
  /** Per-automation reasoning effort override; absent keeps the harness default. */
  effort?: string;
}

export interface WorkspaceEstimationView extends WorkspaceScheduleView {
  id: string;
  enabled: boolean;
  query: string;
}

export interface WorkspaceErrorMonitorView {
  id: string;
  provider: string;
  enabled: boolean;
  repo: string;
  team?: string;
  query?: string;
  intervalSeconds: number;
  minOccurrences: number;
  maxIssuesPerTick: number;
  commentOnAction: boolean;
  organization: string;
  project: string;
  baseUrl?: string;
  envFile?: WorkspaceEnvFileView;
  envKeys: string[];
}

/** `[worker.schedule]` time window as parsed by the worker. */
export interface WorkspaceTimeWindow {
  spec: string;
  startMinutes: number;
  endMinutes: number;
}

export interface WorkspaceConfigView {
  workspace: {
    execution: {
      isolation?: "best_effort_host";
      maxConcurrency: number;
      maxConcurrencyPerRepo: number;
    };
    worktreesTtlDays: number;
    dashboard: boolean;
    dashboardPort?: number;
    ciFailureFix: boolean;
    conflictResolution: "auto" | "scheduled" | "disabled";
    conflictSchedule?: WorkspaceScheduleView;
  };
  worker: {
    autoUpdate: boolean;
    schedule: {
      active: WorkspaceTimeWindow[];
      blocked: WorkspaceTimeWindow[];
      timezone?: string;
      catchUpMissed: boolean;
    } | null;
  };
  defaults: {
    tracker: string;
    taskQuery?: string;
    workerTaskArgs?: string;
    prLabels?: string[];
    pipelineFile?: string;
    pollIntervalSeconds: number;
  };
  /** Shared workspace `.env` (key names only). */
  sharedEnv: WorkspaceEnvFileView;
  teams: WorkspaceTeamView[];
  repos: WorkspaceRepoView[];
  routing: WorkspaceRoutingRule[];
  automations: WorkspaceAutomationView[];
  estimations: WorkspaceEstimationView[];
  errorMonitors: WorkspaceErrorMonitorView[];
}

export interface WorkspaceResponseMeta {
  workspaceDir: string;
  configPath: string;
  /** Config file mtime (epoch ms); absent when missing. */
  fileModifiedAt?: number;
  /** Running worker's start time (epoch ms) from its lock. */
  workerStartedAt?: number;
  /**
   * File modified after the running worker started (mtime only; true even
   * after a successful hot reload). Prefer `configSync`.
   */
  staleSinceWorkerStart?: boolean;
  /**
   * Whether the running worker runs this file: `applied`, `pending` (not
   * processed yet), `rejected` (kept its previous config; see
   * `appliedConfig.rejectedReason`), or `unconfirmed` (older worker without a
   * record, file newer than its start). Absent without a running worker.
   */
  configSync?: "applied" | "pending" | "rejected" | "unconfirmed";
  /** The version the running worker last applied, when it keeps a record. */
  appliedConfig?: {
    appliedAt: number;
    fileModifiedAt: number;
    rejectedReason?: string;
    rejectedAt?: number;
  };
}

/** `GET /api/workspace` body. */
export type WorkspaceResponse = WorkspaceResponseMeta &
  (
    | { status: "ok"; config: WorkspaceConfigView }
    | { status: "missing"; error: string }
    | { status: "invalid"; error: string; problems: string[] }
  );
