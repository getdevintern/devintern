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

import { LockManager } from "./lib/lock-manager";

export interface WorkerOptions {
  /** Single-instance lock override (workspace mode locks the workspace home
   *  instead of the current directory). */
  lock?: LockManager;
  /** What this worker serves, for the startup banner (defaults to cwd). */
  label?: string;
}

/**
 * An event acquirer turns "something changed at the source" into queued work.
 * One per configured source; started/stopped by the daemon.
 */
export interface Acquirer {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
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
      "   Poll your tracker with:          devintern worker --query '<ready-tasks query>'",
    );
    console.error("   Or run the webhook listener with: devintern webhook serve");
    lock.release();
    process.exit(1);
  }

  for (const acquirer of acquirers) {
    await acquirer.start();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n🛑 Received ${signal}, shutting down worker...`);

    for (const acquirer of acquirers) {
      try {
        await acquirer.stop();
      } catch (error) {
        console.warn(`⚠️  Failed to stop acquirer ${acquirer.name}: ${(error as Error).message}`);
      }
    }

    // In-flight queue events stay marked in SQLite and are recovered on the
    // next start; shutdown never loses accepted work.
    lock.release();
    console.log("👋 Worker stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
