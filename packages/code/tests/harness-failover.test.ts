import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getHarness } from "@devintern/agent-harness";
import type { HarnessChainEntry } from "@devintern/agent-harness";

import { HarnessFailover } from "../src/lib/harness-failover";
import { WebhookQueue } from "../src/lib/webhook-queue";

/** Build a chain entry from a registered harness name. */
function entry(name: string): HarnessChainEntry {
  const harness = getHarness(name);
  if (!harness) {
    throw new Error(`Harness "${name}" is not registered`);
  }
  return { name: harness.name, harness, path: harness.defaultPath, installed: true };
}

/** Build a failover over the given chain with captured logs and persistence. */
function makeFailover(names: string[], now = () => 1000) {
  const lines: string[] = [];
  const limits: Record<string, number> = {};
  const cleared: string[] = [];
  const state = { active: null as string | null };
  const failover = new HarnessFailover({
    entries: names.map(entry),
    now,
    persistLimit: (harness, untilMs) => {
      limits[harness] = untilMs;
    },
    clearPersistedLimit: (harness) => {
      cleared.push(harness);
      delete limits[harness];
    },
    persistActive: (harness) => {
      state.active = harness;
    },
    log: (message) => lines.push(message),
  });
  return { failover, lines, limits, cleared, state };
}

describe("HarnessFailover", () => {
  test("single-entry chain is exhausted when the harness is limited", () => {
    const h = makeFailover(["claude-code"]);
    const outcome = h.failover.reportUsageLimit(2000);
    expect(outcome.kind).toBe("exhausted");
    expect(outcome.kind === "exhausted" && outcome.untilMs).toBe(2000);
    expect(h.limits["claude-code"]).toBe(2000);
  });

  test("fails over to the next entry when the primary is limited", () => {
    const h = makeFailover(["claude-code", "codex"]);
    const outcome = h.failover.reportUsageLimit(2000);
    expect(outcome).toEqual({
      kind: "switched",
      from: "claude-code",
      to: "codex",
      untilMs: 2000,
    });
    expect(h.failover.activeName).toBe("codex");
    expect(h.failover.onPrimary).toBe(false);
    expect(h.state.active).toBe("codex");
    expect(h.limits["claude-code"]).toBe(2000);
    expect(h.lines.join("\n")).toContain("failing over to codex");
  });

  test("advances again when the fallback also hits a limit mid-task", () => {
    const h = makeFailover(["claude-code", "codex", "grok"]);
    h.failover.reportUsageLimit(2000);
    const second = h.failover.reportUsageLimit(3000);
    expect(second).toEqual({ kind: "switched", from: "codex", to: "grok", untilMs: 3000 });
    expect(h.failover.activeName).toBe("grok");
    expect(h.limits["codex"]).toBe(3000);
  });

  test("exhausts when every entry is limited and reports the earliest reset", () => {
    const h = makeFailover(["claude-code", "codex"]);
    h.failover.reportUsageLimit(5000);
    const outcome = h.failover.reportUsageLimit(3000);
    expect(outcome.kind).toBe("exhausted");
    expect(outcome.kind === "exhausted" && outcome.untilMs).toBe(3000);
    expect(h.failover.earliestResetMs()).toBe(3000);
    expect(h.failover.allLimited()).toBe(true);
  });

  test("keeps the furthest reset when a window is extended", () => {
    const h = makeFailover(["claude-code"]);
    h.failover.reportUsageLimit(5000);
    h.failover.reportUsageLimit(3000);
    expect(h.failover.windows()["claude-code"]).toBe(5000);
    expect(h.limits["claude-code"]).toBe(5000);
  });

  test("fails back to the primary when its window elapses", () => {
    const h = makeFailover(["claude-code", "codex", "grok"]);
    h.failover.reportUsageLimit(5000); // claude limited → codex
    h.failover.reportUsageLimit(3000); // codex limited → grok
    expect(h.failover.activeName).toBe("grok");

    let now = 3500;
    const switched = h.failover.windowElapsed("codex");
    expect(switched).toBe("codex");
    expect(h.failover.activeName).toBe("codex");
    expect(h.cleared).toContain("codex");
    expect(h.lines.join("\n")).toContain("resuming on codex");

    now = 6000;
    const failback = h.failover.windowElapsed("claude-code");
    expect(failback).toBe("claude-code");
    expect(h.failover.activeName).toBe("claude-code");
    expect(h.failover.onPrimary).toBe(true);
    expect(h.lines.join("\n")).toContain("failing back to primary harness claude-code");
    void now;
  });

  test("windowElapsed is a no-op when no higher-priority harness unlocks", () => {
    const h = makeFailover(["claude-code", "codex"]);
    h.failover.reportUsageLimit(5000); // → codex, claude limited
    expect(h.failover.windowElapsed("grok")).toBeNull();
    expect(h.failover.activeName).toBe("codex");
  });

  test("persistence hooks receive every mutation", () => {
    const h = makeFailover(["claude-code", "codex"]);
    h.failover.reportUsageLimit(2000);
    h.failover.windowElapsed("claude-code");
    expect(h.limits["claude-code"]).toBeUndefined();
    expect(h.cleared).toContain("claude-code");
    expect(h.state.active).toBe("claude-code");
  });

  test("restore seeds windows and honors a persisted active harness", () => {
    const h = makeFailover(["claude-code", "codex"]);
    const warnings = h.failover.restore({ "claude-code": 5000 }, "codex");
    expect(warnings).toEqual([]);
    expect(h.failover.activeName).toBe("codex");
    expect(h.failover.isLimited("claude-code")).toBe(true);
    expect(h.failover.allLimited()).toBe(false);
  });

  test("restore warns and falls back when the persisted active left the chain", () => {
    const h = makeFailover(["claude-code", "codex"]);
    const warnings = h.failover.restore({}, "grok");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("grok");
    expect(h.failover.activeName).toBe("claude-code");
  });

  test("restore ignores windows for harnesses outside the chain", () => {
    const h = makeFailover(["claude-code", "codex"]);
    const warnings = h.failover.restore({ grok: 5000 }, null);
    expect(warnings).toHaveLength(1);
    expect(h.failover.isLimited("grok")).toBe(false);
    expect(h.failover.activeName).toBe("claude-code");
  });

  test("restore drops already-elapsed windows", () => {
    const h = makeFailover(["claude-code", "codex"]);
    const warnings = h.failover.restore({ "claude-code": 500 }, null);
    expect(warnings).toEqual([]);
    expect(h.failover.isLimited("claude-code")).toBe(false);
    expect(h.cleared).toContain("claude-code");
    expect(h.failover.activeName).toBe("claude-code");
  });

  test("restore parks on the primary when every entry is limited", () => {
    const h = makeFailover(["claude-code", "codex"]);
    h.failover.restore({ "claude-code": 5000, codex: 4000 }, null);
    expect(h.failover.allLimited()).toBe(true);
    expect(h.failover.earliestResetMs()).toBe(4000);
  });

  test("describeChain renders the priority order", () => {
    const h = makeFailover(["claude-code", "codex"]);
    expect(h.failover.describeChain()).toBe("claude-code → codex");
  });
});

