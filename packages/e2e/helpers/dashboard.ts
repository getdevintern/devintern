/**
 * Standalone dashboard fixture.
 *
 * Runs the real built CLI as `devintern dashboard` against the workspace and
 * queue database owned by a {@link WorkerFixture}. The fixture picks a free
 * port on the requested loopback host, polls `GET /api/health` at the URL built
 * from that same host, and always owns the child process lifecycle; callers
 * still own the worker and its temporary root, so {@link DashboardFixture.stop}
 * never removes files.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { cliPath } from "./fixture-workspace";
import { ensureLoopbackBypassesProxy } from "./loopback-proxy";
import { freePort } from "./webhook-server";
import type { WorkerFixture } from "./worker";

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 50;
const STOP_TIMEOUT_MS = 10_000;

export interface DashboardFixtureOptions {
  /** Working directory for the dashboard CLI; defaults to the fixture workspace. */
  cwd?: string;
  /** Loopback bind host; defaults to `127.0.0.1`. Also used for the health URL. */
  host?: string;
  /** Port to bind; defaults to a free ephemeral port. */
  port?: number;
  /** Extra CLI arguments, e.g. `--allow-origin <origin>` or `--no-tailscale-autodetect`. */
  args?: string[];
  /** Extra environment layered over the worker's, e.g. `DASHBOARD_ALLOWED_ORIGINS`. */
  env?: Record<string, string>;
}

/** Strip IPv6 brackets so the authority is never double-bracketed. */
function bareHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "");
}

/**
 * Build the client base URL for a loopback bind host.
 *
 * IPv6 literals must be bracketed (`http://[::1]:4400`) or the URL parser reads
 * the address colons as the port separator. `localhost` and IPv4 hosts pass
 * through unchanged so the client resolves the same name the server bound.
 */
export function dashboardBaseUrl(host: string, port: number): string {
  const normalized = bareHost(host);
  return `http://${normalized.includes(":") ? `[${normalized}]` : normalized}:${port}`;
}

/**
 * Headers the dashboard's CSRF guard requires on a write (non-GET) request:
 * its own loopback origin and a JSON content type, as the dashboard UI sends.
 */
export function dashboardWriteHeaders(baseUrl: string): Record<string, string> {
  return { "Content-Type": "application/json", Origin: new URL(baseUrl).origin };
}

/**
 * Poll `GET /api/health` until it returns the documented `{ status: "ok" }`.
 *
 * Shared by the standalone fixture and the worker-embedded dashboard, whose
 * server starts inside the daemon. `assertAlive` should throw once the owning
 * process has exited so a crash fails fast instead of waiting for the deadline.
 */
export async function waitForDashboardHealth(
  baseUrl: string,
  options: {
    timeoutMs?: number;
    assertAlive?: () => void;
    describe?: () => string;
  } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? HEALTH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    options.assertAlive?.();
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status === 200) {
        const payload = (await response.json()) as { status?: unknown };
        if (payload.status === "ok") return;
      }
    } catch {
      // The socket is not accepting connections yet.
    }
    await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `dashboard did not become healthy at ${baseUrl}` +
      (options.describe ? `\n${options.describe()}` : ""),
  );
}

/** One stored `run_retry_audit` row, as the dashboard's retry handler wrote it. */
export interface StoredRetryAudit {
  run_id: number;
  task_key: string | null;
  actor: string;
  action: string;
  message: string | null;
}

/** Read committed queue rows. A missing database or table is empty, not a failed open. */
export function readQueueRows<T>(dbPath: string, table: string, sql: string): T[] {
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    throw new Error(`refusing to query unexpected table ${table}`);
  }
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const known = db
      .query("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { one: number } | null;
    if (!known) return [];
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** Every stored retry audit row, oldest first. */
export function readRetryAudit(dbPath: string): StoredRetryAudit[] {
  return readQueueRows<StoredRetryAudit>(
    dbPath,
    "run_retry_audit",
    "SELECT run_id, task_key, actor, action, message FROM run_retry_audit ORDER BY id",
  );
}

/**
 * Second POST while an ad-hoc retry is queued or starting.
 *
 * The handler rejects that overlap: the row is already pending/running, the
 * re-queue update lost the race, or the worker has already opened a run.
 *
 * Pending/running may omit the "not retriable:" prefix. Eligibility adds it
 * (`resolveRetryEligibility` → `conflict`), and a loser that already passed
 * that read gets the same sentence bare from `retryInjectedRun`. "Moved on"
 * and "in progress" stay exact.
 */
export function isDuplicateRetryRejection(taskKey: string, error: string): boolean {
  const task = taskKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    error === `ad-hoc task ${taskKey} moved on; reload the run and try again` ||
    new RegExp(
      `^(?:not retriable: )?ad-hoc task ${task} is already (?:pending|running) \\(task #\\d+\\)$`,
    ).test(error) ||
    new RegExp(
      `^${task} already has a run in progress \\(run \\d+\\); wait for it to finish$`,
    ).test(error)
  );
}

