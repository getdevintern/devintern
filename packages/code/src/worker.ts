/**
 * devintern worker
 *
 * Single long-running workspace daemon on the customer's machine. Event
 * acquirers feed work into the shared queue without exposing a public port.
 *
 * - Mode 1 (polling): per-tracker change detectors feed the queue. No public
 *   endpoint, no DevIntern infrastructure. (Acquirers register here as they
 *   land; the detect-then-evaluate loop ships separately.)
 * Code, credentials, and agent execution never leave this machine.
 */

import { flushErrorTracking } from "@devintern/utils";
import { LockManager } from "./lib/lock-manager";
import { initSentryOnce } from "./lib/sentry-init";
import { startWorkerCapture } from "./lib/worker-capture";
import type { WorkerCaptureHandle } from "./lib/worker-capture";

export interface WorkerOptions {
  /** Single-instance lock override (workspace mode locks the workspace home
   *  instead of the current directory). */
  lock?: LockManager;
  /** What this worker serves, for the startup banner (defaults to cwd). */
  label?: string;
  /** Directory for the dashboard's `worker.stdout.log` / `worker.stderr.log`
   *  capture files (the workspace home). Omit to skip self-capture. */
  logDir?: string;
  /** Called once after every configured event source starts successfully. */
  onStarted?: (acquirerNames: string[]) => Promise<void> | void;
  /**
   * Mode-specific cleanup awaited after acquirers stop and before the worker
   * lock is released. A future execution supervisor uses this to settle jobs,
   * destroy sandboxes, and close its durable stores.
   */
  onShutdown?: () => Promise<void> | void;
  /** Maximum time allowed for `onShutdown` before the worker exits. */
  shutdownTimeoutMs?: number;
}

/** Default bound for mode-specific graceful shutdown work. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * An event acquirer turns "something changed at the source" into queued work.
 * One per configured source; started/stopped by the daemon.
 */
export interface Acquirer {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface WorkerShutdownDependencies {
  acquirers: Array<Pick<Acquirer, "name" | "stop">>;
  lock: Pick<LockManager, "release">;
  capture?: Pick<WorkerCaptureHandle, "stop"> | null;
  onShutdown?: () => Promise<void> | void;
  shutdownTimeoutMs?: number;
  flush?: () => Promise<void>;
  exit?: (code: number) => void;
}

/** Await one hook, rejecting when its graceful-shutdown allowance expires. */
async function runShutdownHook(hook: () => Promise<void> | void, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(hook),
      // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise API.
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`shutdown hook timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the worker's idempotent signal handler.
 *
 * The first signal performs graceful cleanup. A second signal requests an
 * immediate non-zero exit so an uncooperative acquirer or child process can
 * never trap the daemon indefinitely. Dependencies are injectable so shutdown
 * ordering can be verified without sending signals to the test process.
 */
export function createWorkerShutdownHandler(
  dependencies: WorkerShutdownDependencies,
): (signal: string) => Promise<void> {
  let shuttingDown = false;
  let forceExitRequested = false;
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  const flush = dependencies.flush ?? flushErrorTracking;

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      if (!forceExitRequested) {
        forceExitRequested = true;
        console.warn(`\n⚠️  Received ${signal} during shutdown; forcing exit.`);
        exit(1);
      }
      return;
    }
    shuttingDown = true;
    console.log(`\n🛑 Received ${signal}, shutting down worker...`);

    for (const acquirer of dependencies.acquirers) {
      try {
        await acquirer.stop();
      } catch (error) {
        console.warn(`⚠️  Failed to stop acquirer ${acquirer.name}: ${(error as Error).message}`);
      }
    }

    if (dependencies.onShutdown) {
      const timeoutMs = dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      try {
        await runShutdownHook(dependencies.onShutdown, timeoutMs);
      } catch (error) {
        console.warn(`⚠️  Shutdown hook failed: ${(error as Error).message}`);
      }
    }

    // Release singleton ownership only after mode-specific resources settle.
    try {
      dependencies.lock.release();
    } catch (error) {
      console.warn(`⚠️  Failed to release worker lock: ${(error as Error).message}`);
    }
    try {
      dependencies.capture?.stop();
    } catch (error) {
      console.warn(`⚠️  Failed to stop worker log capture: ${(error as Error).message}`);
    }
    // Acquirers may have captured handled failures (poll/dispatch errors);
    // give pending events a bounded chance to send before exiting.
    try {
      await flush();
    } catch (error) {
      console.warn(`⚠️  Failed to flush error tracking: ${(error as Error).message}`);
    }
    console.log("👋 Worker stopped");
    if (!forceExitRequested) {
      exit(0);
    }
  };
}

/**
 * Start the worker daemon: single-instance lock, registered event acquirers,
 * and graceful shutdown on SIGINT/SIGTERM.
 *
 * @param options - Daemon options such as workspace lock and display label
 * @param acquirers - Polling acquirers to run (Mode 1); empty until detectors register
 */
export async function startWorker(
  options: WorkerOptions,
  acquirers: Acquirer[] = [],
): Promise<void> {
  // Entry-point safety net: the `devintern worker` CLI shell already
  // initialized tracking, but startWorker must not depend on that — a no-op
  // if initialized, a no-op with SENTRY_DISABLED=1 either way.
  initSentryOnce();

  // Self-capture first so the startup banner lands in the log files the
  // dashboard tails; a capture failure never blocks the daemon.
  let capture: WorkerCaptureHandle | null = null;
  if (options.logDir) {
    try {
      capture = startWorkerCapture(options.logDir);
    } catch {
      capture = null;
    }
  }

  console.log("👷 Starting devintern worker");
  console.log(`   Workspace: ${options.label ?? process.cwd()}`);
  console.log(
    `   Polling sources (Mode 1): ${
      acquirers.length > 0 ? acquirers.map((a) => a.name).join(", ") : "none configured"
    }`,
  );

  // Single-instance guard, separate from the CLI task lock so an idle daemon
  // does not block manual `devintern TASK-123` runs. The executor still takes
  // the task lock per run (one in-flight task per repo).
  const lock = options.lock ?? new LockManager(process.cwd(), ".worker.lock");
  const lockResult = lock.acquire();
  if (!lockResult.success) {
    console.error(`❌ ${lockResult.message.replace("devintern", "devintern worker")}`);
    process.exit(1);
  }

  if (acquirers.length === 0) {
    console.error("❌ No event sources enabled.");
    console.error(
      "   Set [defaults].task_query in workspace.toml, or add [[automations]] / [[estimations]].",
    );
    console.error("   Direct webhooks are a separate command:  devintern webhook serve");
    lock.release();
    process.exit(1);
  }

  for (const acquirer of acquirers) {
    await acquirer.start();
  }
  await options.onStarted?.(acquirers.map((acquirer) => acquirer.name));

  const shutdown = createWorkerShutdownHandler({
    acquirers,
    lock,
    capture,
    onShutdown: options.onShutdown,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