describe("WebhookQueue failover persistence", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hf-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${dbPath}${suffix}`;
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }
  });

  test("active harness and windows survive a reopen", () => {
    const queue = new WebhookQueue({ dbPath });
    queue.setRateLimit("claude-code", 1234);
    queue.setRateLimit("codex", 5678);
    queue.setActiveHarness("codex");

    const reopened = new WebhookQueue({ dbPath });
    expect(reopened.getAllRateLimits()).toEqual({ "claude-code": 1234, codex: 5678 });
    expect(reopened.getActiveHarness()).toBe("codex");

    reopened.clearRateLimit("claude-code");
    expect(reopened.getAllRateLimits()).toEqual({ codex: 5678 });

    reopened.clearActiveHarness();
    expect(reopened.getActiveHarness()).toBeNull();
    reopened.close();
  });

  test("getAllRateLimits is empty when nothing is persisted", () => {
    const queue = new WebhookQueue({ dbPath });
    expect(queue.getAllRateLimits()).toEqual({});
    expect(queue.getActiveHarness()).toBeNull();
    queue.close();
  });

  test("a failover round-trip through the queue restores correctly", () => {
    const first = new WebhookQueue({ dbPath });
    const h = makeFailover(["claude-code", "codex"]);
    // Simulate the webhook server wiring failover persistence to the queue.
    const manager = new HarnessFailover({
      entries: ["claude-code", "codex"].map(entry),
      now: () => 1000,
      persistLimit: (harness, untilMs) => first.setRateLimit(harness, untilMs),
      clearPersistedLimit: (harness) => first.clearRateLimit(harness),
      persistActive: (harness) => first.setActiveHarness(harness),
      log: () => {},
    });
    void h;
    manager.reportUsageLimit(9000);
    first.close();

    const second = new WebhookQueue({ dbPath });
    const restored = new HarnessFailover({
      entries: ["claude-code", "codex"].map(entry),
      now: () => 2000,
      log: () => {},
    });
    restored.restore(second.getAllRateLimits(), second.getActiveHarness());
    expect(restored.activeName).toBe("codex");
    expect(restored.isLimited("claude-code")).toBe(true);
    second.close();
  });
});
