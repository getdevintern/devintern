import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskSupervisor, JobNotStartedError } from "../src/lib/task-supervisor";
import type { TaskSupervisor } from "../src/lib/task-supervisor";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { WorkspaceConfig } from "../src/lib/workspace/config";
import {
  createIdleWorkerAutoUpdater,
  runningUnderServiceManager,
  spawnWorkerSuccessor,
  WORKER_AUTO_UPDATE_TICK_MS,
} from "../src/lib/workspace/worker-auto-update";
import type { IdleAutoUpdaterOptions } from "../src/lib/workspace/worker-auto-update";

const GLOBAL_ARGV = [
  "bun",
  "/usr/local/lib/node_modules/@getdevintern/code/dist/index.js",
  "worker",
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-auto-update-"));
  tempDirs.push(dir);
  return dir;
}

function stubFetch(version: string | Error): typeof fetch {
  return (async () => {
    if (version instanceof Error) throw version;
    return new Response(JSON.stringify({ version }), { status: 200 });
  }) as unknown as typeof fetch;
}

function configWith(workerOverrides: Record<string, unknown> = {}): WorkspaceConfig {
  const lines: string[] = [
    '[defaults]\ntracker = "markdown"\ntask_query = "status=todo"',
    '[[repos]]\nname = "backend"\nremote = "git@github.com:acme/backend.git"',
    '[[routing.rules]]\nrepo = "backend"\nlabels = ["backend"]',
  ];
  if (Object.keys(workerOverrides).length > 0) {
    lines.push(
      `[worker]\n${Object.entries(workerOverrides)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n")}`,
    );
  }
  return parseWorkspaceConfig(lines.join("\n\n"));
}

function optionsWith(
  overrides: Partial<IdleAutoUpdaterOptions> & { config: WorkspaceConfig },
): IdleAutoUpdaterOptions {
  return {
    supervisor: createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 }),
    cliVersion: "2.10.0",
    requestShutdown: () => undefined,
    argv: GLOBAL_ARGV,
    env: {},
    isDue: () => true,
    runCheck: async () => "skipped",
    underServiceManager: () => true,
    log: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}

function scheduleJob(supervisor: TaskSupervisor, id: string, gate: Promise<void>): Promise<void> {
  return supervisor.schedule({
    id,
    source: "test",
    repo: "backend",
    kind: "task",
    checkoutClass: "task_worktree",
    run: async () => {
      await gate;
    },
  });
}

