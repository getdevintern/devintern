/**
 * Pure helpers behind the demo snapshot build (see `demo.ts`): where a
 * recorded `/api/*` response lives on disk, how `/api/runs` filters are
 * answered from one recorded run list, and how recorded timestamps are moved
 * forward so a snapshot taken days ago still reads as "just now".
 *
 * Shared by the browser (reading a snapshot) and `scripts/demo/snapshot.ts`
 * (writing one), so both sides agree on every file name.
 */

import type { RunLineage, RunRecord, RunsResponse, SpawnedWork } from "./api";
import type {
  NotificationLink,
  NotificationListResponse,
  NotificationMutesResponse,
  NotificationRecord,
  NotificationUnreadResponse,
} from "./api-notifications";

/** Directory, next to `index.html`, that holds the recorded responses. */
export const SNAPSHOT_DATA_DIR = "data";

/** Snapshot metadata written by the recorder as `data/meta.json`. */
export interface DemoSnapshotMeta {
  /** Epoch ms when the responses were recorded; the "now" they were true at. */
  exportedAt: number;
}

/**
 * Query parameters that never select a different recording: the viewer's
 * time zone (the snapshot is recorded in one zone) and the artifact
 * download switch (same bytes either way).
 */
const IGNORED_PARAMS = new Set(["tz", "download"]);

/** `/api/runs` is answered from this one full recording, filtered in the browser. */
export const RUNS_ALL_FILE = `${SNAPSHOT_DATA_DIR}/api/runs.all.json`;

const RAW_FILE_PATTERN = /^\/api\/runs\/[^/]+\/artifacts\/[^/]+\/file$/;

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  // A segment made only of dots would walk up the tree once served.
  return /^\.*$/.test(cleaned) ? cleaned.replace(/\./g, "_") || "_" : cleaned;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The snapshot file (relative to the page) that holds the recording of a
 * dashboard API URL, or null when the URL is not an `/api/*` GET target.
 *
 * `/api/runs/30` → `data/api/runs/30.json`;
 * `/api/stats?window=7d&tz=…` → `data/api/stats.window-7d.json`;
 * an artifact's raw `/file` keeps its bytes as `file.bin`.
 *
 * @param apiUrl - Root-relative API URL, with or without a query string
 */
export function snapshotFile(apiUrl: string): string | null {
  const url = new URL(apiUrl, "http://snapshot.invalid");
  if (!url.pathname.startsWith("/api/")) return null;
  const segments = url.pathname.slice(1).split("/").filter(Boolean).map(decodeSegment);
  const path = segments.map(safeSegment).join("/");
  const query = [...url.searchParams.entries()]
    .filter(([key]) => !IGNORED_PARAMS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `.${safeSegment(key)}-${safeSegment(value)}`)
    .join("");
  const extension = RAW_FILE_PATTERN.test(url.pathname) ? ".bin" : ".json";
  return `${SNAPSHOT_DATA_DIR}/${path}${query}${extension}`;
}

/** Whether a URL is the run list, answered from {@link RUNS_ALL_FILE}. */
export function isRunListUrl(apiUrl: string): boolean {
  return new URL(apiUrl, "http://snapshot.invalid").pathname === "/api/runs";
}

const DEFAULT_RUN_LIMIT = 50;

function nonNegativeInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Answer a `/api/runs` query from the full recorded run list, with the same
 * filters and paging the server applies (`taskKey`, `status`, `origin`,
 * `automationId`, `limit`, `offset`). The recording is already newest first.
 *
 * @param all - Every recorded run, newest first
 * @param apiUrl - The requested run-list URL
 */
