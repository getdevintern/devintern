import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment } from "./environment";
import { cliPath } from "./fixture-workspace";

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 50;
const STOP_TIMEOUT_MS = 5_000;
const PAUSED_QUEUE_WINDOW_MS = 60 * 60 * 1000;

/** Ask the OS for a currently free loopback port. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    const port = server.port;
    if (port === undefined) throw new Error("Bun.serve did not report an assigned port");
    return port;
  } finally {
    server.stop(true);
  }
}

export interface WebhookServerFixtureOptions {
  webhookSecret?: string;
  gitlabWebhookSecret?: string;
  gitlabWebhookSigningToken?: string;
  /**
   * Persist a future rate-limit window for the isolated environment's
   * `AGENT_HARNESS` before startup. That pauses the review queue, so accepted
   * deliveries stay in flight instead of reaching a real provider API. Used to
   * assert the in-progress dedupe branch deterministically and offline.
   */
  pauseReviewQueue?: boolean;
}

/** Write the queue metadata row that makes the restored failover chain exhausted. */
function seedFutureRateLimit(dbPath: string, harness: string): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS webhook_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    db.run(
      `INSERT INTO webhook_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`rate_limit:${harness}`, String(Date.now() + PAUSED_QUEUE_WINDOW_MS)],
    );
  } finally {
    db.close();
  }
}

/** Collect a child stream into memory without blocking the spawned process. */
async function capture(stream: ReadableStream<Uint8Array>, chunks: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
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
 * A built `devintern webhook serve` process bound to an ephemeral loopback port.
 *
 * The fixture owns a temporary HOME/workspace/output/queue DB root. `dispose`
 * stops the child with SIGTERM, escalates to SIGKILL, and removes the root, so
 * callers can always use it in `finally`.
 */
export class WebhookServerFixture {
  readonly baseUrl: string;
  readonly queueDbPath: string;
  private readonly stdoutChunks: string[] = [];
  private readonly stderrChunks: string[] = [];
  private readonly captured: Promise<void>[];
  private stopped = false;

  private constructor(
    readonly root: string,
    readonly env: Record<string, string>,
    port: number,
    private readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.queueDbPath = env.WEBHOOK_QUEUE_DB;
    this.captured = [
      capture(child.stdout, this.stdoutChunks),
      capture(child.stderr, this.stderrChunks),
    ];
  }

  /** Spawn the built CLI and resolve only after `GET /health` returns 200. */
  static async start(options: WebhookServerFixtureOptions = {}): Promise<WebhookServerFixture> {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-webhook-"));
    const env = isolatedEnvironment(root);
    if (options.webhookSecret !== undefined) env.WEBHOOK_SECRET = options.webhookSecret;
    if (options.gitlabWebhookSecret !== undefined) {
      env.GITLAB_WEBHOOK_SECRET = options.gitlabWebhookSecret;
    }
    if (options.gitlabWebhookSigningToken !== undefined) {
      env.GITLAB_WEBHOOK_SIGNING_TOKEN = options.gitlabWebhookSigningToken;
    }
    if (options.pauseReviewQueue) {
      seedFutureRateLimit(env.WEBHOOK_QUEUE_DB, env.AGENT_HARNESS ?? "claude-code");
    }

    const port = await freePort();
    const child = Bun.spawn(
      [
        process.execPath,
        cliPath,
        "webhook",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const fixture = new WebhookServerFixture(root, env, port, child);
    try {
      await fixture.waitForHealth();
      return fixture;
    } catch (error) {
      await fixture.dispose();
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

  /** Poll the health endpoint until the server is ready or the child exits. */
  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(
          `webhook serve exited before becoming healthy (${this.child.exitCode})\n` +
            `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
        );
      }
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (response.ok) {
          const payload = (await response.json()) as { status?: unknown };
          if (payload.status === "ok") return;
        }
      } catch {
        // The socket is not accepting connections yet.
      }
      await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(
      `webhook serve did not become healthy at ${this.baseUrl}\n` +
        `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
    );
  }

  /** Stop the child process; safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      if (!(await waitForExit(this.child, STOP_TIMEOUT_MS))) {
        this.child.kill("SIGKILL");
        await this.child.exited;
      }
    }
    await Promise.all(this.captured);
  }

  /** Stop the child and remove the temporary root. */
  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
