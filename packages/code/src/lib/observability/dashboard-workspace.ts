/**
 * `GET /api/workspace` — a redacted, read-only view of `workspace.toml`.
 *
 * The config is parsed with the exact loader the worker uses
 * ({@link loadWorkspaceConfig}), so defaults and validation match what the
 * worker would run with. The response is a dashboard DTO rather than the raw
 * {@link WorkspaceConfig}: credentials never cross this boundary.
 *
 * Redaction rules:
 * - Inline `[teams.env]` / `[repos.env]` / `[error_monitors.env]` tables and
 *   referenced `env_file`s are reduced to their KEY NAMES; values are never
 *   read into the DTO.
 * - URLs (repo remotes, monitor base URLs) lose any `user:password@` userinfo.
 * - TOML syntax errors can quote the offending value (for example an unquoted
 *   token), so quoted fragments in parse-error messages are masked.
 *
 * A missing or invalid config is a typed `status` in a 200 response, never a
 * 500, so the dashboard can render the problem.
 */

import { existsSync, statSync } from "fs";
import { isAbsolute, join } from "path";

import { pickAgentSelection } from "../agent/selection";
import type { CronOrIntervalSchedule } from "../automation/config";
import { fingerprintConfigFile, readAppliedConfigRecord } from "../workspace/config-reload";
import type { AppliedConfigRecord, ConfigFileFingerprint } from "../workspace/config-reload";
import { loadWorkspaceConfig } from "../workspace/config";
import type {
  ConflictResolutionMode,
  RoutingRule,
  WorkspaceConfig,
  WorkspaceExecutionIsolation,
} from "../workspace/config";
import { parseEnvFile } from "../workspace/env";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import type { WorkerScheduleConfig } from "../worker/schedule";
import type { ApiResponse, DashboardData } from "./dashboard-api";
import { resolveWorkerStatus } from "./dashboard-api";

/** Outcome of loading `workspace.toml` for a dashboard view. */
export type DashboardWorkspaceLoad =
  | { status: "ok"; config: WorkspaceConfig }
  | { status: "missing"; error: string }
  | { status: "invalid"; error: string; problems: string[] };

/**
 * Strip credential-bearing userinfo from URL-looking substrings: any
 * `user:password@`, and any userinfo on http(s) URLs (a bare token there is a
 * credential). A plain SSH login name (`ssh://git@host/...`) is kept.
 */
export function redactUrlCredentials(value: string): string {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi,
    (match, scheme: string, userinfo: string) =>
      userinfo.includes(":") || /^https?:/i.test(scheme) ? scheme : match,
  );
}

/** Mask quoted fragments TOML syntax errors echo from the offending line. */
function maskQuotedFragments(message: string): string {
  return message.replace(/"[^"\n]*"/g, '"…"').replace(/'[^'\n]*'/g, "'…'");
}

/**
 * Load the workspace config the way the worker does, mapping failures to a
 * typed state instead of throwing.
 *
 * @param configPath - Absolute path of `workspace.toml`
 */
export function loadDashboardWorkspaceConfig(configPath: string): DashboardWorkspaceLoad {
  if (!existsSync(configPath)) {
    return {
      status: "missing",
      error: `No workspace config at ${configPath}. Run \`devintern worker scaffold\` to create one.`,
    };
  }
  try {
    return { status: "ok", config: loadWorkspaceConfig(configPath) };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const syntax = raw.startsWith("Failed to parse ");
    const message = redactUrlCredentials(syntax ? maskQuotedFragments(raw) : raw);
    // Validation errors are "Invalid <path>:\n- a\n- b"; split the bullet list.
    const [headline = message, ...rest] = message.split("\n- ");
    return {
      status: "invalid",
      error: headline.replace(/:$/, ""),
      problems: syntax ? [message] : rest,
    };
  }
}

/** Redacted view of one env source: where it lives and which keys it sets. */
export interface WorkspaceEnvFileView {
  /** Path as written in `workspace.toml` (workspace-relative or absolute). */
  path: string;
  /** Absolute path the worker reads. */
  resolvedPath: string;
  exists: boolean;
  /** Variable names only, sorted; values are never served. */
  keys: string[];
}

