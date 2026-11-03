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

import { cliPath } from "./fixture-workspace";
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
function baseUrlFor(host: string, port: number): string {
  const normalized = bareHost(host);
  return `http://${normalized.includes(":") ? `[${normalized}]` : normalized}:${port}`;
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
    this.baseUrl = baseUrlFor(host, port);
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
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? (await freePort(host));
    const child = Bun.spawn(
      [process.execPath, cliPath, "dashboard", "--host", host, "--port", String(port)],
      {
        cwd: options.cwd ?? worker.workspaceDir,
        env: worker.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const fixture = new DashboardFixture(worker.env, host, port, child);
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

  /**
   * Poll the health endpoint until the server is ready or the child exits.
   *
   * Uses the documented `{ status: "ok" }` payload rather than waiting on a
   * fixed timer, so a route or handler regression fails immediately.
   */
  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(
          `dashboard exited before becoming healthy (${this.child.exitCode})\n` +
            `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
        );
      }
      try {
        const response = await fetch(`${this.baseUrl}/api/health`);
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
      `dashboard did not become healthy at ${this.baseUrl}\n` +
        `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
    );
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