describe("createIdleWorkerAutoUpdater", () => {
  test("skips silently when a check is not due", async () => {
    let checks = 0;
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        isDue: () => false,
        runCheck: async () => {
          checks++;
          return "skipped";
        },
      }),
    );
    await updater.tick();
    await updater.tick();
    expect(checks).toBe(0);
    expect(updater.isRestartPending()).toBe(false);
    expect(updater.finalExitCode()).toBeUndefined();
  });

  test("skips when [worker] auto_update is false, and resumes when re-enabled", async () => {
    const config = configWith({ auto_update: false });
    let checks = 0;
    const logs: string[] = [];
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config,
        runCheck: async () => {
          checks++;
          return "skipped";
        },
        log: (message) => logs.push(message),
      }),
    );
    await updater.tick();
    await updater.tick();
    expect(checks).toBe(0);
    expect(logs.filter((line) => line.includes("auto_update = false")).length).toBe(1);

    config.worker.autoUpdate = true;
    await updater.tick();
    expect(checks).toBe(1);
  });

  test("skips when DEVINTERN_NO_UPDATE is set", async () => {
    let checks = 0;
    const logs: string[] = [];
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        env: { DEVINTERN_NO_UPDATE: "1" },
        runCheck: async () => {
          checks++;
          return "skipped";
        },
        log: (message) => logs.push(message),
      }),
    );
    await updater.tick();
    expect(checks).toBe(0);
    expect(logs.filter((line) => line.includes("DEVINTERN_NO_UPDATE")).length).toBe(1);
  });

  test("skips non-global installs", async () => {
    let checks = 0;
    const logs: string[] = [];
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        argv: ["bun", "/repo/packages/code/src/index.ts", "worker"],
        runCheck: async () => {
          checks++;
          return "skipped";
        },
        log: (message) => logs.push(message),
      }),
    );
    await updater.tick();
    expect(checks).toBe(0);
    expect(logs.filter((line) => line.includes("not a global npm/bun install")).length).toBe(1);
  });

  test("skips dev versions without a check", async () => {
    let checks = 0;
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        cliVersion: "0.0.0",
        runCheck: async () => {
          checks++;
          return "skipped";
        },
      }),
    );
    await updater.tick();
    expect(checks).toBe(0);
  });

  test("defers the due check while agent jobs are in flight, then runs it once idle", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 });
    let checks = 0;
    const logs: string[] = [];
    let clock = 1_000;
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        supervisor,
        now: () => clock,
        runCheck: async () => {
          checks++;
          return "skipped";
        },
        log: (message) => logs.push(message),
      }),
    );

    let release!: () => void;
    // oxlint-disable-next-line promise/avoid-new -- controlled gate for the busy job.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // oxlint-disable-next-line promise/prefer-await-to-then -- the job rejects only if the test tears down early.
    const job = scheduleJob(supervisor, "job", gate).catch(() => undefined);
    await Promise.resolve();
    expect(supervisor.inFlightCount()).toBe(1);

    await updater.tick();
    // An immediate second tick stays inside the rate-limit window.
    await updater.tick();
    expect(checks).toBe(0);
    expect(logs.filter((line) => line.includes("waiting for idle")).length).toBe(1);

    // An hour later the notice may repeat, but still no check.
    clock += 60 * 60 * 1000;
    await updater.tick();
    expect(checks).toBe(0);
    expect(logs.filter((line) => line.includes("waiting for idle")).length).toBe(2);

    release();
    await job;
    await updater.tick();
    expect(checks).toBe(1);
  });

  test("holds admissions during the attempt and resumes after a skip", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 });
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        supervisor,
        runCheck: async () => {
          // While the check runs, no new work may start.
          let rejected = false;
          try {
            await supervisor.schedule({
              id: "late",
              source: "test",
              repo: "backend",
              kind: "task",
              checkoutClass: "task_worktree",
              run: async () => true,
            });
          } catch (error) {
            rejected = error instanceof JobNotStartedError;
          }
          expect(rejected).toBe(true);
          return "skipped";
        },
      }),
    );

    await updater.tick();

    // The hold is released after a skip: work is admitted again.
    const result = await supervisor.schedule({
      id: "after",
      source: "test",
      repo: "backend",
      kind: "task",
      checkoutClass: "task_worktree",
      run: async () => "ran",
    });
    expect(result).toBe("ran");
  });

  test("a mid-check opt-out flips the install into a skip", async () => {
    const config = configWith();
    const cachePath = join(tempDir(), "update-check.json");
    let installs = 0;
    const logs: string[] = [];
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config,
        cachePath,
        checkIntervalMs: 60_000,
        runCheck: undefined,
        now: () => 1_000,
        fetchFn: stubFetch("9.9.9"),
        installFn: async () => {
          installs++;
          return true;
        },
        log: (message) => logs.push(message),
      }),
    );

    // Simulate the opt-out landing while the check is in flight (between the
    // registry fetch and the install).
    const tick = updater.tick();
    config.worker.autoUpdate = false;
    await tick;

    expect(installs).toBe(0);
    expect(updater.isRestartPending()).toBe(false);
    expect(logs.some((line) => line.includes("disabled while the check ran"))).toBe(true);
  });

  test("installs a fetched update through the default check and requests handover", async () => {
    const config = configWith();
    const cachePath = join(tempDir(), "update-check.json");
    const installed: Array<{ manager: string; version: string }> = [];
    let shutdowns = 0;
    const logs: string[] = [];
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config,
        cachePath,
        checkIntervalMs: 60_000,
        runCheck: undefined,
        now: () => 1_000,
        fetchFn: stubFetch("9.9.9"),
        installFn: async ({ packageManager, version }) => {
          installed.push({ manager: packageManager, version });
          return true;
        },
        requestShutdown: () => {
          shutdowns++;
        },
        log: (message) => logs.push(message),
      }),
    );

    await updater.tick();

    expect(installed).toEqual([{ manager: "npm", version: "9.9.9" }]);
    expect(shutdowns).toBe(1);
    expect(updater.isRestartPending()).toBe(true);
    expect(logs.some((line) => line.includes("checking npm"))).toBe(true);
  });

  test("a successful install keeps the hold so no work starts before the handover", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 });
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        supervisor,
        runCheck: async () => "updated",
      }),
    );
    await updater.tick();
    expect(updater.isRestartPending()).toBe(true);

    let rejected = false;
    try {
      await supervisor.schedule({
        id: "during-restart",
        source: "test",
        repo: "backend",
        kind: "task",
        checkoutClass: "task_worktree",
        run: async () => true,
      });
    } catch (error) {
      rejected = error instanceof JobNotStartedError;
    }
    expect(rejected).toBe(true);
  });

  test("a failed install backs off for the daily check interval", async () => {
    const config = configWith();
    const cachePath = join(tempDir(), "update-check.json");
    let fetches = 0;
    let installs = 0;
    let clock = 1_000;
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config,
        cachePath,
        checkIntervalMs: 60_000,
        runCheck: undefined,
        isDue: undefined,
        now: () => clock,
        fetchFn: (() => {
          fetches++;
          return Promise.resolve(
            new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
          );
        }) as unknown as typeof fetch,
        installFn: async () => {
          installs++;
          return false;
        },
      }),
    );

    await updater.tick();
    expect(fetches).toBe(1);
    expect(installs).toBe(1);

    // Within the interval: no retries despite the cached newer version.
    clock += 30_000;
    await updater.tick();
    await updater.tick();
    expect(fetches).toBe(1);

    // After the interval: one retry.
    clock += 31_000;
    await updater.tick();
    expect(fetches).toBe(2);
    expect(installs).toBe(2);
  });

  test("a cached newer version from a previous busy window installs on the first idle tick", async () => {
    const config = configWith();
    const cachePath = join(tempDir(), "update-check.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        "@getdevintern/code": { checkedAt: 1_000, latestVersion: "9.9.9" },
      }),
    );
    let installs = 0;
    let shutdowns = 0;
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config,
        cachePath,
        checkIntervalMs: 60_000,
        runCheck: undefined,
        now: () => 31_000,
        fetchFn: stubFetch(new Error("must not fetch while the cache holds a newer version")),
        installFn: async () => {
          installs++;
          return true;
        },
        requestShutdown: () => {
          shutdowns++;
        },
      }),
    );

    await updater.tick();
    expect(installs).toBe(1);
    expect(shutdowns).toBe(1);
  });

  test("finalExitCode asks the service manager to restart with a non-zero status", async () => {
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        runCheck: async () => "updated",
        underServiceManager: () => true,
      }),
    );
    expect(updater.finalExitCode()).toBeUndefined();
    await updater.tick();
    expect(updater.finalExitCode()).toBe(1);
  });

  test("finalExitCode spawns a successor when no service manager is involved", async () => {
    let spawned = 0;
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        runCheck: async () => "updated",
        underServiceManager: () => false,
        spawnSuccessor: () => {
          spawned++;
          return true;
        },
      }),
    );
    await updater.tick();
    expect(updater.finalExitCode()).toBe(0);
    expect(spawned).toBe(1);
  });

  test("finalExitCode falls back to the restart-requested status when the spawn fails", async () => {
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        runCheck: async () => "updated",
        underServiceManager: () => false,
        spawnSuccessor: () => false,
      }),
    );
    await updater.tick();
    expect(updater.finalExitCode()).toBe(1);
  });

  test("start/stop are idempotent and the tick timer never blocks exit", () => {
    const updater = createIdleWorkerAutoUpdater(optionsWith({ config: configWith() }));
    updater.start();
    updater.start();
    updater.stop();
    updater.stop();
    updater.start();
    updater.stop();
    expect(WORKER_AUTO_UPDATE_TICK_MS).toBeGreaterThan(0);
    expect(updater.isRestartPending()).toBe(false);
  });

  test("a thrown check failure never takes the tick down and releases the hold", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 2, maxConcurrencyPerRepo: 2 });
    const warns: string[] = [];
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        supervisor,
        runCheck: async () => {
          throw new Error("registry exploded");
        },
        warn: (message) => warns.push(message),
      }),
    );
    await updater.tick();
    expect(warns.some((line) => line.includes("registry exploded"))).toBe(true);
    const result = await supervisor.schedule({
      id: "after-failure",
      source: "test",
      repo: "backend",
      kind: "task",
      checkoutClass: "task_worktree",
      run: async () => "ran",
    });
    expect(result).toBe("ran");
  });
});

