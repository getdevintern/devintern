/**
 * Test setup guard — preloaded before every test via `bunfig.toml`.
 *
 * Guarantees the suite never mutates a developer's real state database
 * (`.devintern-code/queue.db`: webhook queue, worker cursors, run records,
 * retry state). Two mechanisms:
 *
 * 1. Pinning. `WEBHOOK_QUEUE_DB` is force-set to a `queue.db` inside a unique
 *    mkdtemp directory for this test-file process. Every store that omits an
 *    explicit `dbPath` (`new RunStore()`, `new WorkerState()`,
 *    `resolveQueueDbPath()`, ...) resolves through that env var first, so
 *    default-resolution code paths land here instead of walking up from cwd
 *    into an actively configured `.devintern-code` (this monorepo has one).
 *    Tests that spawn subprocesses thread `{ ...process.env }` at spawn time,
 *    so children inherit the pin too. Per AGENTS.md tests run as isolated
 *    processes per file, and mkdtempSync is unique per process — no shared
 *    temp path across tests. Tests needing their own store must still create
 *    a per-test temp dir and pass `dbPath` / set `WEBHOOK_QUEUE_DB`
 *    explicitly (see webhook-queue.test.ts / worker-state.test.ts).
 *
 * 2. Verification. All `.devintern-code/queue.db` files discoverable by the
 *    same ancestor walk `resolveQueueDbPath` uses are hashed at load. An
 *    afterAll hook re-hashes them: any mutation, creation, or deletion of a
 *    real database during the suite fails the run loudly, turning silent
 *    pollution of live service state into a test failure.
 */

import { afterAll } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

/** Unique per-test-file temp root; removed again in afterAll/exit cleanup. */
const tempRoot = mkdtempSync(join(tmpdir(), "devintern-test-state-"));
const pinnedDbPath = join(tempRoot, "queue.db");

// Unconditional override: a value inherited from the developer's shell could
// point straight at production state, which is exactly what this guard exists
// to prevent. Tests that manipulate the variable save/restore its value, so
// restoring lands back on this pinned path.
process.env.WEBHOOK_QUEUE_DB = pinnedDbPath;

interface Snapshot {
  dbPath: string;
  existed: boolean;
  hash: string | null;
}

function sha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Queue databases reachable by walking up from cwd — the exact traversal
 * `findConfigDir` performs inside `resolveQueueDbPath`, i.e. every real
 * database a default resolution could have hit.
 */
function snapshotRealQueueDbs(): Snapshot[] {
  const snapshots: Snapshot[] = [];
  let directory = resolve(process.cwd());
  for (;;) {
    const dbPath = join(directory, ".devintern-code", "queue.db");
    snapshots.push({ dbPath, existed: existsSync(dbPath), hash: sha256(dbPath) });
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return snapshots;
}

const snapshots = snapshotRealQueueDbs();

afterAll(() => {
  const violations: string[] = [];
  for (const snapshot of snapshots) {
    const existsNow = existsSync(snapshot.dbPath);
    if (!snapshot.existed && existsNow) {
      violations.push(`CREATED   ${snapshot.dbPath}`);
      continue;
    }
    if (snapshot.existed && !existsNow) {
      violations.push(`DELETED   ${snapshot.dbPath}`);
      continue;
    }
    if (snapshot.existed) {
      const hashNow = sha256(snapshot.dbPath);
      if (snapshot.hash !== hashNow) {
        violations.push(`MUTATED   ${snapshot.dbPath}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      "Tests touched the real .devintern-code state database.\n" +
        "Every test must point WEBHOOK_QUEUE_DB (or an explicit dbPath) at its " +
        "own unique temp directory; this guard pins it for you when unset.\n" +
        violations.join("\n"),
    );
  }
});

// Cleanup runs even after all tests failed or the runner bailed out early.
process.on("exit", () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Best effort: leftover temp state under the OS tmpdir is harmless.
  }
});
