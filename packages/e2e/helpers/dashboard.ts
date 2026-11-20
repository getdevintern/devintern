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
