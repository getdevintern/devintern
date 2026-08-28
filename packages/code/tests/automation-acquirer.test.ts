import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AUTOMATION_ID_ENV,
  AUTOMATION_ORIGIN_ENV,
  AutomationAcquirer,
  MAX_TIMER_DELAY_MS,
  nextAutomationDue,
  spawnAutomationProcess,
  writeAutomationTaskFile,
} from "../src/lib/automation-acquirer";
import { AutomationStateStore } from "../src/lib/automation-state";
import type { AutomationConfig } from "../src/lib/automation-config";

describe("AutomationAcquirer", () => {
  const dbPaths: string[] = [];
  afterEach(() => {
    for (const path of dbPaths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("calculates future cron and interval due times", () => {
    const after = new Date("2026-08-21T12:34:00Z").getTime();
    const interval: AutomationConfig = {
      id: "i",
      enabled: true,
      prompt: "p",
      interval: "15m",
      intervalMs: 900_000,
    };
    const cron: AutomationConfig = {
      id: "c",
      enabled: true,
      prompt: "p",
      cron: "*/5 * * * *",
    };
    expect(nextAutomationDue(interval, after)).toBe(after + 900_000);
    expect(nextAutomationDue(cron, after)).toBeGreaterThan(after);
  });

  test.each([
    {
      label: "interval",
      now: 0,
      schedule: { interval: "30d", intervalMs: 30 * 86_400_000 },
    },
    {
      label: "cron",
      now: new Date(2026, 0, 2).getTime(),
      schedule: { cron: "0 0 1 1 *" },
    },
  ])("caps long $label timer delays to the runtime maximum", async ({ now, schedule }) => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    const delays: number[] = [];
    const setTimer = (_callback: () => void, delay: number) => {
      delays.push(delay);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    };
    const acquirer = new AutomationAcquirer({
      automations: [
        {
          id: `long-${schedule.cron ? "cron" : "interval"}`,
          enabled: true,
          prompt: "p",
          ...schedule,
        },
      ],
      dbPath,
      resolveContext: async () => null,
      now: () => now,
      setTimer,
      clearTimer: () => {},
    });

    await acquirer.start();
    expect(delays.at(-1)).toBe(MAX_TIMER_DELAY_MS);
    await acquirer.stop();
  });

  test("materializes the prompt as a markdown task file with attribution env", () => {
    const baseDir = join(tmpdir(), `acquirer-task-${Date.now()}-${Math.random()}`);
    const context = { cwd: baseDir, env: {}, repo: "api", release() {} };
    const filePath = writeAutomationTaskFile(
      {
        id: "dependency-health",
        enabled: true,
        prompt: "Inspect dependency health.\nApply one improvement.",
        interval: "1d",
        intervalMs: 86_400_000,
      },
      context,
    );

    expect(filePath).toContain(join(".devintern-code", "automations", "dependency-health"));
    expect(filePath.endsWith(".md")).toBe(true);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("# dependency-health");
    expect(content).toContain("Apply one improvement.");
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("writes task files into the project config dir when launched from a subfolder", () => {
    const project = join(tmpdir(), `acquirer-sub-${Date.now()}-${Math.random()}`);
    const subfolder = join(project, "packages", "app");
    mkdirSync(join(project, ".devintern-code"), { recursive: true });
    mkdirSync(subfolder, { recursive: true });

    const filePath = writeAutomationTaskFile(
      {
        id: "sub-folder",
        enabled: true,
        prompt: "work",
        interval: "1d",
        intervalMs: 86_400_000,
      },
      { cwd: subfolder, env: {}, release() {} },
    );

    expect(filePath.startsWith(join(project, ".devintern-code", "automations"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  test("falls back to the run cwd's config dir when no parent config exists", () => {
    const worktree = join(tmpdir(), `acquirer-fallback-${Date.now()}-${Math.random()}`);
    mkdirSync(worktree, { recursive: true });
    // A real worktree carries a .git entry; without it the config-dir lookup
    // would walk past tmpdir and bind to any ambient ancestor config
    // (e.g. /tmp/.devintern-code) instead of exercising the fallback.
    mkdirSync(join(worktree, ".git"), { recursive: true });

    const filePath = writeAutomationTaskFile(
      {
        id: "fallback",
        enabled: true,
        prompt: "work",
        interval: "1d",
        intervalMs: 86_400_000,
      },
      { cwd: worktree, env: {}, release() {} },
    );

    expect(filePath.startsWith(join(worktree, ".devintern-code", "automations"))).toBe(true);
    rmSync(worktree, { recursive: true, force: true });
  });

  test("honors an explicit task file directory from the run context", () => {
    const worktree = join(tmpdir(), `acquirer-explicit-${Date.now()}-${Math.random()}`);
    const workspaceHome = join(tmpdir(), `acquirer-home-${Date.now()}-${Math.random()}`);
    mkdirSync(worktree, { recursive: true });

    const filePath = writeAutomationTaskFile(
      {
        id: "explicit",
        enabled: true,
        prompt: "work",
        interval: "1d",
        intervalMs: 86_400_000,
      },
      { cwd: worktree, env: {}, taskFileDir: join(workspaceHome, "automations"), release() {} },
    );

    expect(filePath.startsWith(join(workspaceHome, "automations", "explicit"))).toBe(true);
    expect(existsSync(join(worktree, ".devintern-code"))).toBe(false);
    rmSync(worktree, { recursive: true, force: true });
    rmSync(workspaceHome, { recursive: true, force: true });
  });

  test("escalates to SIGKILL when an automation ignores SIGTERM", async () => {
    const run = spawnAutomationProcess(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { cwd: process.cwd(), env: process.env, terminationGraceMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    run.terminate();

    expect(await run.completion).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("completes cleanly when the spawned pipeline exits zero", async () => {
    const run = spawnAutomationProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: process.env,
    });

    expect(await run.completion).toBe(true);
  });

  test("disabled entries never receive schedule state", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    const automation: AutomationConfig = {
      id: "off",
      enabled: false,
      prompt: "p",
      interval: "1h",
      intervalMs: 3_600_000,
    };
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      resolveContext: async () => null,
      now: () => 100,
    });
    await acquirer.start();
    await acquirer.stop();
    const store = new AutomationStateStore(dbPath);
    expect(store.get("off")).toBeNull();
    store.close();
  });

  test("coalesces a missed occurrence to one run through the task pipeline", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let now = 0;
    let runs = 0;
    let resolveRun!: (ok: boolean) => void;
    const automation: AutomationConfig = {
      id: "due",
      enabled: true,
      prompt: "p",
      interval: "15m",
      intervalMs: 900_000,
    };
    const acquirer = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      now: () => now,
      resolveContext: async () => ({ cwd: "/tmp", env: {}, release() {} }),
      spawnRun: () => {
        runs += 1;
        return { completion: new Promise((resolve) => (resolveRun = resolve)), terminate() {} };
      },
    });
    await acquirer.start();
    now = 10_000_000;
    await acquirer.tick();
    expect(runs).toBe(1);
    await acquirer.tick();
    expect(runs).toBe(1);
    resolveRun(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await acquirer.stop();
  });

  test("heartbeats a claim while context resolution exceeds the lease", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let now = 0;
    let firstRuns = 0;
    let secondContexts = 0;
    // Injected heartbeat interval so beats fire on a manual clock — real
    // timers made this test flaky under CI load (a single delayed beat let
    // the 40ms lease expire and the second acquirer steal the claim).
    const heartbeatTimers: Array<{ callback: () => void }> = [];
    const timerHandles = {
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      setInterval: (callback: () => void) => {
        const timer = { callback };
        heartbeatTimers.push(timer);
        return timer as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (timer: ReturnType<typeof setInterval>) => {
        const index = heartbeatTimers.indexOf(timer as unknown as { callback: () => void });
        if (index >= 0) heartbeatTimers.splice(index, 1);
      },
    };
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => (releaseContext = resolve));
    const automation: AutomationConfig = {
      id: "slow-context",
      enabled: true,
      prompt: "p",
      interval: "10ms",
      intervalMs: 10,
    };
    const first = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      leaseMs: 40,
      heartbeatMs: 10,
      now: () => now,
      ...timerHandles,
      resolveContext: async () => {
        await contextGate;
        return { cwd: "/tmp", env: {}, release() {} };
      },
      spawnRun: () => {
        firstRuns += 1;
        return { completion: Promise.resolve(true), terminate() {} };
      },
    });
    const second = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      leaseMs: 40,
      heartbeatMs: 10,
      now: () => now,
      ...timerHandles,
      resolveContext: async () => {
        secondContexts += 1;
        return { cwd: "/tmp", env: {}, release() {} };
      },
      spawnRun: () => ({ completion: Promise.resolve(true), terminate() {} }),
    });

    await first.start();
    // Advance past the initial cursor and let the first occurrence claim.
    // Registration of the heartbeat interval happens synchronously before
    // resolveContext suspends on the gate, so it exists right after the call.
    now += 10;
    const claiming = first.tick();
    expect(heartbeatTimers).toHaveLength(1);

    // Advance past the original lease expiry (t=40), firing every scheduled
    // heartbeat. Each beat renews the lease to now + 40ms, so it never lapses.
    for (let beat = 0; beat < 5; beat++) {
      now += 10;
      for (const timer of [...heartbeatTimers]) timer.callback();
    }

    await second.start();
    expect(secondContexts).toBe(0);
    await second.stop();

    releaseContext();
    await claiming;
    expect(firstRuns).toBe(1);
    expect(heartbeatTimers).toHaveLength(0);
    await first.stop();
  });

  test("uses the actual claim time for later automations after slow preparation", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let now = 0;
    const finishRuns: Array<(ok: boolean) => void> = [];
    const automations: AutomationConfig[] = ["first", "second"].map((id) => ({
      id,
      enabled: true,
      prompt: "p",
      interval: "10ms",
      intervalMs: 10,
    }));
    const acquirer = new AutomationAcquirer({
      automations,
      dbPath,
      now: () => now,
      leaseMs: 40,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      resolveContext: async (automation) => {
        if (automation.id === "first") now = 100;
        return { cwd: "/tmp", env: {}, release() {} };
      },
      spawnRun: () => {
        let finish!: (ok: boolean) => void;
        const completion = new Promise<boolean>((resolve) => (finish = resolve));
        finishRuns.push(finish);
        return { completion, terminate: () => finish(false) };
      },
    });

    await acquirer.start();
    now = 10;
    await acquirer.tick();

    const store = new AutomationStateStore(dbPath);
    expect(store.get("second")?.heartbeatAt).toBe(100);
    expect(store.get("second")?.leaseExpiresAt).toBe(140);
    store.close();
    for (const finish of finishRuns) finish(true);
    await acquirer.stop();
  });

  test("terminates and cleans up an active run after lease ownership changes", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let now = 0;
    let finishFirst!: (ok: boolean) => void;
    let finishSecond!: (ok: boolean) => void;
    let terminated = false;
    let released = false;
    const automation: AutomationConfig = {
      id: "lost-lease",
      enabled: true,
      prompt: "p",
      interval: "10ms",
      intervalMs: 10,
    };
    const timerOptions = {
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    };
    const first = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      now: () => now,
      leaseMs: 40,
      ...timerOptions,
      resolveContext: async () => ({
        cwd: "/tmp",
        env: {},
        release: () => {
          released = true;
        },
      }),
      spawnRun: () => ({
        completion: new Promise((resolve) => (finishFirst = resolve)),
        terminate: () => {
          terminated = true;
          finishFirst(false);
        },
      }),
    });
    const second = new AutomationAcquirer({
      automations: [automation],
      dbPath,
      now: () => now,
      leaseMs: 40,
      ...timerOptions,
      resolveContext: async () => ({ cwd: "/tmp", env: {}, release() {} }),
      spawnRun: () => ({
        completion: new Promise((resolve) => (finishSecond = resolve)),
        terminate: () => finishSecond(false),
      }),
    });

    await first.start();
    now = 10;
    await first.tick();
    now = 100;
    await second.start();
    await first.tick();

    expect(terminated).toBe(true);
    expect(released).toBe(true);
    await first.stop();
    await second.stop();
  });

  test("stop waits for active run cleanup before closing state", async () => {
    const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let now = 0;
    let resolveRun!: (ok: boolean) => void;
    let finishRelease!: () => void;
    let releaseStarted = false;
    let stopFinished = false;
    const acquirer = new AutomationAcquirer({
      automations: [
        {
          id: "shutdown",
          enabled: true,
          prompt: "p",
          interval: "1m",
          intervalMs: 60_000,
        },
      ],
      dbPath,
      now: () => now,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      resolveContext: async () => ({
        cwd: "/tmp",
        env: {},
        release: async () => {
          releaseStarted = true;
          await new Promise<void>((resolve) => (finishRelease = resolve));
        },
      }),
      spawnRun: () => ({
        completion: new Promise((resolve) => (resolveRun = resolve)),
        terminate: () => resolveRun(false),
      }),
    });
    await acquirer.start();
    now = 60_000;
    await acquirer.tick();

    const stopping = acquirer.stop().then(() => {
      stopFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseStarted).toBe(true);
    expect(stopFinished).toBe(false);
    finishRelease();
    await stopping;
    expect(stopFinished).toBe(true);
  });

  test("exports the scheduled-run attribution env marker names", () => {
    expect(AUTOMATION_ORIGIN_ENV).toBe("DEVINTERN_RUN_ORIGIN");
    expect(AUTOMATION_ID_ENV).toBe("DEVINTERN_AUTOMATION_ID");
  });

  describe("applyAutomations (live config reload)", () => {
    const newDb = () => {
      const dbPath = join(tmpdir(), `acquirer-${Date.now()}-${Math.random()}.db`);
      dbPaths.push(dbPath);
      return dbPath;
    };

    test("schedules an automation added at runtime", async () => {
      const dbPath = newDb();
      let now = 0;
      const acquirer = new AutomationAcquirer({
        automations: [],
        dbPath,
        now: () => now,
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {},
        resolveContext: async () => null,
      });
      await acquirer.start();
      const added: AutomationConfig = {
        id: "added",
        enabled: true,
        prompt: "p",
        interval: "15m",
        intervalMs: 900_000,
      };
      acquirer.applyAutomations([added]);

      const store = new AutomationStateStore(dbPath);
      expect(store.get("added")?.nextDueAt).toBe(900_000);
      store.close();
      await acquirer.stop();
    });

    test("drops schedule state for a fully removed automation and forgets its timer", async () => {
      const dbPath = newDb();
      let now = 0;
      let timerCleared = false;
      const automation: AutomationConfig = {
        id: "retired",
        enabled: true,
        prompt: "p",
        interval: "1h",
        intervalMs: 3_600_000,
      };
      const acquirer = new AutomationAcquirer({
        automations: [automation],
        dbPath,
        now: () => now,
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {
          timerCleared = true;
        },
        resolveContext: async () => null,
      });
      await acquirer.start();

      acquirer.applyAutomations([]);
      const store = new AutomationStateStore(dbPath);
      expect(store.get("retired")).toBeNull();
      store.close();
      expect(timerCleared).toBe(true);
      await acquirer.stop();
    });

    test("lets an active run of a removed automation finish before dropping state", async () => {
      const dbPath = newDb();
      let now = 0;
      let resolveRun!: (ok: boolean) => void;
      const automation: AutomationConfig = {
        id: "in-flight",
        enabled: true,
        prompt: "p",
        interval: "10ms",
        intervalMs: 10,
      };
      const acquirer = new AutomationAcquirer({
        automations: [automation],
        dbPath,
        now: () => now,
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {},
        resolveContext: async () => ({ cwd: "/tmp", env: {}, release() {} }),
        spawnRun: () => ({
          completion: new Promise((resolve) => (resolveRun = resolve)),
          terminate() {},
        }),
      });
      await acquirer.start();
      now = 100;
      await acquirer.tick();

      // Removed from the config mid-run: the occurrence finishes naturally.
      acquirer.applyAutomations([]);
      const storeWhileRunning = new AutomationStateStore(dbPath);
      expect(storeWhileRunning.get("in-flight")).not.toBeNull();
      storeWhileRunning.close();

      resolveRun(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const storeAfterFinish = new AutomationStateStore(dbPath);
      expect(storeAfterFinish.get("in-flight")).toBeNull();
      storeAfterFinish.close();
      await acquirer.stop();
    });

    test("resets the cursor when the schedule spec changes; keeps it when unchanged", async () => {
      const dbPath = newDb();
      const fixedNow = 50_000;
      const hourly: AutomationConfig = {
        id: "resched",
        enabled: true,
        prompt: "p",
        interval: "1h",
        intervalMs: 3_600_000,
      };
      const halfHourly: AutomationConfig = { ...hourly, interval: "30m", intervalMs: 1_800_000 };
      const acquirer = new AutomationAcquirer({
        automations: [hourly],
        dbPath,
        now: () => fixedNow,
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {},
        resolveContext: async () => null,
      });
      await acquirer.start();

      const store = new AutomationStateStore(dbPath);
      const anchoredAt = store.get("resched")?.nextDueAt;
      expect(anchoredAt).toBe(fixedNow + 3_600_000);

      // Unchanged spec (same definition object shape) keeps the anchor.
      acquirer.applyAutomations([hourly]);
      expect(store.get("resched")?.nextDueAt).toBe(anchoredAt);

      // Changed spec resets the interval anchor.
      acquirer.applyAutomations([halfHourly]);
      expect(store.get("resched")?.nextDueAt).toBe(fixedNow + 1_800_000);
      store.close();
      await acquirer.stop();
    });
  });
});
