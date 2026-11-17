import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { RunStore } from "../src/lib/state/run-recorder";
import { queueFailureReason } from "../src/lib/workspace/queue-failure-reason";

describe("queueFailureReason", () => {
  test("uses the last harness attempt when one claim produced several runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-reason-"));
    try {
      const dbPath = join(dir, "queue.db");
      const runs = new RunStore(dbPath);
      const first = runs.createRun({
        origin: "local",
        taskKey: "local-failover",
        queueClaim: "failover-claim",
      });
      runs.finishRun(first, "deferred", "primary usage limit");
      const second = runs.createRun({
        origin: "local",
        taskKey: "local-failover",
        queueClaim: "failover-claim",
      });
      runs.finishRun(second, "failed", "fallback failed");
      runs.close();

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
