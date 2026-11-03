import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedEnvironment } from "./environment";
import { cliPath } from "./fixture-workspace";

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 50;
const STOP_TIMEOUT_MS = 5_000;
const PAUSED_QUEUE_WINDOW_MS = 60 * 60 * 1000;

/** Ask the OS for a currently free port on a loopback host. */
export async function freePort(hostname = "127.0.0.1"): Promise<number> {
  const server = Bun.serve({
    hostname,
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

/**
 * Create an empty queue database at `dbPath`.
 *
 * `WebhookQueue` copies the hardcoded legacy `/tmp/devintern-webhooks/queue.db`
 * into any missing `WEBHOOK_QUEUE_DB`. Pre-creating the file makes that
 * migration's `existsSync(dbPath)` guard skip the copy, so a developer's real
 * pending events can never replay inside this isolated fixture.
 */
function ensureQueueDb(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.close();
}

/**
 * State of `WEBHOOK_QUEUE_DB` immediately before the child process is spawned.
 *
 * `WebhookQueue` copies the hardcoded legacy `/tmp/devintern-webhooks/queue.db`
 * only when the target database does not exist yet
 * (`migrateLegacyDb`, packages/code/src/lib/state/webhook-queue.ts). This
 * snapshot lets tests assert that precondition without moving or deleting that
 * product-global path.
 */
export interface QueueDbSnapshot {
  /** The target database file already existed, so legacy migration is skipped. */
  exists: boolean;
  /** The schema did not exist yet: the fixture never seeds event rows. */
  hasWebhookEventsTable: boolean;
  /** Rows in `webhook_events`, `0` when the table does not exist. */
  eventCount: number;
}

/** Snapshot the queue database without creating or migrating anything. */
function snapshotQueueDb(dbPath: string): QueueDbSnapshot {
  if (!existsSync(dbPath)) {
    return { exists: false, hasWebhookEventsTable: false, eventCount: 0 };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_events'")
      .get();
    if (!table) {
      return { exists: true, hasWebhookEventsTable: false, eventCount: 0 };
    }
    const row = db.query("SELECT COUNT(*) AS count FROM webhook_events").get() as {
      count: number;
    };
    return { exists: true, hasWebhookEventsTable: true, eventCount: row.count };
  } finally {
    db.close();
  }
}

/**
 * Write an inert agent CLI into the fixture root and return its path.
 *
 * `devintern` resolves the agent harness strictly at startup for every
 * subcommand (`resolveAgentHarness` in packages/code/src/index.ts), so
 * `webhook serve` exits immediately on a machine with no harness CLI on PATH —
 * which is the case on CI runners. Pinning `AGENT_CLI_PATH` keeps the child
 * independent of the host like the other e2e fixtures do, and because the stub
 * does nothing an accepted delivery can never reach a real agent.
 */
function writeAgentStub(root: string): string {
  const stub = join(root, "bin", "agent.ts");
  mkdirSync(dirname(stub), { recursive: true });
  writeFileSync(
    stub,
    "#!/usr/bin/env bun\n// Offline agent stub: webhook-serve tests keep deliveries queued or ignored\n// so the review pipeline never invokes this. It only satisfies the CLI startup\n// harness resolution.\nprocess.exit(0);\n",
    { mode: 0o700 },
  );
  return stub;
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
    /** `WEBHOOK_QUEUE_DB` state captured after setup, before the child spawns. */
    readonly preSpawnQueueDb: QueueDbSnapshot,
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
    // The CLI resolves its agent harness at startup even for `webhook serve`,
    // so pin the same inert stub the other e2e fixtures use instead of
    // depending on whatever agent CLI the host (or CI runner) happens to have.
    env.AGENT_CLI_PATH = writeAgentStub(root);
    if (options.webhookSecret !== undefined) env.WEBHOOK_SECRET = options.webhookSecret;
    if (options.gitlabWebhookSecret !== undefined) {
      env.GITLAB_WEBHOOK_SECRET = options.gitlabWebhookSecret;
    }
    if (options.gitlabWebhookSigningToken !== undefined) {
      env.GITLAB_WEBHOOK_SIGNING_TOKEN = options.gitlabWebhookSigningToken;
    }
    // Always pre-create the queue DB, even when the review queue is not paused:
    // otherwise the child migrates the legacy /tmp queue into this root and
    // recovers (and processes) whatever pending events it finds.
    ensureQueueDb(env.WEBHOOK_QUEUE_DB);
    if (options.pauseReviewQueue) {
      seedFutureRateLimit(env.WEBHOOK_QUEUE_DB, env.AGENT_HARNESS ?? "claude-code");
    }
    // Captured after setup so tests can assert the precondition that makes
    // `migrateLegacyDb` skip the product-global legacy path.
    const preSpawnQueueDb = snapshotQueueDb(env.WEBHOOK_QUEUE_DB);

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
    const fixture = new WebhookServerFixture(root, env, port, child, preSpawnQueueDb);
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
