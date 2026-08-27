import { afterAll, describe, expect, test } from "bun:test";

import { AutomationCheckpointStore } from "../src/lib/automations/checkpoint-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "devintern-checkpoints-"));
const dbPath = join(dir, "queue.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("automation checkpoint store", () => {
  test("returns null before the first checkpoint", () => {
    const store = new AutomationCheckpointStore(dbPath);
    try {
      expect(store.get("repo-a", "drift-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("persists and updates checkpoints per repo and automation", () => {
    const store = new AutomationCheckpointStore(dbPath);
    try {
      store.set("repo-a", "drift-1", "docs-drift-guard", "a".repeat(40));
      const record = store.get("repo-a", "drift-1");
      expect(record?.lastProcessedSha).toBe("a".repeat(40));
      expect(record?.preset).toBe("docs-drift-guard");

      // Independent keys do not interfere.
      expect(store.get("repo-b", "drift-1")).toBeNull();
      store.set("repo-b", "drift-1", "docs-drift-guard", "b".repeat(40));
      expect(store.get("repo-a", "drift-1")?.lastProcessedSha).toBe("a".repeat(40));

      // Upsert overwrites.
      store.set("repo-a", "drift-1", "docs-drift-guard", "c".repeat(40));
      expect(store.get("repo-a", "drift-1")?.lastProcessedSha).toBe("c".repeat(40));
      expect((store.get("repo-a", "drift-1")?.updatedAt ?? 0) > 0).toBe(true);
    } finally {
      store.close();
    }
  });

  test("reopens the same database and clear() forgets checkpoints", () => {
    const first = new AutomationCheckpointStore(dbPath);
    first.set("repo-a", "drift-2", "docs-drift-guard", "d".repeat(40));
    first.close();

    const second = new AutomationCheckpointStore(dbPath);
    try {
      expect(second.get("repo-a", "drift-2")?.lastProcessedSha).toBe("d".repeat(40));
      second.clear("repo-a", "drift-2");
      expect(second.get("repo-a", "drift-2")).toBeNull();
    } finally {
      second.close();
    }
  });
});