/** Schedule fields shared by automations, estimations, and conflict resolution. */
export interface WorkspaceScheduleView {
  cron?: string;
  interval?: string;
}

export interface WorkspaceTeamView {
  name: string;
  tracker: string;
  taskQuery?: string;
  /** Fixed destination repo; absent when the team routes across repos. */
  repo?: string;
  envFile?: WorkspaceEnvFileView;
  /** Inline `[teams.env]` key names only. */
  envKeys: string[];
}

export interface WorkspaceRepoView {
  name: string;
  /** Remote URL with any embedded credentials removed. */
  remote: string;
  defaultBranch?: string;
  prLabels?: string[];
  pipelineFile?: string;
  envFile?: WorkspaceEnvFileView;
  /** Inline `[repos.env]` key names only. */
  envKeys: string[];
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
  /** Per-automation model override. */
  model?: string;
  /** Per-automation reasoning effort override. */
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

/** The redacted, validated contents of `workspace.toml`. */
export interface WorkspaceConfigView {
  workspace: {
    execution: {
      isolation?: WorkspaceExecutionIsolation;
      maxConcurrency: number;
      maxConcurrencyPerRepo: number;
    };
    worktreesTtlDays: number;
    dashboard: boolean;
    dashboardPort?: number;
    ciFailureFix: boolean;
    conflictResolution: ConflictResolutionMode;
    conflictSchedule?: WorkspaceScheduleView;
  };
  worker: {
    autoUpdate: boolean;
    /** Working windows; null when pickup is unrestricted. */
    schedule: WorkerScheduleConfig | null;
  };
  defaults: {
    tracker: string;
    taskQuery?: string;
    workerTaskArgs?: string;
    prLabels?: string[];
    pipelineFile?: string;
    pollIntervalSeconds: number;
  };
  /** The shared workspace `.env` (key names only). */
  sharedEnv: WorkspaceEnvFileView;
  teams: WorkspaceTeamView[];
  repos: WorkspaceRepoView[];
  routing: RoutingRule[];
  automations: WorkspaceAutomationView[];
  estimations: WorkspaceEstimationView[];
  errorMonitors: WorkspaceErrorMonitorView[];
}

/**
 * Whether the running worker runs the file on disk:
 * - `applied`: the worker applied this exact file version.
 * - `pending`: the file changed and the worker has not (yet) processed it.
 * - `rejected`: the worker tried this version and kept its previous config
 *   (invalid file, or a change to a startup-only key); see `rejectedReason`.
 * - `unconfirmed`: an older worker that keeps no record; the file changed
 *   after it started, so whether it applied the edit is unknown.
 */
export type WorkspaceConfigSync = "applied" | "pending" | "rejected" | "unconfirmed";

/** The config version the running worker last applied (from its record). */
export interface WorkspaceAppliedConfigView {
  /** When the worker applied it (epoch ms). */
  appliedAt: number;
  /** mtime of the applied file version (epoch ms). */
  fileModifiedAt: number;
  /** Why the current on-disk version was rejected (only when `rejected`). */
  rejectedReason?: string;
  /** When that rejection happened (epoch ms). */
  rejectedAt?: number;
}

/** File and worker metadata shared by every `GET /api/workspace` state. */
export interface WorkspaceResponseMeta {
  workspaceDir: string;
  configPath: string;
  /** Config file mtime (epoch ms); absent when the file is missing. */
  fileModifiedAt?: number;
  /** Start time of the running worker (epoch ms), from its lock file. */
  workerStartedAt?: number;
  /**
   * True when the file changed after the running worker started. The worker
   * hot-reloads most sections (repos, routing, automations, estimations,
   * cadence) but some are startup-only — `[defaults].tracker`, team
   * names/trackers/env, `[[error_monitors]]`, `[workspace].dashboard` /
   * `dashboard_port`, and `[worker.schedule]` — and an invalid edit is
   * ignored, so a true value means "the worker may not be running this".
   * Absent when no running worker start time is known. Prefer `configSync`,
   * which also knows about hot reloads.
   */
  staleSinceWorkerStart?: boolean;
  /** Whether the running worker runs this file; absent without a running worker. */
  configSync?: WorkspaceConfigSync;
  /** Present when the running worker keeps an applied-config record. */
  appliedConfig?: WorkspaceAppliedConfigView;
}

/** `GET /api/workspace` body. */
export type WorkspaceResponse = WorkspaceResponseMeta &
  (
    | { status: "ok"; config: WorkspaceConfigView }
    | { status: "missing"; error: string }
    | { status: "invalid"; error: string; problems: string[] }
  );

function sortedKeys(env: Record<string, string>): string[] {
  return Object.keys(env).sort();
}

function scheduleView(schedule: CronOrIntervalSchedule | undefined): WorkspaceScheduleView {
  return { cron: schedule?.cron, interval: schedule?.interval };
}

/** Describe an env file by key names only (values are discarded here). */
export function describeEnvFile(path: string, workspaceDir: string): WorkspaceEnvFileView {
  const resolvedPath = isAbsolute(path) ? path : join(workspaceDir, path);
  const exists = existsSync(resolvedPath);
  let keys: string[] = [];
  if (exists) {
    try {
      keys = sortedKeys(parseEnvFile(resolvedPath));
    } catch {
      keys = [];
    }
  }
  return { path, resolvedPath, exists, keys };
}

/**
 * Build the redacted DTO from a validated config.
 *
 * @param config - Config parsed by the worker's loader
 * @param workspaceDir - Directory relative `env_file` paths resolve against
 */
export function toWorkspaceConfigView(
  config: WorkspaceConfig,
  workspaceDir: string,
): WorkspaceConfigView {
  const envFile = (path: string | undefined) =>
    path ? describeEnvFile(path, workspaceDir) : undefined;
  return {
    workspace: {
      execution: { ...config.workspace.execution },
      worktreesTtlDays: config.workspace.worktreesTtlDays,
      dashboard: config.workspace.dashboard,
      dashboardPort: config.workspace.dashboardPort,
      ciFailureFix: config.workspace.ciFailureFix,
      conflictResolution: config.workspace.conflictResolution,
      conflictSchedule: config.workspace.conflictSchedule
        ? scheduleView(config.workspace.conflictSchedule)
        : undefined,
    },
    worker: { autoUpdate: config.worker.autoUpdate, schedule: config.worker.schedule },
    defaults: { ...config.defaults },
    sharedEnv: describeEnvFile(workspaceEnvPath(workspaceDir), workspaceDir),
    teams: config.teams.map((team) => ({
      name: team.name,
      tracker: team.tracker,
      taskQuery: team.taskQuery,
      repo: team.repo,
      envFile: envFile(team.envFile),
      envKeys: sortedKeys(team.env),
    })),
    repos: config.repos.map((repo) => ({
      name: repo.name,
      remote: redactUrlCredentials(repo.remote),
      defaultBranch: repo.defaultBranch,
      prLabels: repo.prLabels,
      pipelineFile: repo.pipelineFile,
      envFile: envFile(repo.envFile),
      envKeys: sortedKeys(repo.env),
    })),
    routing: config.routing.map((rule) => ({
      ...rule,
      components: [...rule.components],
      labels: [...rule.labels],
    })),
    automations: config.automations.map((automation) => ({
      id: automation.id,
      enabled: automation.enabled,
      ...scheduleView(automation),
      repo: automation.repo,
      openPr: automation.openPr === true,
      allowNoChanges: automation.allowNoChanges === true,
      prompt: automation.prompt,
      ...pickAgentSelection(automation),
    })),
    estimations: config.estimations.map((estimation) => ({
      id: estimation.id,
      enabled: estimation.enabled,
      query: estimation.query,
      ...scheduleView(estimation),
    })),
    errorMonitors: config.errorMonitors.map((monitor) => ({
      id: monitor.id,
      provider: monitor.provider,
      enabled: monitor.enabled,
      repo: monitor.repo,
      team: monitor.team,
      query: monitor.query,
      intervalSeconds: monitor.intervalSeconds,
      minOccurrences: monitor.minOccurrences,
      maxIssuesPerTick: monitor.maxIssuesPerTick,
      commentOnAction: monitor.commentOnAction,
      organization: monitor.organization,
      project: monitor.project,
      baseUrl: monitor.baseUrl ? redactUrlCredentials(monitor.baseUrl) : undefined,
      envFile: envFile(monitor.envFile),
      envKeys: sortedKeys(monitor.env),
    })),
  };
}

/** Running worker's pid and start time (epoch ms) from its lock, when determinable. */
function runningWorker(data: DashboardData): { pid?: number; startedAt: number } | undefined {
  const worker = resolveWorkerStatus(data.workingDir, data.workspaceDir);
  if (worker.status !== "running" || !worker.startedAt) {
    return undefined;
  }
  const ms = Date.parse(worker.startedAt);
  return Number.isFinite(ms) ? { pid: worker.pid, startedAt: ms } : undefined;
}

/** Running worker's start time (epoch ms) from its lock, when determinable. */
export function runningWorkerStartedAt(data: DashboardData): number | undefined {
  return runningWorker(data)?.startedAt;
}

/** Rejection reasons can quote config values; mask them like parse errors. */
function redactReason(reason: string): string {
  return redactUrlCredentials(maskQuotedFragments(reason));
}

/**
 * Compare the worker's applied-config record with the file on disk.
 *
 * @param record - The worker's record, or null when it keeps none
 * @param file - Fingerprint of the current file, or null when unreadable
 * @param worker - The running worker (pid from its lock, start time)
 */
export function deriveConfigSync(
  record: AppliedConfigRecord | null,
  file: ConfigFileFingerprint | null,
  worker: { pid?: number; startedAt: number },
): { configSync?: WorkspaceConfigSync; appliedConfig?: WorkspaceAppliedConfigView } {
  if (!file) return {};
  if (!record || worker.pid === undefined || record.pid !== worker.pid) {
    // Older worker (no record) or a record left by another process.
    return { configSync: file.fileModifiedAt > worker.startedAt ? "unconfirmed" : "applied" };
  }
  const appliedConfig: WorkspaceAppliedConfigView = {
    appliedAt: record.appliedAt,
    fileModifiedAt: record.fileModifiedAt,
  };
  if (record.contentHash === file.contentHash) return { configSync: "applied", appliedConfig };
  const rejection = record.rejection;
  if (rejection && rejection.contentHash === file.contentHash) {
    return {
      configSync: "rejected",
      appliedConfig: {
        ...appliedConfig,
        rejectedReason: redactReason(rejection.reason),
        rejectedAt: rejection.at,
      },
    };
  }
  return { configSync: "pending", appliedConfig };
}

/**
 * Build the `GET /api/workspace` body.
 *
 * @param data - Dashboard data source (supplies the workspace directory)
 */
export function buildWorkspaceResponse(data: DashboardData): WorkspaceResponse {
  const workspaceDir = data.workspaceDir;
  const configPath = workspaceConfigPath(workspaceDir);
  let fileModifiedAt: number | undefined;
  try {
    fileModifiedAt = statSync(configPath).mtimeMs;
  } catch {
    fileModifiedAt = undefined;
  }
  const worker = runningWorker(data);
  const workerStartedAt = worker?.startedAt;
  const sync = worker
    ? deriveConfigSync(
        readAppliedConfigRecord(workspaceDir),
        fingerprintConfigFile(configPath),
        worker,
      )
    : {};
  const meta: WorkspaceResponseMeta = {
    workspaceDir,
    configPath,
    fileModifiedAt: fileModifiedAt === undefined ? undefined : Math.round(fileModifiedAt),
    workerStartedAt,
    staleSinceWorkerStart:
      fileModifiedAt !== undefined && workerStartedAt !== undefined
        ? fileModifiedAt > workerStartedAt
        : undefined,
    ...sync,
  };
  const load = loadDashboardWorkspaceConfig(configPath);
  if (load.status === "ok") {
    return { ...meta, status: "ok", config: toWorkspaceConfigView(load.config, workspaceDir) };
  }
  return { ...meta, ...load };
}

/** `GET /api/workspace` — redacted workspace configuration. */
export function handleWorkspace(data: DashboardData): ApiResponse {
  return { status: 200, body: buildWorkspaceResponse(data) };
}