export function filterRecordedRuns(all: readonly RunRecord[], apiUrl: string): RunsResponse {
  const params = new URL(apiUrl, "http://snapshot.invalid").searchParams;
  const taskKey = params.get("taskKey");
  const status = params.get("status");
  const origin = params.get("origin");
  const automationId = params.get("automationId");
  const matching = all.filter(
    (run) =>
      (taskKey === null || run.taskKey === taskKey) &&
      (status === null || run.status === status) &&
      (origin === null || run.origin === origin) &&
      (automationId === null || run.automationId === automationId),
  );
  const limit = Math.max(1, nonNegativeInt(params.get("limit"), DEFAULT_RUN_LIMIT));
  const offset = nonNegativeInt(params.get("offset"), 0);
  return { runs: matching.slice(offset, offset + limit), total: matching.length };
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Epoch milliseconds between 2001 and 2286: no count, size, id, or duration
// the API returns comes near this range.
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Move every timestamp in a recorded response forward by `shiftMs`, so
 * relative labels ("3m ago", worker heartbeat, next due) read as they did
 * when it was recorded. Epoch-ms numbers and ISO datetimes move exactly;
 * date-only keys (stats weeks, heatmap days) move by whole weeks so they stay
 * on the same weekday and week boundaries.
 *
 * @param value - Parsed JSON response
 * @param shiftMs - Milliseconds to add (viewer's now minus recording time)
 */
export function rebaseTimestamps(value: unknown, shiftMs: number): unknown {
  const weekShift = Math.round(shiftMs / WEEK_MS) * WEEK_MS;
  const visit = (node: unknown): unknown => {
    if (typeof node === "number") {
      return node >= EPOCH_MS_MIN && node < EPOCH_MS_MAX ? node + shiftMs : node;
    }
    if (typeof node === "string") {
      if (ISO_DATETIME.test(node)) {
        const parsed = Date.parse(node);
        return Number.isNaN(parsed) ? node : new Date(parsed + shiftMs).toISOString();
      }
      if (ISO_DATE.test(node) && weekShift !== 0) {
        const parsed = Date.parse(`${node}T00:00:00Z`);
        return Number.isNaN(parsed)
          ? node
          : new Date(parsed + weekShift).toISOString().slice(0, 10);
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    }
    return node;
  };
  return visit(value);
}

/** Parse `data/meta.json`, or null when it is missing a recording time. */
export function parseSnapshotMeta(value: unknown): DemoSnapshotMeta | null {
  if (value === null || typeof value !== "object") return null;
  const exportedAt = (value as { exportedAt?: unknown }).exportedAt;
  return typeof exportedAt === "number" && Number.isFinite(exportedAt) ? { exportedAt } : null;
}

const RUN_DETAIL_PATTERN = /^\/api\/runs\/\d+$/;

/** Whether a URL is one run's detail (`/api/runs/:id`), whose lineage links other runs. */
export function isRunDetailUrl(apiUrl: string): boolean {
  return RUN_DETAIL_PATTERN.test(new URL(apiUrl, "http://snapshot.invalid").pathname);
}

/**
 * Keep a recorded run detail's lineage inside the recording: a source run that
 * was not recorded is dropped, and links from spawned work to unrecorded runs
 * are removed (the entry itself stays), so the demo never links to a run page
 * it cannot show.
 *
 * @param detail - Recorded `/api/runs/:id` body
 * @param recordedIds - Ids of every run in the recording
 */
export function pruneUnrecordedLineage(detail: unknown, recordedIds: ReadonlySet<number>): unknown {
  if (detail === null || typeof detail !== "object") return detail;
  const lineage = (detail as { lineage?: RunLineage }).lineage;
  if (!lineage || typeof lineage !== "object") return detail;
  const parent = lineage.parent && recordedIds.has(lineage.parent.runId) ? lineage.parent : null;
  const spawned = (Array.isArray(lineage.spawned) ? lineage.spawned : []).flatMap(
    (item): SpawnedWork[] => {
      if (item.kind === "follow_up_run") return recordedIds.has(item.runId) ? [item] : [];
      if (item.kind === "delegated_task" && item.latestRunId !== undefined) {
        if (recordedIds.has(item.latestRunId)) return [item];
        return [{ ...item, latestRunId: undefined }];
      }
      return [item];
    },
  );
  return { ...detail, lineage: { parent, spawned } };
}

// ---------------------------------------------------------------------------
// Notification fixtures
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function runLinks(run: RunRecord | undefined): NotificationLink[] {
  if (!run) return [];
  return [
    { label: `Run #${run.id}`, runId: run.id },
    ...(run.prUrl
      ? [
          {
            label: run.prNumber ? `${run.repo ?? "PR"}#${run.prNumber}` : "Pull request",
            url: run.prUrl,
          },
        ]
      : []),
    ...(run.ticketUrl ? [{ label: run.ticketKey ?? "Ticket", url: run.ticketUrl }] : []),
  ];
}

function runName(run: RunRecord): string {
  const name = run.automationId ?? run.taskKey;
  return name ? `Run #${run.id} (${name})` : `Run #${run.id}`;
}

/**
 * Notification rows for the demo inbox, built around the recorded runs so
 * their links open real run pages: a grouped error-monitor escalation with a
 * large count, an escalated task, a `work_spawned` rollup on the run that
 * delegated work, grouped PRs, and a resolved source outage (shown with
 * "Show resolved").
 *
 * @param runs - Every recorded run, newest first
 * @param now - Viewer's clock at page load
 */
export function demoNotifications(runs: readonly RunRecord[], now: number): NotificationRecord[] {
  const errorRun = runs.find((run) => run.origin === "error_monitor");
  const escalatedRun = runs.find((run) => run.status === "escalated" && run !== errorRun);
  const spawnRun =
    runs.find((run) => run.automationId === "docs-drift") ??
    runs.find((run) => run.origin === "scheduled");
  const prRuns = runs.filter((run) => run.prUrl).slice(0, 3);
  const mergedRun = runs.find((run) => run.origin === "auto_merge") ?? prRuns[0];
  const repoOf = (run: RunRecord | undefined, fallback: string) => run?.repo ?? fallback;
  const base = { muted: false, links: [] as NotificationLink[] };
  const rows: NotificationRecord[] = [
    {
      ...base,
      id: 9,
      kind: "escalated",
      severity: "high",
      groupKey: "escalated:sentry:checkout-total-undefined",
      count: 88,
      ...(errorRun ? { runId: errorRun.id } : {}),
      repo: repoOf(errorRun, "acme/web"),
      subject: "sentry:checkout-total-undefined",
      title: "Sentry issue escalated 88 times: TypeError reading 'total' in checkout",
      body: "The error monitor keeps reopening this issue; the agent could not reproduce it from the stack trace alone.",
      links: runLinks(errorRun),
      createdAt: now - 3 * 24 * HOUR_MS,
      updatedAt: now - 4 * MINUTE_MS,
    },
    ...(escalatedRun
      ? [
          {
            ...base,
            id: 8,
            kind: "escalated" as const,
            severity: "high" as const,
            groupKey: `escalated:task:${escalatedRun.taskKey ?? escalatedRun.id}`,
            count: 1,
            runId: escalatedRun.id,
            repo: repoOf(escalatedRun, "acme/web"),
            title: `${runName(escalatedRun)} escalated and needs a human`,
            ...(escalatedRun.outcomeReason ? { body: escalatedRun.outcomeReason } : {}),
            links: runLinks(escalatedRun),
            createdAt: now - 2 * HOUR_MS,
            updatedAt: now - 2 * HOUR_MS,
          },
        ]
      : []),
    {
      ...base,
      id: 7,
      kind: "automation_broke",
      severity: "high",
      groupKey: "automation_broke:automation:dependency-updates",
      count: 1,
      repo: "acme/api",
      subject: "automation:dependency-updates",
      title: "Automation dependency-updates broke: the latest run failed after a successful run",
      body: "npm install failed: the lockfile references a package version that was unpublished.",
      createdAt: now - 5 * HOUR_MS,
      updatedAt: now - 5 * HOUR_MS,
      readAt: now - 4 * HOUR_MS,
    },
    ...(spawnRun
      ? [
          {
            ...base,
            id: 6,
            kind: "work_spawned" as const,
            severity: "normal" as const,
            groupKey: `work_spawned:run:${spawnRun.id}`,
            count: 1,
            runId: spawnRun.id,
            repo: repoOf(spawnRun, "acme/web"),
            title: `${runName(spawnRun)} delegated 2 tasks and filed 1 ticket`,
            body: "1/2 finished: 1 PR open",
            links: [{ label: `Run #${spawnRun.id}`, runId: spawnRun.id }],
            createdAt: now - 26 * MINUTE_MS,
            updatedAt: now - 12 * MINUTE_MS,
          },
        ]
      : []),
    {
      ...base,
      id: 5,
      kind: "pr_opened",
      severity: "normal",
      groupKey: "pr_opened:repo:today",
      count: Math.max(prRuns.length, 1),
      repo: repoOf(prRuns[0], "acme/web"),
      title: prRuns.length > 1 ? `${prRuns.length} PRs opened today` : "Opened a pull request",
      links: prRuns.flatMap((run) =>
        run.prUrl
          ? [{ label: `${run.repo ?? "PR"}#${run.prNumber ?? ""}`, url: run.prUrl, runId: run.id }]
          : [],
      ),
      createdAt: now - 6 * HOUR_MS,
      updatedAt: now - 35 * MINUTE_MS,
      readAt: now - 30 * MINUTE_MS,
    },
    ...(mergedRun
      ? [
          {
            ...base,
            id: 4,
            kind: "pr_auto_merged" as const,
            severity: "normal" as const,
            groupKey: `pr_auto_merged:${mergedRun.repo ?? "repo"}:today`,
            count: 1,
            runId: mergedRun.id,
            repo: repoOf(mergedRun, "acme/web"),
            title: `Auto-merged ${mergedRun.repo ?? "a"} PR #${mergedRun.prNumber ?? ""}`.trim(),
            links: runLinks(mergedRun),
            createdAt: now - 3 * HOUR_MS,
            updatedAt: now - 3 * HOUR_MS,
            readAt: now - 2 * HOUR_MS,
          },
        ]
      : []),
    {
      ...base,
      id: 3,
      kind: "source_unhealthy",
      severity: "high",
      groupKey: "source_unhealthy:linear:product",
      count: 3,
      subject: "source:linear:product",
      title: "linear source product: authentication failed",
      body: "The Linear API key was rotated; tickets were not picked up until it was replaced.",
      createdAt: now - 30 * HOUR_MS,
      updatedAt: now - 28 * HOUR_MS,
      readAt: now - 27 * HOUR_MS,
      resolvedAt: now - 26 * HOUR_MS,
    },
  ];
  return rows.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
}

function flag(params: URLSearchParams, name: string): boolean | undefined {
  const raw = params.get(name);
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

/**
 * Answer a notification GET from the demo fixtures with the server's filters
 * and paging, or null when the URL is not a notification read.
 *
 * @param all - Fixture rows, newest first
 * @param apiUrl - Root-relative API URL
 */
export function answerDemoNotifications(
  all: readonly NotificationRecord[],
  apiUrl: string,
): NotificationListResponse | NotificationUnreadResponse | NotificationMutesResponse | null {
  const url = new URL(apiUrl, "http://snapshot.invalid");
  const open = all.filter((row) => row.resolvedAt === undefined && !row.muted);
  if (url.pathname === "/api/notifications/unread-count") {
    const unread = open.filter((row) => row.readAt === undefined);
    return {
      unread: unread.length,
      unreadHigh: unread.filter((row) => row.severity === "high").length,
    };
  }
  if (url.pathname === "/api/notifications/mutes") return { mutes: [] };
  if (url.pathname !== "/api/notifications") return null;
  const params = url.searchParams;
  const unresolved = flag(params, "unresolved");
  const includeMuted = flag(params, "includeMuted") === true;
  const severity = params.get("severity");
  const kind = params.get("kind");
  const matching = all.filter(
    (row) =>
      (includeMuted || !row.muted) &&
      (unresolved !== true || row.resolvedAt === undefined) &&
      (severity === null || row.severity === severity) &&
      (kind === null || row.kind === kind),
  );
  const limit = Math.max(1, nonNegativeInt(params.get("limit"), DEFAULT_RUN_LIMIT));
  const offset = nonNegativeInt(params.get("offset"), 0);
  return {
    notifications: matching.slice(offset, offset + limit),
    total: matching.length,
    limit,
    offset,
  };
}
