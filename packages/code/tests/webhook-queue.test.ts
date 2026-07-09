import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { WebhookQueue } from "../src/lib/webhook-queue";

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
});
