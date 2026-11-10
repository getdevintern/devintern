import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

import { RunStore } from "../src/lib/state/run-recorder";
import { queueFailureReason } from "../src/lib/workspace/queue-failure-reason";

describe("queueFailureReason", () => {
  test("uses the last harness attempt after migrating a unique claim index", () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-reason-"));
    try {
      const dbPath = join(dir, "queue.db");
      const firstStore = new RunStore(dbPath);
      const first = firstStore.createRun({
        origin: "local",
        taskKey: "local-failover",
        queueClaim: "failover-claim",
      });
      firstStore.finishRun(first, "deferred", "primary usage limit");
      firstStore.close();

      const db = new Database(dbPath);
      db.run("DROP INDEX idx_runs_queue_claim");
      db.run("CREATE UNIQUE INDEX idx_runs_queue_claim ON runs(queue_claim)");
      db.close();

      const secondStore = new RunStore(dbPath);
      const second = secondStore.createRun({
        origin: "local",
        taskKey: "local-failover",
        queueClaim: "failover-claim",
      });
      secondStore.finishRun(second, "failed", "fallback failed");
      secondStore.close();

      expect(queueFailureReason(dbPath, "failover-claim")).toBe("fallback failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["failed", "abandoned", "escalated"] as const)(
    "copies a %s local run reason into a failed queue row",
    (status) => {
      const dir = mkdtempSync(join(tmpdir(), "queue-reason-"));
      try {
        const dbPath = join(dir, "queue.db");
        const runs = new RunStore(dbPath);
        const id = runs.createRun({
          origin: "local",
          taskKey: "local-reason",
          repo: "backend",
          queueClaim: "current-claim",
        });
        runs.finishRun(id, status, `${status} reason`);
        runs.close();
        expect(queueFailureReason(dbPath, "current-claim")).toBe(`${status} reason`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