describe("runningUnderServiceManager", () => {
  test("detects systemd and generated-service markers", () => {
    expect(runningUnderServiceManager({})).toBe(false);
    expect(runningUnderServiceManager({ INVOCATION_ID: "abc" })).toBe(true);
    expect(runningUnderServiceManager({ SYSTEMD_EXEC_PID: "1234" })).toBe(true);
    expect(runningUnderServiceManager({ DEVINTERN_SERVICE: "1" })).toBe(true);
  });
});

describe("spawnWorkerSuccessor", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    console.log = () => undefined;
    console.warn = () => undefined;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  test("spawns the runtime with the original script args, detached and unref'd", () => {
    const spawned: Array<{ execPath: string; args: string[]; detached: boolean }> = [];
    const ok = spawnWorkerSuccessor({
      execPath: "/runtime/bun",
      argv: ["bun", "/global/dist/index.js", "worker", "--workspace", "/tmp/ws/workspace.toml"],
      env: {},
      spawnFn: ((path: string, args: string[], opts: { detached: boolean }) => {
        spawned.push({ execPath: path, args, detached: opts.detached });
        return {
          pid: 4321,
          unref: () => undefined,
          once: () => undefined,
        } as unknown as import("node:child_process").ChildProcess;
      }) as unknown as typeof import("node:child_process").spawn,
    });
    expect(ok).toBe(true);
    expect(spawned).toEqual([
      {
        execPath: "/runtime/bun",
        args: ["/global/dist/index.js", "worker", "--workspace", "/tmp/ws/workspace.toml"],
        detached: true,
      },
    ]);
  });

  test("returns false when spawning throws", () => {
    const warns: string[] = [];
    const ok = spawnWorkerSuccessor({
      argv: GLOBAL_ARGV,
      spawnFn: (() => {
        throw new Error("spawn failed");
      }) as unknown as typeof import("node:child_process").spawn,
      warn: (message) => warns.push(message),
    });
    expect(ok).toBe(false);
    expect(warns.some((line) => line.includes("spawn failed"))).toBe(true);
  });
});

describe("worker-auto-update cache wiring", () => {
  test("the updater reuses the shared update-check cache file format", async () => {
    const cachePath = join(tempDir(), "update-check.json");
    const updater = createIdleWorkerAutoUpdater(
      optionsWith({
        config: configWith(),
        cachePath,
        checkIntervalMs: 60_000,
        runCheck: undefined,
        now: () => 1_000,
        fetchFn: stubFetch("9.9.9"),
        installFn: async () => true,
        requestShutdown: () => undefined,
      }),
    );
    await updater.tick();
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      "@getdevintern/code": { latestVersion: string };
    };
    expect(cache["@getdevintern/code"].latestVersion).toBe("9.9.9");
  });
});