/** Status and parsed JSON body of one dashboard response. */
export interface DashboardWriteResult<T = unknown> {
  status: number;
  body: T;
}

/**
 * Send the same guarded write `count` times at once and collect every
 * status/body pair in request order, for one-accepted/one-refused races.
 */
export async function concurrentDashboardWrites<T = unknown>(
  baseUrl: string,
  path: string,
  count = 2,
): Promise<Array<DashboardWriteResult<T>>> {
  const responses = await Promise.all(
    Array.from({ length: count }, () =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers: dashboardWriteHeaders(baseUrl) }),
    ),
  );
  return await Promise.all(
    responses.map(async (response) => ({
      status: response.status,
      body: (await response.json()) as T,
    })),
  );
}

/** Collect a child stream into memory without blocking the spawned process. */
async function capture(stream: ReadableStream<Uint8Array>, chunks: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
  } finally {
    reader.releaseLock();
  }
}

/** Resolve `true` when the child exits before the timeout, otherwise `false`. */
async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([child.exited.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A built `devintern dashboard` process bound to an ephemeral loopback port.
 *
 * Start one with {@link DashboardFixture.start} after the worker has produced a
 * run, and call {@link DashboardFixture.stop} in `finally`. The dashboard is a
 * read-only observer of the worker's database, so both processes can run at the
 * same time.
 */
export class DashboardFixture {
  readonly baseUrl: string;
  private readonly stdoutChunks: string[] = [];
  private readonly stderrChunks: string[] = [];
  private readonly captured: Promise<void>[];
  private stopped = false;

  private constructor(
    readonly env: Record<string, string>,
    readonly host: string,
    readonly port: number,
    private readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  ) {
    this.baseUrl = dashboardBaseUrl(host, port);
    this.captured = [
      capture(child.stdout, this.stdoutChunks),
      capture(child.stderr, this.stderrChunks),
    ];
  }

  /** Spawn the built CLI and resolve only after `GET /api/health` returns 200. */
  static async start(
    worker: WorkerFixture,
    options: DashboardFixtureOptions = {},
  ): Promise<DashboardFixture> {
    // The health poll and callers' fetches run in this process; keep them off
    // any ambient proxy even when the bunfig preload did not run (root runs).
    ensureLoopbackBypassesProxy();
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? (await freePort(host));
    const child = Bun.spawn(
      [
        process.execPath,
        cliPath,
        "dashboard",
        "--host",
        host,
        "--port",
        String(port),
        ...(options.args ?? []),
      ],
      {
        cwd: options.cwd ?? worker.workspaceDir,
        env: { ...worker.env, ...options.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const fixture = new DashboardFixture({ ...worker.env, ...options.env }, host, port, child);
    try {
      await fixture.waitForHealth();
      return fixture;
    } catch (error) {
      await fixture.stop();
      throw error;
    }
  }

  /** Captured stdout, useful in failure messages. */
  get stdout(): string {
    return this.stdoutChunks.join("");
  }

  /** Captured stderr, useful in failure messages. */
  get stderr(): string {
    return this.stderrChunks.join("");
  }

  /** Exit code once the child has exited, otherwise null. */
  get exitCode(): number | null {
    return this.child.exitCode;
  }

  /** Whether the dashboard child is still running. */
  get running(): boolean {
    return this.child.exitCode === null;
  }

  /** Poll the health endpoint until the server is ready or the child exits. */
  private async waitForHealth(): Promise<void> {
    await waitForDashboardHealth(this.baseUrl, {
      assertAlive: () => {
        if (this.child.exitCode !== null) {
          throw new Error(
            `dashboard exited before becoming healthy (${this.child.exitCode})\n` +
              `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
          );
        }
      },
      describe: () => `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
    });
  }

  /** SIGTERM the child, wait for its graceful exit, then force-kill it. */
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<number | null> {
    if (!this.stopped) {
      this.stopped = true;
      if (this.child.exitCode === null) {
        this.child.kill("SIGTERM");
        if (!(await waitForExit(this.child, timeoutMs))) {
          this.child.kill("SIGKILL");
          await this.child.exited;
        }
      }
      await Promise.all(this.captured);
    }
    return this.child.exitCode;
  }
}

/** One Inbox row as `GET /api/notifications` serves it (the fields the suites assert on). */
export interface DashboardNotification {
  id: number;
  kind: string;
  severity: "high" | "normal";
  groupKey: string;
  count: number;
  runId?: number;
  repo?: string;
  subject?: string;
  title: string;
  body?: string;
  createdAt: number;
  updatedAt: number;
  readAt?: number;
  resolvedAt?: number;
  muted: boolean;
}

/** `GET /api/notifications` page. */
export interface DashboardNotificationPage {
  notifications: DashboardNotification[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /api/notifications/unread-count` body. */
export interface DashboardUnreadCount {
  unread: number;
  unreadHigh: number;
}

/** `GET /api/notifications/mutes` entry. */
export interface DashboardNotificationMute {
  groupKey: string;
  mutedAt: number;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function numberField(row: Record<string, unknown>, key: string, context: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}: ${key} must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function stringField(row: Record<string, unknown>, key: string, context: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`${context}: ${key} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optional<T>(
  row: Record<string, unknown>,
  key: string,
  read: (row: Record<string, unknown>, key: string, context: string) => T,
  context: string,
): T | undefined {
  return row[key] === undefined || row[key] === null ? undefined : read(row, key, context);
}

/** Parse one served notification; throws with the offending field on a shape change. */
export function parseDashboardNotification(raw: unknown): DashboardNotification {
  const context = "notification";
  const row = record(raw, context);
  const severity = stringField(row, "severity", context);
  if (severity !== "high" && severity !== "normal") {
    throw new Error(`${context}: unexpected severity ${JSON.stringify(severity)}`);
  }
  if (typeof row.muted !== "boolean") {
    throw new Error(`${context}: muted must be a boolean, got ${JSON.stringify(row.muted)}`);
  }
  const runId = optional(row, "runId", numberField, context);
  const repo = optional(row, "repo", stringField, context);
  const subject = optional(row, "subject", stringField, context);
  const body = optional(row, "body", stringField, context);
  const readAt = optional(row, "readAt", numberField, context);
  const resolvedAt = optional(row, "resolvedAt", numberField, context);
  return {
    id: numberField(row, "id", context),
    kind: stringField(row, "kind", context),
    severity,
    groupKey: stringField(row, "groupKey", context),
    count: numberField(row, "count", context),
    ...(runId !== undefined ? { runId } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(subject !== undefined ? { subject } : {}),
    title: stringField(row, "title", context),
    ...(body !== undefined ? { body } : {}),
    createdAt: numberField(row, "createdAt", context),
    updatedAt: numberField(row, "updatedAt", context),
    ...(readAt !== undefined ? { readAt } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    muted: row.muted,
  };
}

async function okJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`${label} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text) as unknown;
}

/** List query parameters accepted by `GET /api/notifications`. */
export interface NotificationListQuery {
  unresolved?: boolean;
  severity?: string;
  kind?: string;
  includeMuted?: boolean;
  limit?: number;
  offset?: number;
}

/** `GET /api/notifications` with the given filters, parsed into a page. */
export async function listNotifications(
  baseUrl: string,
  query: NotificationListQuery = {},
): Promise<DashboardNotificationPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.size > 0 ? `?${params.toString()}` : "";
  const label = `GET /api/notifications${search}`;
  const body = record(
    await okJson(await fetch(`${baseUrl}/api/notifications${search}`), label),
    label,
  );
  if (!Array.isArray(body.notifications)) {
    throw new Error(`${label}: notifications must be an array`);
  }
  return {
    notifications: body.notifications.map(parseDashboardNotification),
    total: numberField(body, "total", label),
    limit: numberField(body, "limit", label),
    offset: numberField(body, "offset", label),
  };
}

/** `GET /api/notifications/unread-count`. */
export async function notificationUnreadCount(baseUrl: string): Promise<DashboardUnreadCount> {
  const label = "GET /api/notifications/unread-count";
  const body = record(
    await okJson(await fetch(`${baseUrl}/api/notifications/unread-count`), label),
    label,
  );
  return {
    unread: numberField(body, "unread", label),
    unreadHigh: numberField(body, "unreadHigh", label),
  };
}

/** `GET /api/notifications/mutes`. */
export async function notificationMutes(baseUrl: string): Promise<DashboardNotificationMute[]> {
  const label = "GET /api/notifications/mutes";
  const body = record(
    await okJson(await fetch(`${baseUrl}/api/notifications/mutes`), label),
    label,
  );
  if (!Array.isArray(body.mutes)) throw new Error(`${label}: mutes must be an array`);
  return body.mutes.map((raw) => {
    const row = record(raw, label);
    return {
      groupKey: stringField(row, "groupKey", label),
      mutedAt: numberField(row, "mutedAt", label),
    };
  });
}

/**
 * Send one guarded notification write (`/api/notifications/<path>`) with the
 * dashboard's own write headers; returns the status and parsed body.
 */
export async function notificationWrite(
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<DashboardWriteResult<Record<string, unknown>>> {
  const response = await fetch(`${baseUrl}/api/notifications/${path}`, {
    method: "POST",
    headers: dashboardWriteHeaders(baseUrl),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: record(await response.json(), `POST ${path}`) };
}
