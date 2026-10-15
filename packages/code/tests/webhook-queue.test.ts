import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { execSync, spawnSync } from "child_process";

import {
  WebhookQueue,
  prepareQueueDbDirectory,
  resolveQueueDbPath,
} from "../src/lib/state/webhook-queue";
import { RowParseError } from "../src/lib/state/row-parse";

/** Insert a row directly, bypassing the queue, to simulate corrupted state. */
function insertRawRow(dbPath: string, sql: string): void {
  const { Database } = require("bun:sqlite");
  const raw = new Database(dbPath);
  try {
    raw.run(sql);
  } finally {
    raw.close();
  }
}

describe("WebhookQueue", () => {
  let dbPath: string;
  let queue: WebhookQueue;

  beforeEach(() => {
    dbPath = join(tmpdir(), `wq-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    queue = new WebhookQueue({ dbPath });
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${dbPath}${suffix}`;
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }
  });

  describe("rate-limit persistence", () => {
    test("round-trips a per-harness rate limit", () => {
      const until = Date.now() + 3_600_000;
      queue.setRateLimit("claude-code", until);
      expect(queue.getRateLimit("claude-code")).toBe(until);
    });

    test("keeps harnesses independent", () => {
      queue.setRateLimit("claude-code", 111);
      expect(queue.getRateLimit("claude-code")).toBe(111);
      expect(queue.getRateLimit("opencode")).toBeNull();
    });

    test("setRateLimit overwrites the previous value", () => {
      queue.setRateLimit("claude-code", 111);
      queue.setRateLimit("claude-code", 222);
      expect(queue.getRateLimit("claude-code")).toBe(222);
    });

    test("clearRateLimit removes the limit", () => {
      queue.setRateLimit("claude-code", 111);
      queue.clearRateLimit("claude-code");
      expect(queue.getRateLimit("claude-code")).toBeNull();
    });

    test("getRateLimit returns null when unset", () => {
      expect(queue.getRateLimit("never-set")).toBeNull();
    });

    test("survives a restart (new instance, same DB file)", () => {
      const until = Date.now() + 1_800_000;
      queue.setRateLimit("claude-code", until);

      // Simulate a process restart by opening a fresh queue on the same file.
      const reopened = new WebhookQueue({ dbPath });
      expect(reopened.getRateLimit("claude-code")).toBe(until);
    });
  });

  describe("requeuePending", () => {
    test("reverts a processing event to pending without counting an attempt", () => {
      const id = queue.enqueue("pull_request_review", { hello: "world" });
      queue.markProcessing(id); // status=processing, attempts=1

      const processing = queue.getEvent(id);
      expect(processing?.status).toBe("processing");
      expect(processing?.attempts).toBe(1);

      queue.requeuePending(id);

      const requeued = queue.getEvent(id);
      expect(requeued?.status).toBe("pending");
      expect(requeued?.attempts).toBe(0); // the deferred run was undone
    });

    test("does not drop attempts below zero", () => {
      const id = queue.enqueue("issue_comment", {});
      // No markProcessing → attempts is 0; requeue must floor at 0.
      queue.requeuePending(id);
      expect(queue.getEvent(id)?.attempts).toBe(0);
    });

    test("a requeued event is recovered by getPendingEvents", () => {
      const id = queue.enqueue("issue_comment", {});
      queue.markProcessing(id);
      queue.requeuePending(id);

      const pending = queue.getPendingEvents();
      expect(pending.some((e) => e.id === id)).toBe(true);
    });
  });

  describe("processed_events dedupe", () => {
    test("hasProcessed is false for unseen ids", () => {
      expect(queue.hasProcessed("github", "delivery-1")).toBe(false);
    });

    test("markProcessed round-trips and is idempotent", () => {
      queue.markProcessed("github", "delivery-1");
      queue.markProcessed("github", "delivery-1"); // duplicate insert must not throw
      expect(queue.hasProcessed("github", "delivery-1")).toBe(true);
    });

    test("tryMarkProcessed grants a claim only once", () => {
      expect(queue.tryMarkProcessed("github", "delivery-claim")).toBe(true);
      expect(queue.tryMarkProcessed("github", "delivery-claim")).toBe(false);
    });

    test("ids are scoped per source", () => {
      queue.markProcessed("github", "id-1");
      expect(queue.hasProcessed("linear", "id-1")).toBe(false);
    });

    test("dedupe state survives event completion and restart", () => {
      const id = queue.enqueue("pull_request_review", {});
      queue.markProcessed("github", "delivery-2");
      queue.markProcessing(id);
      queue.markCompleted(id); // event row is deleted...

      const reopened = new WebhookQueue({ dbPath });
      expect(reopened.getEvent(id)).toBeNull();
      expect(reopened.hasProcessed("github", "delivery-2")).toBe(true); // ...dedupe state is not
    });

    test("cleanupProcessedEvents removes only expired ids", () => {
      queue.markProcessed("github", "old-id");
      queue.markProcessed("github", "fresh-id");

      // Everything is younger than the window → nothing removed.
      expect(queue.cleanupProcessedEvents()).toBe(0);
      // Zero-age window → everything removed.
      expect(queue.cleanupProcessedEvents(-1)).toBe(2);
      expect(queue.hasProcessed("github", "fresh-id")).toBe(false);
    });

    test("cleanup removes terminal base-sync rows but preserves pending work", () => {
      const observe = (externalId: string) =>
        queue.observeBaseSyncEvent({
          externalId,
          repo: "acme/widgets",
          prNumber: 42,
          baseSha: externalId,
          headSha: "head1",
        });
      observe("completed");
      queue.completeBaseSyncEvent("github:base-sync", "completed");
      observe("exhausted");
      queue.exhaustBaseSyncEvent("github:base-sync", "exhausted", "retry limit reached");
      observe("pending");

      queue.cleanupProcessedEvents(-1);

      expect(queue.getBaseSyncEvent("completed")).toBeNull();
      expect(queue.getBaseSyncEvent("exhausted")).toBeNull();
      expect(queue.getBaseSyncEvent("pending")?.status).toBe("pending");
    });
  });

  describe("delivery claims (in-flight vs handled)", () => {
    test("a claimed delivery is in flight, not handled", () => {
      expect(queue.beginDelivery("github", "d1")).toBe("started");
      expect(queue.isInFlight("github", "d1")).toBe(true);
      expect(queue.hasProcessed("github", "d1")).toBe(false);
      // A redelivery while the original runs is neither handled nor runnable.
      expect(queue.beginDelivery("github", "d1")).toBe("inFlight");
    });

    test("completing a claim records it handled and releases the claim", () => {
      queue.beginDelivery("github", "d1");
      queue.completeDelivery("github", "d1");
      expect(queue.hasProcessed("github", "d1")).toBe(true);
      expect(queue.isInFlight("github", "d1")).toBe(false);
      expect(queue.beginDelivery("github", "d1")).toBe("handled");
    });

    test("abandoning a claim leaves it unhandled and reclaimable", () => {
      queue.beginDelivery("github", "d1");
      queue.abandonDelivery("github", "d1");
      expect(queue.hasProcessed("github", "d1")).toBe(false);
      expect(queue.isInFlight("github", "d1")).toBe(false);
      expect(queue.beginDelivery("github", "d1")).toBe("started");
    });

    test("handled state is durable; in-flight state is not", () => {
      queue.beginDelivery("github", "done");
      queue.completeDelivery("github", "done");
      queue.beginDelivery("github", "running");

      const reopened = new WebhookQueue({ dbPath });
      // The handled record survived the restart; the dropped in-flight claim
      // can be reprocessed instead of blocking the delivery forever.
      expect(reopened.beginDelivery("github", "done")).toBe("handled");
      expect(reopened.beginDelivery("github", "running")).toBe("started");
      reopened.close();
    });

    test("claims are scoped per source", () => {
      expect(queue.beginDelivery("github", "shared")).toBe("started");
      expect(queue.beginDelivery("gitlab:webhook", "shared")).toBe("started");
      expect(queue.isInFlight("github", "shared")).toBe(true);
      expect(queue.isInFlight("gitlab:webhook", "shared")).toBe(true);
    });
  });

  describe("malformed rows", () => {
    test("getEvent rejects an unknown status", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO webhook_events (id, event_type, payload, status, created_at, updated_at, attempts)
         VALUES ('bad', 'push', '{}', 'bogus', 1, 1, 0)`,
      );
      expect(() => queue.getEvent("bad")).toThrow(RowParseError);
    });

    test("getPendingEvents skips a malformed event and recovers healthy events", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO webhook_events (id, event_type, payload, status, created_at, updated_at, attempts)
         VALUES ('bad', 'push', '{}', 'pending', 1, 1, 'lots')`,
      );
      const healthyId = queue.enqueue("push", {});
      const warn = console.warn;
      const warnings: string[] = [];
      try {
        console.warn = (message: string) => warnings.push(message);
        expect(queue.getPendingEvents().map((event) => event.id)).toEqual([healthyId]);
      } finally {
        console.warn = warn;
      }
      expect(warnings.some((message) => message.includes("Skipping malformed pending event"))).toBe(
        true,
      );
    });

    test("getBaseSyncEvent rejects a non-numeric pr_number", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO base_sync_events (
           external_id, repo, pr_number, base_sha, head_sha,
           head_observed_at, attempts, status, updated_at
         ) VALUES ('bad', 'acme/widgets', 'one', 'base', 'head', 1, 0, 'pending', 1)`,
      );
      expect(() => queue.getBaseSyncEvent("bad")).toThrow(RowParseError);
    });

    test("getRateLimit rejects a blob value", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO webhook_meta (key, value) VALUES ('rate_limit:claude-code', x'00')`,
      );
      expect(() => queue.getRateLimit("claude-code")).toThrow(RowParseError);
    });

    test("getAllRateLimits skips a malformed row but keeps healthy ones", () => {
      queue.setRateLimit("claude-code", 111);
      insertRawRow(
        dbPath,
        `INSERT INTO webhook_meta (key, value) VALUES ('rate_limit:codex', x'00')`,
      );
      expect(queue.getAllRateLimits()).toEqual({ "claude-code": 111 });
    });

    test("getStats skips an unrecognized status instead of throwing", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO webhook_events (id, event_type, payload, status, created_at, updated_at, attempts)
         VALUES ('bad', 'push', '{}', 'bogus', 1, 1, 0)`,
      );
      queue.enqueue("issue_comment", {});
      expect(queue.getStats()).toEqual({ pending: 1, processing: 0, failed: 0 });
    });

    test("getStats skips a corrupted blob status instead of throwing", () => {
      insertRawRow(
        dbPath,
        `INSERT INTO webhook_events (id, event_type, payload, status, created_at, updated_at, attempts)
         VALUES ('bad', 'push', '{}', x'00', 1, 1, 0)`,
      );
      expect(queue.getStats()).toEqual({ pending: 0, processing: 0, failed: 0 });
    });
  });

  describe("legacy database migration", () => {
    let legacyPath: string;
    let newPath: string;

    beforeEach(() => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      legacyPath = join(tmpdir(), `wq-legacy-${suffix}.db`);
      newPath = join(tmpdir(), `wq-new-${suffix}.db`);
    });

    afterEach(() => {
      for (const base of [legacyPath, newPath]) {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(`${base}${suffix}`, { force: true });
        }
      }
    });

    test("copies the legacy database when the target does not exist", () => {
      const legacy = new WebhookQueue({ dbPath: legacyPath });
      const id = legacy.enqueue("pull_request_review", { pr: 1 });
      legacy.setRateLimit("claude-code", 123);
      legacy.close();

      const migrated = new WebhookQueue({ dbPath: newPath, legacyDbPath: legacyPath });
      expect(migrated.getEvent(id)?.eventType).toBe("pull_request_review");
      expect(migrated.getRateLimit("claude-code")).toBe(123);
      migrated.close();
    });

    test("does not overwrite an existing target database", () => {
      const existing = new WebhookQueue({ dbPath: newPath });
      const keptId = existing.enqueue("issue_comment", {});
      existing.close();

      const legacy = new WebhookQueue({ dbPath: legacyPath });
      const legacyId = legacy.enqueue("pull_request_review", {});
      legacy.close();

      const reopened = new WebhookQueue({ dbPath: newPath, legacyDbPath: legacyPath });
      expect(reopened.getEvent(keptId)).not.toBeNull();
      expect(reopened.getEvent(legacyId)).toBeNull();
      reopened.close();
    });

    test("starts fresh when no legacy database exists", () => {
      const fresh = new WebhookQueue({ dbPath: newPath, legacyDbPath: legacyPath });
      expect(fresh.getPendingEvents()).toEqual([]);
      fresh.close();
    });
  });
});

describe("resolveQueueDbPath", () => {
  const originalEnv = process.env.WEBHOOK_QUEUE_DB;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WEBHOOK_QUEUE_DB;
    } else {
      process.env.WEBHOOK_QUEUE_DB = originalEnv;
    }
  });

  test("honors the WEBHOOK_QUEUE_DB override", () => {
    process.env.WEBHOOK_QUEUE_DB = "/custom/queue.db";
    expect(resolveQueueDbPath("/some/project")).toBe("/custom/queue.db");
  });

  test("defaults to .devintern-code/queue.db under the project directory", () => {
    delete process.env.WEBHOOK_QUEUE_DB;
    expect(resolveQueueDbPath("/some/project")).toBe(
      join("/some/project", ".devintern-code", "queue.db"),
    );
  });

  test("keeps the state database out of git via .git/info/exclude", () => {
    delete process.env.WEBHOOK_QUEUE_DB;

    const projectDir = join(
      tmpdir(),
      `queue-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectDir, { recursive: true });
    execSync("git init -q .", { cwd: projectDir });

    try {
      const dbPath = resolveQueueDbPath(projectDir);
      prepareQueueDbDirectory(dbPath);
      writeFileSync(dbPath, "state\n", "utf8");

      // Untracked-but-ignored: `git add -A` cannot sweep it into a commit and
      // `git clean` cannot delete it.
      expect(execSync("git status --porcelain", { cwd: projectDir }).toString()).toBe("");
      expect(spawnSync("git", ["check-ignore", "-q", dbPath], { cwd: projectDir }).status).toBe(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("does not write info/exclude when .gitignore already covers the database", () => {
    delete process.env.WEBHOOK_QUEUE_DB;

    const projectDir = join(
      tmpdir(),
      `queue-ignore-existing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectDir, { recursive: true });
    execSync("git init -q .", { cwd: projectDir });
    writeFileSync(join(projectDir, ".gitignore"), ".devintern-code/\n", "utf8");

    try {
      const dbPath = resolveQueueDbPath(projectDir);
      prepareQueueDbDirectory(dbPath);
      writeFileSync(dbPath, "state\n", "utf8");

      // The project's own ignore rules already hide the file, so the
      // redundant pattern is not appended to the local exclude.
      const exclude = readFileSync(join(projectDir, ".git", "info", "exclude"), "utf8");
      expect(exclude).not.toContain("queue.db");
      expect(spawnSync("git", ["check-ignore", "-q", dbPath], { cwd: projectDir }).status).toBe(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("reuses the project database when run from a subdirectory", () => {
    delete process.env.WEBHOOK_QUEUE_DB;

    const projectDir = join(
      tmpdir(),
      `queue-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const subDir = join(projectDir, "packages", "app");
    mkdirSync(join(projectDir, ".devintern-code"), { recursive: true });
    mkdirSync(subDir, { recursive: true });

    try {
      expect(resolveQueueDbPath(subDir)).toBe(join(projectDir, ".devintern-code", "queue.db"));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
