/**
 * devintern worker
 *
 * Single long-running daemon on the customer's machine that replaces the
 * cron + standalone webhook server setup. Event acquisition modes:
 *
 * - Mode 1 (polling): per-tracker change detectors feed the queue. No public
 *   endpoint, no DevIntern infrastructure. (Acquirers register here as they
 *   land; the detect-then-evaluate loop ships separately.)
 * - Mode 3 (direct webhooks): `--listen` runs the existing webhook server
 *   inside the daemon (the previous `devintern serve` behavior).
 *
 * Code, credentials, and agent execution never leave this machine.
 */

import type { Server } from "http";

import { LockManager } from "./lib/lock-manager";

export interface WorkerOptions {
  /** Mode 3: also run the GitHub webhook HTTP server. */
  listen: boolean;
  port?: number;
  host?: string;
  /** Mode 1 polling interval in seconds (default 60). */
  intervalSeconds?: number;
  verbose?: boolean;
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

/** Default Mode 1 polling interval (seconds). */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/**
 * Start the worker daemon: single-instance lock, optional webhook listener,
 * registered polling acquirers, and graceful shutdown on SIGINT/SIGTERM.
 *
 * @param options - Daemon options (listen mode, port/host, poll interval)
 * @param acquirers - Polling acquirers to run (Mode 1); empty until detectors register
 */
export async function startWorker(
  options: WorkerOptions,
  acquirers: Acquirer[] = [],
): Promise<void> {
  console.log("👷 Starting devintern worker");
  console.log(`   Project: ${options.label ?? process.cwd()}`);
  console.log(`   Webhook listener (Mode 3): ${options.listen ? "enabled" : "disabled"}`);
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

  if (!options.listen && acquirers.length === 0) {
    console.error("❌ No event sources enabled.");
    console.error(
      "   Poll your tracker with:          devintern worker --query '<ready-tasks query>'",
    );
    console.error("   Or run the webhook listener with: devintern worker --listen");
    lock.release();
    process.exit(1);
  }

  let server: Server | null = null;
  if (options.listen) {
    const { startWebhookServer } = await import("./webhook-server");
    server = await startWebhookServer({ port: options.port, host: options.host });
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

    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      console.log("   Webhook listener stopped");
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
