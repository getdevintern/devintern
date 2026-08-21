import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AutomationStateStore } from "../src/lib/automation-state";
import type { AutomationConfig } from "../src/lib/automation-config";

const AUTOMATION: AutomationConfig = {
  id: "cleanup",
  enabled: true,
  prompt: "clean up",
  action: "headless",
  interval: "15m",
  intervalMs: 900_000,
};

describe("AutomationStateStore", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const path of paths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("persists interval anchors and claims across restart", () => {
    const path = join(tmpdir(), `automation-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    const first = new AutomationStateStore(path);
    first.register(AUTOMATION, 1_000);
    expect(first.claim(AUTOMATION.id, "worker-a", 1_000, 901_000, 60_000)).toBe(true);
    first.close();

    const reopened = new AutomationStateStore(path);
    const state = reopened.get(AUTOMATION.id);
    expect(state?.lastScheduledAt).toBe(1_000);
    expect(state?.nextDueAt).toBe(901_000);
    expect(state?.leaseOwner).toBe("worker-a");
    reopened.close();
  });

  test("prevents overlap, advances skipped occurrence, and recovers stale leases", () => {
    const path = join(tmpdir(), `automation-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    const store = new AutomationStateStore(path);
    store.register(AUTOMATION, 100);
    expect(store.claim(AUTOMATION.id, "worker-a", 100, 200, 500)).toBe(true);
    expect(store.claim(AUTOMATION.id, "worker-b", 200, 300, 50)).toBe(false);
    expect(store.skipOverlap(AUTOMATION.id, 200, 300)).toBe(true);
    expect(store.claim(AUTOMATION.id, "worker-b", 600, 700, 50)).toBe(true);
    expect(store.get(AUTOMATION.id)?.leaseOwner).toBe("worker-b");
    store.close();
  });
});
