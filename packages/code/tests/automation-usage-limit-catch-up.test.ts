import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AutomationAcquirer,
  automationDeferralMessage,
  catchUpJitterMs,
  nextAutomationDue,
  spawnAutomationProcess,
} from "../src/lib/automation/acquirer";
import type { SpawnedAutomationRun } from "../src/lib/automation/acquirer";
import { parseAutomationEntries } from "../src/lib/automation/config";
import type { AutomationConfig } from "../src/lib/automation/config";
import { AutomationStateStore } from "../src/lib/automation/state";
import { resetWorkerFailover, startWorkerFailover } from "../src/lib/worker/failover";
import { USAGE_LIMIT_FILE_ENV, WORKER_CHILD_ENV } from "../src/lib/worker/usage-limit-protocol";

const HOUR = 3_600_000;

describe("usage-limit catch-up", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    resetWorkerFailover();
    for (const path of cleanup.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  function dbPath(): string {
    const path = join(tmpdir(), `acq-catch-up-${Date.now()}-${Math.random()}.db`);
    cleanup.push(path);
    return path;
  }

  // Mon/Wed/Fri at 18:00, host timezone (as the scheduler evaluates cron).
  const onboarding = (extra: Partial<AutomationConfig> = {}): AutomationConfig => ({
    id: "onboarding-improvements",
    enabled: true,
    prompt: "p",
    cron: "0 18 * * 1,3,5",
    ...extra,
  });
  const hourly = (extra: Partial<AutomationConfig> = {}): AutomationConfig => ({
    id: "hourly",
    enabled: true,
    prompt: "p",
    interval: "1h",
    intervalMs: HOUR,
    ...extra,
  });

  function build(options: {
    automation: AutomationConfig;
    path: string;
    now: { value: number };
    blockedUntil: { value: number | null };
    run?: () => SpawnedAutomationRun;
  }) {
    let spawned = 0;
    const run = options.run ?? (() => ({ completion: Promise.resolve(true), terminate: () => {} }));
    const acquirer = new AutomationAcquirer({
      automations: [options.automation],
      dbPath: options.path,
      now: () => options.now.value,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      harnessBlockedUntil: () => options.blockedUntil.value,
      resolveContext: async () => ({ cwd: tmpdir(), env: {}, release: () => {} }),
      spawnRun: () => {
        spawned++;
        return run();
      },
      spawnManualRun: () => {
        spawned++;
        return run();
      },
    });
    return { acquirer, spawned: () => spawned };
  }

  function nextDue(path: string, id: string) {
    const store = new AutomationStateStore(path);
    try {
      return store.get(id);
    } finally {
      store.close();
    }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("jitter is a few minutes and stable per job", () => {
    const jitter = catchUpJitterMs("onboarding-improvements");
    expect(jitter).toBeGreaterThanOrEqual(60_000);
    expect(jitter).toBeLessThanOrEqual(5 * 60_000);
    expect(catchUpJitterMs("onboarding-improvements")).toBe(jitter);
  });

  test("a blocked occurrence catches up shortly after a reset that comes before the next cron", async () => {
    const path = dbPath();
    const automation = onboarding();
    // Monday 2026-11-30 18:00 local is due; the limit resets at 20:00.
    const due = new Date(2026, 10, 30, 18, 0).getTime();
    const reset = new Date(2026, 10, 30, 20, 0).getTime();
    const now = { value: due - 60_000 };
    const blockedUntil = { value: reset as number | null };
    const { acquirer, spawned } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await acquirer.start();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(due);
      now.value = due;
      await acquirer.tick();
      expect(spawned()).toBe(0);
      const state = nextDue(path, automation.id);
      expect(state?.nextDueAt).toBe(reset + catchUpJitterMs(automation.id));
      expect(state?.deferredUntil).toBe(reset);
      expect(warn.mock.calls.flat().join("\n")).toContain("occurrence deferred");
      expect(warn.mock.calls.flat().join("\n")).toContain("catching up at");
      expect(acquirer.listSchedules()[0]?.deferral).toEqual({ until: reset });

      // The reset passed: the catch-up runs once and clears the deferral.
      blockedUntil.value = null;
      now.value = reset + catchUpJitterMs(automation.id);
      await acquirer.tick();
      expect(spawned()).toBe(1);
      await settle();
      const after = nextDue(path, automation.id);
      expect(after?.deferredUntil).toBeUndefined();
      // Back on the cron: Wednesday 18:00.
      expect(after?.nextDueAt).toBe(new Date(2026, 11, 2, 18, 0).getTime());
    } finally {
      warn.mockRestore();
      await acquirer.stop();
    }
  });

  test("a reset after the next cron occurrence keeps the cron occurrence", async () => {
    const path = dbPath();
    const automation = onboarding();
    const due = new Date(2026, 10, 30, 18, 0).getTime();
    const now = { value: due - 60_000 };
    const blockedUntil = { value: new Date(2026, 11, 3, 9, 0).getTime() as number | null };
    const { acquirer } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = due;
      await acquirer.tick();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(nextAutomationDue(automation, due));
      expect(warn.mock.calls.flat().join("\n")).toContain("occurrence skipped");
      expect(acquirer.listSchedules()[0]?.deferral?.until).toBe(blockedUntil.value as number);
      // Past the reset the deferral is stale and no longer shown.
      now.value = (blockedUntil.value as number) + 1;
      expect(acquirer.listSchedules()[0]?.deferral).toBeUndefined();
    } finally {
      warn.mockRestore();
      await acquirer.stop();
    }
  });

  test("several occurrences missed while blocked collapse into one catch-up run", async () => {
    const path = dbPath();
    const automation = hourly();
    const reset = 3.5 * HOUR;
    const now = { value: 0 };
    const blockedUntil = { value: reset as number | null };
    const { acquirer, spawned } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await acquirer.start();
      for (const at of [HOUR, 2 * HOUR, 3 * HOUR]) {
        now.value = at;
        await acquirer.tick();
      }
      expect(spawned()).toBe(0);
      const catchUpAt = reset + catchUpJitterMs(automation.id);
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(catchUpAt);

      blockedUntil.value = null;
      now.value = catchUpAt;
      await acquirer.tick();
      await settle();
      expect(spawned()).toBe(1);
      // No second run for the other missed occurrences.
      now.value = catchUpAt + HOUR - 1;
      await acquirer.tick();
      expect(spawned()).toBe(1);
    } finally {
      warn.mockRestore();
      await acquirer.stop();
    }
  });

  test("a manual run after the reset replaces the queued catch-up", async () => {
    const path = dbPath();
    const automation = hourly({ interval: "4h", intervalMs: 4 * HOUR });
    const now = { value: 0 };
    const blockedUntil = { value: (4 * HOUR) as number | null };
    const { acquirer, spawned } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = 4 * HOUR;
      await acquirer.tick();
      const catchUpAt = 4 * HOUR + catchUpJitterMs(automation.id);
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(catchUpAt);

      // Run now before the catch-up fires: it stands in for the catch-up.
      blockedUntil.value = null;
      now.value = 4 * HOUR + 1;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      expect(spawned()).toBe(1);
      const state = nextDue(path, automation.id);
      expect(state?.deferredUntil).toBeUndefined();
      expect(state?.nextDueAt).toBe(nextAutomationDue(automation, 4 * HOUR + 1));

      now.value = catchUpAt;
      await acquirer.tick();
      await settle();
      expect(spawned()).toBe(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      await acquirer.stop();
    }
  });

  test("a manual run without a pending deferral keeps the schedule cursor", async () => {
    const path = dbPath();
    const automation = hourly();
    const now = { value: 0 };
    const { acquirer } = build({ automation, path, now, blockedUntil: { value: null } });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = 0.25 * HOUR;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(HOUR);
    } finally {
      log.mockRestore();
      await acquirer.stop();
    }
  });

  test("a manual run after a skip-policy deferral keeps the scheduled cursor", async () => {
    const path = dbPath();
    const automation = hourly({ onUsageLimit: "skip" });
    const now = { value: 0 };
    const blockedUntil = { value: (1.5 * HOUR) as number | null };
    const { acquirer } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = HOUR;
      await acquirer.tick();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(2 * HOUR);

      blockedUntil.value = null;
      now.value = 1.75 * HOUR;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      const state = nextDue(path, automation.id);
      expect(state?.deferredUntil).toBeUndefined();
      expect(state?.nextDueAt).toBe(2 * HOUR);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      await acquirer.stop();
    }
  });

  test("a manual run after a no-catch-up deferral keeps the scheduled cursor", async () => {
    const path = dbPath();
    const automation = hourly();
    const now = { value: 0 };
    // The reset lands after the next occurrence, so no catch-up is queued.
    const blockedUntil = { value: (2.5 * HOUR) as number | null };
    const { acquirer } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = HOUR;
      await acquirer.tick();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(2 * HOUR);

      blockedUntil.value = null;
      now.value = 1.75 * HOUR;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(2 * HOUR);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      await acquirer.stop();
    }
  });

  test("a manual run after a stale manual-run deferral keeps the scheduled cursor", async () => {
    const path = dbPath();
    const automation = hourly();
    const now = { value: 0 };
    let deferNext = true;
    const { acquirer, spawned } = build({
      automation,
      path,
      now,
      blockedUntil: { value: null },
      run: () => {
        const deferred = deferNext;
        deferNext = false;
        return {
          completion: Promise.resolve(!deferred),
          terminate: () => {},
          deferral: () => (deferred ? { untilMs: 0.5 * HOUR, harness: "codex" } : undefined),
        };
      },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = 60_000;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      expect(nextDue(path, automation.id)?.deferredUntil).toBe(0.5 * HOUR);

      now.value = 0.75 * HOUR;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      expect(spawned()).toBe(2);
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(HOUR);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      await acquirer.stop();
    }
  });

  test('on_usage_limit = "skip" keeps the next scheduled occurrence', async () => {
    const path = dbPath();
    const automation = onboarding({ onUsageLimit: "skip" });
    const due = new Date(2026, 10, 30, 18, 0).getTime();
    const now = { value: due - 60_000 };
    const blockedUntil = { value: new Date(2026, 10, 30, 20, 0).getTime() as number | null };
    const { acquirer } = build({ automation, path, now, blockedUntil });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = due;
      await acquirer.tick();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(nextAutomationDue(automation, due));
      expect(warn.mock.calls.flat().join("\n")).toContain("occurrence skipped");
      expect(acquirer.listSchedules()[0]?.deferral?.until).toBe(blockedUntil.value as number);
      // Past the reset the deferral is stale and no longer shown.
      now.value = (blockedUntil.value as number) + 1;
      expect(acquirer.listSchedules()[0]?.deferral).toBeUndefined();
    } finally {
      warn.mockRestore();
      await acquirer.stop();
    }
  });

  test("a scheduled run that ends deferred logs the deferral and schedules a catch-up", async () => {
    const path = dbPath();
    const automation = hourly({ harness: "claude-code" });
    const reset = 1.5 * HOUR;
    const now = { value: 0 };
    const blockedUntil = { value: null as number | null };
    const { acquirer, spawned } = build({
      automation,
      path,
      now,
      blockedUntil,
      run: () => ({
        completion: Promise.resolve(false),
        terminate: () => {},
        deferral: () => ({ untilMs: reset, harness: "claude-code" }),
      }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = HOUR;
      await acquirer.tick();
      await settle();
      expect(spawned()).toBe(1);
      const output = [...warn.mock.calls, ...log.mock.calls].flat().join("\n");
      expect(output).toContain(
        `⏳ [automation:hourly] deferred: claude-code usage limit until ${new Date(reset).toISOString()}; catching up then`,
      );
      expect(output).not.toContain("did not complete cleanly");
      const catchUpAt = reset + catchUpJitterMs(automation.id);
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(catchUpAt);
      expect(acquirer.listSchedules()[0]?.deferral).toEqual({
        until: reset,
        harness: "claude-code",
      });
    } finally {
      warn.mockRestore();
      log.mockRestore();
      await acquirer.stop();
    }

    // A worker restart keeps the catch-up time and runs it once due.
    const restarted = build({ automation, path, now: { value: HOUR + 60_000 }, blockedUntil });
    try {
      await restarted.acquirer.start();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(reset + catchUpJitterMs(automation.id));
      expect(restarted.spawned()).toBe(0);
    } finally {
      await restarted.acquirer.stop();
    }
  });

  test('a deferred run with on_usage_limit = "skip" waits for the next occurrence', async () => {
    const path = dbPath();
    const automation = hourly({ onUsageLimit: "skip" });
    const now = { value: 0 };
    const { acquirer } = build({
      automation,
      path,
      now,
      blockedUntil: { value: null },
      run: () => ({
        completion: Promise.resolve(false),
        terminate: () => {},
        deferral: () => ({ untilMs: 1.5 * HOUR, harness: "codex" }),
      }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = HOUR;
      await acquirer.tick();
      await settle();
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(2 * HOUR);
      expect(warn.mock.calls.flat().join("\n")).toContain(
        `; next occurrence ${new Date(2 * HOUR).toISOString()}`,
      );
    } finally {
      warn.mockRestore();
      await acquirer.stop();
    }
  });

  test("a manual run that ends deferred reports it and is not re-queued", async () => {
    const path = dbPath();
    const automation = hourly();
    const now = { value: 0 };
    const { acquirer, spawned } = build({
      automation,
      path,
      now,
      blockedUntil: { value: null },
      run: () => ({
        completion: Promise.resolve(false),
        terminate: () => {},
        deferral: () => ({ untilMs: 0.5 * HOUR, harness: "codex" }),
      }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquirer.start();
      now.value = 60_000;
      expect(await acquirer.triggerManual(automation.id)).toEqual({ ok: true });
      await settle();
      expect(spawned()).toBe(1);
      const output = [...warn.mock.calls, ...log.mock.calls].flat().join("\n");
      expect(output).toContain("[automation:hourly] manual run deferred: codex usage limit until");
      expect(output).not.toContain("did not complete cleanly");
      expect(nextDue(path, automation.id)?.nextDueAt).toBe(HOUR);
      expect(acquirer.listSchedules()[0]?.deferral?.until).toBe(0.5 * HOUR);
      // The run is not re-queued, so nothing clears the row: once the reset
      // passes the deferral stops showing.
      now.value = 0.5 * HOUR;
      expect(acquirer.listSchedules()[0]?.deferral).toBeUndefined();
    } finally {
      warn.mockRestore();
      log.mockRestore();
      await acquirer.stop();
    }
  });

  test("deferral message wording", () => {
    const deferral = { untilMs: Date.UTC(2026, 10, 28, 20), harness: "claude-code" };
    expect(automationDeferralMessage("automation:x", deferral, { catchUp: true })).toBe(
      "⏳ [automation:x] deferred: claude-code usage limit until 2026-11-28T20:00:00.000Z; catching up then",
    );
    expect(
      automationDeferralMessage("automation:x", deferral, {
        catchUp: false,
        nextDueAt: Date.UTC(2026, 10, 30, 18),
      }),
    ).toBe(
      "⏳ [automation:x] deferred: claude-code usage limit until 2026-11-28T20:00:00.000Z; next occurrence 2026-11-30T18:00:00.000Z",
    );
  });

  test("spawnAutomationProcess reports a pinned exit-75 run as deferred", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acq-catch-up-probe-"));
    try {
      const probe = join(dir, "probe.cjs");
      writeFileSync(
        probe,
        `const fs = require("node:fs");
const hint = process.env[${JSON.stringify(USAGE_LIMIT_FILE_ENV)}];
if (hint) fs.writeFileSync(hint, process.env.PROBE_HINT);
process.exit(75);
`,
      );
      await startWorkerFailover({ raw: "codex", checkInstalled: false, log: () => {} });
      const untilMs = Date.now() + 2 * HOUR;
      const env: Record<string, string | undefined> = {
        ...process.env,
        PROBE_HINT: JSON.stringify({ untilMs }),
      };
      delete env[WORKER_CHILD_ENV];
      delete env[USAGE_LIMIT_FILE_ENV];
      const run = spawnAutomationProcess(process.execPath, [probe], {
        cwd: dir,
        env,
        harnessPin: "claude-code",
      });
      expect(await run.completion).toBe(false);
      expect(run.deferral?.()).toEqual({ untilMs, harness: "claude-code" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plain failure is not a deferral", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acq-catch-up-fail-"));
    try {
      const probe = join(dir, "probe.cjs");
      writeFileSync(probe, "process.exit(1);\n");
      const run = spawnAutomationProcess(process.execPath, [probe], {
        cwd: dir,
        env: { ...process.env },
      });
      expect(await run.completion).toBe(false);
      expect(run.deferral?.()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("on_usage_limit config", () => {
  const base = { id: "a", enabled: true, prompt: "p", interval: "1h" };

  test("defaults to catch-up and accepts both values", () => {
    expect(parseAutomationEntries([base], { sourceLabel: "t" }).automations[0]?.onUsageLimit).toBe(
      undefined,
    );
    for (const value of ["catch_up", "skip"] as const) {
      const result = parseAutomationEntries([{ ...base, on_usage_limit: value }], {
        sourceLabel: "t",
      });
      expect(result.errors).toEqual([]);
      expect(result.automations[0]?.onUsageLimit).toBe(value);
    }
  });

  test("rejects unknown values with a clear message", () => {
    const result = parseAutomationEntries([{ ...base, on_usage_limit: "retry" }], {
      sourceLabel: "t",
    });
    expect(result.errors).toEqual([
      '[[automations]][0].on_usage_limit must be one of "catch_up", "skip"; got "retry".',
    ]);
  });
});
