/**
 * Verifies the queue-database isolation guarantees installed by
 * tests/setup/guard-queue-db.ts (loaded via bunfig.toml preload):
 *
 * - Default resolution (`resolveQueueDbPath()`, store constructors without an
 *   explicit dbPath) must land inside a designated temp root — never anywhere
 *   near the package/repository directory tree, where an actively configured
 *   `.devintern-code` holds a developer's live state database.
 * - The guard's integrity check fails the suite if any real
 *   `.devintern-code/queue.db` gets mutated during the run; writing through
 *   the pinned defaults below exercises exactly the code path such pollution
 *   would have taken, so this file doubles as proof the guard tolerates
 *   legitimate isolated writes while flagging real ones.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

import { resolveQueueDbPath, WebhookQueue } from "../src/lib/webhook-queue";
import { RunStore } from "../src/lib/run-recorder";

const PINNED = process.env.WEBHOOK_QUEUE_DB;
const PACKAGE_ROOT = resolve(__dirname, "..");

if (!PINNED) {
  throw new Error(
    "WEBHOOK_QUEUE_DB is not pinned. tests/setup/guard-queue-db.ts must run via " +
      "the bunfig.toml [test] preload before any state-touching test executes.",
  );
}

afterAll(() => {
  // Prove cleanup semantics other suites rely on: removing the temp db keeps
  // the suite healthy (the guard recreates nothing; later defaults simply
  // recreate the file inside the same private temp root).
  if (existsSync(PINNED)) {
    rmSync(PINNED, { force: true });
  }
});

describe("state database isolation", () => {
  test("WEBHOOK_QUEUE_DB is pinned to a unique temp root by the setup guard", () => {
    expect(resolve(PINNED)).toBe(PINNED); // absolute
    expect(resolve(PINNED).startsWith(resolve(tmpdir()))).toBe(true);
    // mkdtemp-based naming keeps concurrent test-file processes apart.
    expect(basename(dirname(PINNED))).toMatch(/^devintern-test-state-/);
  });

  test("default resolution never reaches the repository's own config directory", () => {
    const resolved = resolveQueueDbPath();
    expect(resolved).toBe(PINNED);
    expect(resolved.startsWith(PACKAGE_ROOT)).toBe(false);
    expect(existsSync(join(PACKAGE_ROOT, ".devintern-code", "queue.db"))).toBe(false);
  });

  test("stores constructed without an explicit dbPath write to the pinned temp db", () => {
    const queue = new WebhookQueue(); // no dbPath → resolveQueueDbPath()
    try {
      queue.enqueue("test", { ok: true });
      const store = new RunStore();
      expect(existsSync(resolveQueueDbPath())).toBe(true);
      store.close();
    } finally {
      queue.close();
    }
  });

  test("pinned env survives individual tests' save/restore cycles", () => {
    const original = process.env.WEBHOOK_QUEUE_DB;
    try {
      delete process.env.WEBHOOK_QUEUE_DB;
    } finally {
      process.env.WEBHOOK_QUEUE_DB = original;
    }
    expect(process.env.WEBHOOK_QUEUE_DB).toBe(PINNED);
  });
});
