import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHostMemoryAdmission,
  hostTotalMemoryBytes,
  memoryAdmissionBlockReason,
  parseMeminfo,
  parsePsiSomeAvg10,
  readCgroupMemory,
  readHostMemorySnapshot,
} from "../src/lib/worker/host-memory";
import {
  DEFAULT_MEMORY_BUDGET,
  memoryBudgetBytes,
  validateMemoryBudget,
} from "../src/lib/worker/memory-budget";
import {
  installWorkerService,
  renderSystemdUnit,
  systemdUnitPath,
  workerServiceDefinitionCurrent,
} from "../src/lib/worker/service";
import type { RunCommandFn } from "../src/lib/worker/service";
import { createTaskSupervisor } from "../src/lib/worker/supervisor";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

const GIB = 1024 * 1024 * 1024;

describe("systemd memory budget", () => {
  test("derives the default limits from host RAM", () => {
    expect(memoryBudgetBytes(DEFAULT_MEMORY_BUDGET, 64 * GIB)).toEqual({
      memoryHighBytes: 32 * GIB,
      memoryMaxBytes: Math.floor(64 * GIB * 0.65),
      memorySwapMaxBytes: Math.floor(64 * GIB * 0.15),
    });
  });

  test("a zero swap percentage disables swap without dropping the other limits", () => {
    expect(
      memoryBudgetBytes({ highPercent: 50, maxPercent: 70, swapMaxPercent: 0 }, 16 * GIB),
    ).toEqual({
      memoryHighBytes: 8 * GIB,
      memoryMaxBytes: Math.floor(16 * GIB * 0.7),
      memorySwapMaxBytes: 0,
    });
  });

  test("rejects a throttle above the hard cap and out-of-range values", () => {
    expect(validateMemoryBudget({ highPercent: 80, maxPercent: 50, swapMaxPercent: 10 })).toContain(
      "cannot exceed",
    );
    expect(validateMemoryBudget({ highPercent: 0, maxPercent: 50, swapMaxPercent: 10 })).toContain(
      "memory_high_percent",
    );
    expect(
      validateMemoryBudget({ highPercent: 50, maxPercent: 101, swapMaxPercent: 10 }),
    ).toContain("memory_max_percent");
    expect(validateMemoryBudget({ highPercent: 50, maxPercent: 60, swapMaxPercent: -1 })).toContain(
      "memory_swap_max_percent",
    );
  });

  test("the generated unit caps the service cgroup and bounds a crash loop", () => {
    const unit = renderSystemdUnit({
      execPath: "/usr/local/bin/devintern",
      projectDir: "/srv/app",
      totalMemoryBytes: 64 * GIB,
    });
    expect(unit).toContain(`MemoryHigh=${32 * GIB}`);
    expect(unit).toContain(`MemoryMax=${Math.floor(64 * GIB * 0.65)}`);
    expect(unit).toContain(`MemorySwapMax=${Math.floor(64 * GIB * 0.15)}`);
    expect(unit).toContain("StartLimitIntervalSec=1800");
    expect(unit).toContain("StartLimitBurst=4");
  });

  test("a custom budget is written into the unit", () => {
    const unit = renderSystemdUnit({
      execPath: "devintern",
      projectDir: "/srv/app",
      totalMemoryBytes: 10 * GIB,
      memory: { highPercent: 40, maxPercent: 60, swapMaxPercent: 0 },
    });
    expect(unit).toContain(`MemoryHigh=${4 * GIB}`);
    expect(unit).toContain(`MemoryMax=${6 * GIB}`);
    expect(unit).toContain("MemorySwapMax=0");
  });

  test("an invalid custom budget falls back to the defaults instead of a unit systemd rejects", () => {
    const unit = renderSystemdUnit({
      execPath: "devintern",
      projectDir: "/srv/app",
      totalMemoryBytes: 10 * GIB,
      memory: { highPercent: 90, maxPercent: 50, swapMaxPercent: 0 },
    });
    expect(unit).toContain(`MemoryHigh=${5 * GIB}`);
    expect(unit).toContain(`MemoryMax=${Math.floor(10 * GIB * 0.65)}`);
  });

  test.skipIf(process.platform !== "linux")(
    "reinstalling updates a unit written before memory limits",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "devintern-service-memory-"));
      const unitPath = systemdUnitPath(home);
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(
        unitPath,
        "# Managed by devintern worker init\n[Service]\nExecStart=devintern worker\n",
      );
      const run: RunCommandFn = async () => ({ status: 0, stdout: "yes\n", stderr: "" });
      const deps = { platform: "linux" as const, homedir: home, run, env: {} };
      const options = {
        workspaceDir: join(home, ".devintern"),
        execPath: "devintern",
        runtimePath: "/usr/local/bin/bun",
        environmentPath: "/usr/bin",
      };
      try {
        expect(workerServiceDefinitionCurrent(options, deps)).toBe(false);
        const result = await installWorkerService(options, deps);
        expect(result.ok).toBe(true);
        expect(readFileSync(unitPath, "utf8")).toContain("MemoryMax=");
        expect(workerServiceDefinitionCurrent(options, deps)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe("workspace memory settings", () => {
  test("defaults to the generated-unit defaults", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
`);
    expect(config.workspace.execution.memory).toEqual(DEFAULT_MEMORY_BUDGET);
  });

  test("parses custom percentages", () => {
    const config = parseWorkspaceConfig(`
[workspace.execution]
memory_high_percent = 40
memory_max_percent = 60
memory_swap_max_percent = 0

[defaults]
tracker = "markdown"
`);
    expect(config.workspace.execution.memory).toEqual({
      highPercent: 40,
      maxPercent: 60,
      swapMaxPercent: 0,
    });
  });

  test("rejects a throttle above the hard cap", () => {
    expect(() =>
      parseWorkspaceConfig(`
[workspace.execution]
memory_high_percent = 90
memory_max_percent = 60

[defaults]
tracker = "markdown"
`),
    ).toThrow(/memory_high_percent cannot exceed memory_max_percent/);
  });
});

describe("host memory readings", () => {
  const meminfo = `MemTotal:       67108864 kB
MemFree:         1048576 kB
MemAvailable:   16777216 kB
SwapTotal:      16777216 kB
`;

  test("parses MemTotal and MemAvailable", () => {
    expect(parseMeminfo(meminfo)).toEqual({
      totalBytes: 64 * GIB,
      availableBytes: 16 * GIB,
    });
  });

  test("parses PSI some avg10", () => {
    expect(parsePsiSomeAvg10("some avg10=12.34 avg60=1.00 avg300=0.50 total=1\n")).toBe(12.34);
    expect(parsePsiSomeAvg10("full avg10=5.00 avg60=0.00 avg300=0.00 total=1\n")).toBeUndefined();
  });

  test("hostTotalMemoryBytes reads MemTotal", () => {
    expect(hostTotalMemoryBytes({ platform: "linux", readFile: () => meminfo })).toBe(64 * GIB);
  });

  test("reads the worker cgroup anonymous usage and limit", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/user-1000.slice/devintern-worker.service\n",
      "/sys/fs/cgroup/user.slice/user-1000.slice/devintern-worker.service/memory.current": "800\n",
      "/sys/fs/cgroup/user.slice/user-1000.slice/devintern-worker.service/memory.max": "1000\n",
      "/sys/fs/cgroup/user.slice/user-1000.slice/devintern-worker.service/memory.stat":
        "anon 600\nfile 200\n",
    };
    expect(readCgroupMemory({ readFile: (path) => files[path] ?? "" })).toEqual({
      usedBytes: 600,
      maxBytes: 1000,
    });
  });

  test("falls back to memory.current when memory.stat is unavailable", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/x.service\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.current": "800\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.max": "1000\n",
    };
    expect(readCgroupMemory({ readFile: (path) => files[path] ?? "" })).toEqual({
      usedBytes: 800,
      maxBytes: 1000,
    });
  });

  test("an unlimited cgroup is not a memory signal", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/x.service\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.current": "800\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.max": "max\n",
    };
    expect(readCgroupMemory({ readFile: (path) => files[path] ?? "" })).toBeNull();
  });

  test("combines host, PSI, and cgroup readings", () => {
    const files: Record<string, string> = {
      "/proc/meminfo": meminfo,
      "/proc/pressure/memory": "some avg10=3.00 avg60=1.00 avg300=0.10 total=1\n",
      "/proc/self/cgroup": "0::/user.slice/x.service\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.current": "400\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.max": "1000\n",
      "/sys/fs/cgroup/user.slice/x.service/memory.stat": "anon 350\nfile 50\n",
    };
    const snapshot = readHostMemorySnapshot({
      platform: "linux",
      readFile: (path) => files[path] ?? "",
    });
    expect(snapshot).toMatchObject({
      totalBytes: 64 * GIB,
      availableBytes: 16 * GIB,
      pressureSomeAvg10: 3,
      cgroupUsedBytes: 350,
      cgroupMaxBytes: 1000,
    });
  });
});

describe("memory admission", () => {
  const snapshot = {
    totalBytes: 64 * GIB,
    availableBytes: 32 * GIB,
  };

  test("admits when the host has plenty of memory", () => {
    expect(memoryAdmissionBlockReason(snapshot)).toBeNull();
  });

  test("defers when available memory falls under 5% of RAM", () => {
    expect(memoryAdmissionBlockReason({ ...snapshot, availableBytes: 2 * GIB })).toContain(
      "host memory is available",
    );
  });

  test("keeps a small absolute floor for tiny hosts", () => {
    expect(
      memoryAdmissionBlockReason({ totalBytes: 2 * GIB, availableBytes: 400 * 1024 * 1024 }),
    ).toContain("host memory is available");
  });

  test("defers on high PSI memory pressure", () => {
    expect(memoryAdmissionBlockReason({ ...snapshot, pressureSomeAvg10: 60 })).toContain(
      "memory pressure",
    );
  });

  test("defers near the worker's own cgroup cap", () => {
    expect(
      memoryAdmissionBlockReason({
        ...snapshot,
        cgroupUsedBytes: 900,
        cgroupMaxBytes: 1000,
      }),
    ).toContain("own memory budget");
  });

  test("can be disabled with DEVINTERN_MEMORY_ADMISSION=0", () => {
    const admission = createHostMemoryAdmission({
      env: { DEVINTERN_MEMORY_ADMISSION: "0" },
      readFile: () => "",
    });
    expect(admission()).toBeNull();
  });

  test("fails open when a reader throws", () => {
    const admission = createHostMemoryAdmission({
      env: {},
      readFile: () => {
        throw new Error("procfs unavailable");
      },
    });
    expect(admission()).toBeNull();
  });
});

describe("supervisor memory backpressure", () => {
  function request(id: string, run: () => Promise<void>) {
    return {
      id,
      source: "test",
      repo: "web",
      kind: "task" as const,
      checkoutClass: "task_worktree" as const,
      run,
    };
  }

  test("queues work with waitingOn memory and starts it when pressure clears", async () => {
    let blocked = true;
    const supervisor = createTaskSupervisor(
      { maxConcurrency: 2, maxConcurrencyPerRepo: 2 },
      { backpressure: () => (blocked ? "host memory is low" : null), backpressureRetryMs: 5 },
    );

    let started = false;
    const job = supervisor.schedule(
      request("held", async () => {
        started = true;
      }),
    );

    expect(started).toBe(false);
    expect(supervisor.queuedJobs?.()).toMatchObject([
      { id: "held", waitingOn: "memory", blockReason: "host memory is low" },
    ]);

    blocked = false;
    await Promise.race([
      job,
      Bun.sleep(500).then(() => {
        throw new Error("the queued job did not start after memory pressure cleared");
      }),
    ]);
    expect(started).toBe(true);
    expect(supervisor.queuedJobs?.()).toEqual([]);
  });

  test("a probe that clears between pumps still starts the queued job", async () => {
    let calls = 0;
    const supervisor = createTaskSupervisor(
      { maxConcurrency: 2, maxConcurrencyPerRepo: 2 },
      { backpressure: () => (++calls === 1 ? "host memory is low" : null), backpressureRetryMs: 5 },
    );

    let started = false;
    await Promise.race([
      supervisor.schedule(
        request("held", async () => {
          started = true;
        }),
      ),
      Bun.sleep(500).then(() => {
        throw new Error("the queued job did not start after the probe reported clear");
      }),
    ]);
    expect(started).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("a throwing probe fails open", async () => {
    const supervisor = createTaskSupervisor(
      { maxConcurrency: 1, maxConcurrencyPerRepo: 1 },
      {
        backpressure: () => {
          throw new Error("broken reader");
        },
      },
    );
    let started = false;
    await supervisor.schedule(
      request("runs", async () => {
        started = true;
      }),
    );
    expect(started).toBe(true);
  });

  test("does not start work when the global limit is full even without pressure", async () => {
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const supervisor = createTaskSupervisor(
      { maxConcurrency: 1, maxConcurrencyPerRepo: 1 },
      { backpressure: () => null },
    );
    const first = supervisor.schedule(request("first", () => held));
    const second = supervisor.schedule({
      id: "second",
      source: "test",
      kind: "task",
      checkoutClass: "workspace",
      run: async () => {},
    });
    expect(supervisor.queuedJobs?.()).toMatchObject([{ id: "second", waitingOn: "global" }]);
    releaseFirst();
    await Promise.all([first, second]);
  });
});
