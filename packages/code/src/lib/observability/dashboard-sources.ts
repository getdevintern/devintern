/**
 * Automation source health for the dashboard (`GET /api/sources`, and the
 * additive `sources` array on `GET /api/worker`).
 *
 * The worker persists one `source_status` row per automation source read
 * (error monitors today). Rows outlive config changes for history, so the
 * dashboard only lists sources present in the current config.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "fs";

import type { SourceFetchStatus } from "../acquirers/source-fetch";
import { loadWorkspaceConfig } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import { workspaceConfigPath } from "../workspace/paths";

/** A source the current config polls, identified like its `source_status` row. */
export interface ConfiguredSource {
  provider: string;
  sourceId: string;
}

/** One source's health as served to the dashboard; unset values are `null`. */
export interface DashboardSourceView {
  provider: string;
  sourceId: string;
  status: SourceFetchStatus;
  /** Epoch ms of the most recent read attempt. */
  checkedAt: number;
  /** Epoch ms of the most recent successful read. */
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  /** Failure detail of the most recent read. */
  message: string | null;
  /** When rate-limited, epoch ms after which the worker reads again. */
  retryAfterAt: number | null;
}

const SOURCE_STATUSES: ReadonlySet<string> = new Set<SourceFetchStatus>([
  "ok",
  "unreadable",
  "rate-limited",
  "auth-failed",
]);

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse one raw `source_status` row; null when it is not a recognizable row
 * (for example a status value written by a newer worker).
 */
export function parseSourceStatusRow(row: unknown): DashboardSourceView | null {
  if (typeof row !== "object" || row === null) return null;
  const raw = row as Record<string, unknown>;
  const { provider, source_id: sourceId, status, checked_at: checkedAt } = raw;
  if (typeof provider !== "string" || typeof sourceId !== "string") return null;
  if (typeof status !== "string" || !SOURCE_STATUSES.has(status)) return null;
  if (typeof checkedAt !== "number") return null;
  return {
    provider,
    sourceId,
    status: status as SourceFetchStatus,
    checkedAt,
    lastSuccessAt: optionalNumber(raw.last_success_at),
    consecutiveFailures: optionalNumber(raw.consecutive_failures) ?? 0,
    message: typeof raw.message === "string" && raw.message !== "" ? raw.message : null,
    retryAfterAt: optionalNumber(raw.retry_after_at),
  };
}

/**
 * Read every persisted source status without creating or migrating the DB.
 * A missing file or table (the worker never polled a source) yields `[]`;
 * other failures throw so callers can report them.
 *
 * @param dbPath - Database the worker records source health in
 */
export function readSourceStatuses(dbPath: string): DashboardSourceView[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_status'")
      .get();
    if (!table) return [];
    const rows = db.query("SELECT * FROM source_status ORDER BY provider, source_id").all();
    return rows
      .map(parseSourceStatusRow)
      .filter((view): view is DashboardSourceView => view !== null);
  } finally {
    db.close();
  }
}

/** Enabled sources of a workspace config (disabled sources are not polled). */
export function configuredSourcesOf(
  config: Pick<WorkspaceConfig, "errorMonitors">,
): ConfiguredSource[] {
  return config.errorMonitors
    .filter((monitor) => monitor.enabled)
    .map((monitor) => ({ provider: monitor.provider, sourceId: monitor.id }));
}

/**
 * Configured sources from a workspace's `workspace.toml`; empty when there
 * is no workspace. An invalid config throws so the caller reports it.
 *
 * @param workspaceDir - Workspace home holding `workspace.toml`
 */
export function loadConfiguredWorkspaceSources(workspaceDir: string): ConfiguredSource[] {
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return [];
  return configuredSourcesOf(loadWorkspaceConfig(configPath));
}

/**
 * A `loadConfiguredWorkspaceSources` that re-parses `workspace.toml` only when
 * its mtime or size changes, so the header and Automations polls do not parse
 * the file on every request. Errors are not cached: a broken config keeps
 * reporting its error until it is fixed.
 *
 * @param workspaceDir - Workspace home holding `workspace.toml`
 */
export function createCachedWorkspaceSourcesLoader(workspaceDir: string): () => ConfiguredSource[] {
  let cached: { key: string; sources: ConfiguredSource[] } | null = null;
  return () => {
    const configPath = workspaceConfigPath(workspaceDir);
    if (!existsSync(configPath)) {
      cached = null;
      return [];
    }
    const stat = statSync(configPath);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cached?.key === key) return cached.sources;
    const sources = loadConfiguredWorkspaceSources(workspaceDir);
    cached = { key, sources };
    return sources;
  };
}

/**
 * Keep only rows for sources in the current config, in config order, so a
 * removed source's leftover row is never shown. Configured sources without a
 * row (not polled yet) are omitted: there is no health to report.
 */
export function filterConfiguredSources(
  rows: readonly DashboardSourceView[],
  configured: readonly ConfiguredSource[],
): DashboardSourceView[] {
  const byKey = new Map(rows.map((row) => [`${row.provider}\u0000${row.sourceId}`, row]));
  const result: DashboardSourceView[] = [];
  for (const source of configured) {
    const row = byKey.get(`${source.provider}\u0000${source.sourceId}`);
    if (row) result.push(row);
  }
  return result;
}

/** Source health as served by `GET /api/sources`; `error` only on failure. */
export interface DashboardSourcesResult {
  sources: DashboardSourceView[];
  error?: string;
}

/**
 * Health of every source in the current config. Never throws: a failed read
 * returns no sources plus the error, so callers embedding this (the header's
 * `/api/worker` poll) keep serving everything else.
 *
 * @param dbPath - Database the worker records source health in
 * @param configuredSources - Sources the current config polls
 */
export function readConfiguredSourceHealth(
  dbPath: string,
  configuredSources: () => ConfiguredSource[],
): DashboardSourcesResult {
  try {
    const configured = configuredSources();
    if (configured.length === 0) return { sources: [] };
    return { sources: filterConfiguredSources(readSourceStatuses(dbPath), configured) };
  } catch (error) {
    return { sources: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** API response shape shared with the other dashboard handlers. */
interface SourcesApiResponse {
  status: number;
  body: unknown;
}

/**
 * `GET /api/sources` — health of each automation source in the current
 * config (error monitors today). A failed read answers 500 with the error.
 *
 * @param data - Dashboard data source (`DashboardData`)
 */
export function handleSources(data: { getSources(): DashboardSourcesResult }): SourcesApiResponse {
  const result = data.getSources();
  if (result.error !== undefined) {
    return { status: 500, body: { error: result.error, sources: [] } };
  }
  return { status: 200, body: { sources: result.sources } };
}
