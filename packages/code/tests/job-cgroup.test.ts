import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DELEGATED_CGROUP_ENV,
  enableJobCgroups,
  formatJobMemoryLimit,
  JOB_MEMORY_LIMIT_ENV,
  jobMemoryExceededSince,
  jobMemoryLimitReason,
  jobMemoryOomSnapshot,
  jobMemoryPercent,
  jobMemorySpawn,
  resetJobCgroupsForTests,
} from "../src/lib/worker/job-cgroup";
import { DAEMON_CGROUP_LEAF } from "../src/lib/worker/host-memory";

const SRC = join(import.meta.dir, "../src/lib/worker");

/** A systemd user manager that can run a transient service with a delegated cgroup. */
function delegatedServiceAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = spawnSync(
    "systemd-run",
    ["--user", "--wait", "--quiet", "--collect", "-p", "Delegate=yes", "/bin/true"],
    { timeout: 10_000 },
  );
  return probe.status === 0;
}

const SERVICE = "/user.slice/user-1000.slice/user@1000.service/app.slice/devintern-worker.service";
const GIB = 1024 ** 3;

let dir: string;
let cgroupRoot: string;
let selfCgroupFile: string;
let serviceDir: string;

function setSelf(path: string): void {
  writeFileSync(selfCgroupFile, `0::${path}\n`);
}

function enable(overrides: Partial<Parameters<typeof enableJobCgroups>[0]> = {}): string {
  return enableJobCgroups(
    {
      percent: 25,
      totalMemoryBytes: 16 * GIB,
      env: { [DELEGATED_CGROUP_ENV]: "1" },
      ...overrides,
    },
    { cgroupRoot, selfCgroupFile, platform: "linux" },
  );
}

beforeEach(() => {
  resetJobCgroupsForTests();
  dir = mkdtempSync(join(tmpdir(), "job-cgroup-test-"));
  cgroupRoot = join(dir, "cgroup");
  selfCgroupFile = join(dir, "self-cgroup");
  serviceDir = join(cgroupRoot, SERVICE);
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(join(serviceDir, "cgroup.controllers"), "cpu memory pids\n");
  writeFileSync(join(serviceDir, "cgroup.procs"), "4242\n");
  setSelf(SERVICE);
});

afterEach(() => {
  resetJobCgroupsForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("jobMemoryPercent", () => {
  test("defaults to an equal share of the service budget per concurrent job", () => {
    expect(jobMemoryPercent({ maxConcurrency: 4, memory: { maxPercent: 65 } })).toBe(16);
    expect(jobMemoryPercent({ maxConcurrency: 1, memory: { maxPercent: 65 } })).toBe(65);
  });

  test("an explicit value wins, including 0 (off)", () => {
    const base = { maxConcurrency: 4, memory: { maxPercent: 65 } };
    expect(jobMemoryPercent({ ...base, jobMemoryMaxPercent: 40 })).toBe(40);
    expect(jobMemoryPercent({ ...base, jobMemoryMaxPercent: 0 })).toBe(0);
  });
});

describe("formatJobMemoryLimit", () => {
  test("uses GB above one GiB and MB below", () => {
    expect(formatJobMemoryLimit(4 * GIB)).toBe("4 GB");
    expect(formatJobMemoryLimit(2.56 * GIB)).toBe("2.6 GB");
    expect(formatJobMemoryLimit(512 * 1024 ** 2)).toBe("512 MB");
  });
});

describe("enableJobCgroups", () => {
  test("moves the daemon into a leaf and enables the memory controller", () => {
    expect(enable()).toBe("Job memory limit: 4 GB per job (25% of host RAM)");
    expect(readFileSync(join(serviceDir, DAEMON_CGROUP_LEAF, "cgroup.procs"), "utf8")).toBe("4242");
    expect(readFileSync(join(serviceDir, "cgroup.subtree_control"), "utf8")).toBe("+memory");
  });

  test("re-enabling from the leaf keeps the service cgroup as the root", () => {
    setSelf(`${SERVICE}/${DAEMON_CGROUP_LEAF}`);
    expect(enable()).toContain("4 GB per job");
    const job = jobMemorySpawn("/bin/true", [], {});
    expect(job.args[2]).toStartWith(join(serviceDir, "job-"));
  });

  test("stays off without the unit's delegation marker", () => {
    expect(enable({ env: {} })).toContain("devintern worker service install");
    expect(jobMemorySpawn("/bin/true", ["a"], {}).command).toBe("/bin/true");
  });

  test("stays off inside a job cgroup, even with the marker inherited", () => {
    setSelf(`${SERVICE}/job-1-1`);
    expect(enable()).toContain("not the service's main process");
    expect(existsSync(join(serviceDir, "cgroup.subtree_control"))).toBe(false);
  });

  test("stays off when the memory controller is not delegated", () => {
    writeFileSync(join(serviceDir, "cgroup.controllers"), "cpu pids\n");
    expect(enable()).toContain("memory controller is not delegated");
  });

  test("stays off when set to 0 or on another platform", () => {
    expect(enable({ percent: 0 })).toContain("off");
    expect(
      enableJobCgroups(
        { percent: 25, totalMemoryBytes: 16 * GIB, env: { [DELEGATED_CGROUP_ENV]: "1" } },
        { cgroupRoot, selfCgroupFile, platform: "darwin" },
      ),
    ).toContain("not available");
  });
});

describe("jobMemorySpawn", () => {
  test("passes through unchanged when not enabled, minus the delegation marker", () => {
    const job = jobMemorySpawn("bun", ["x"], { A: "1", [DELEGATED_CGROUP_ENV]: "1" });
    expect(job).toMatchObject({ command: "bun", args: ["x"], env: { A: "1" } });
    expect(job.env[DELEGATED_CGROUP_ENV]).toBeUndefined();
    expect(job.onClose()).toEqual({ exceeded: false });
  });

  test("creates a capped job cgroup the process joins before exec", () => {
    enable();
    const job = jobMemorySpawn("/bin/echo", ["hello $HOME"], { [DELEGATED_CGROUP_ENV]: "1" });
    const procs = job.args[2];
    const jobDir = join(procs, "..");
    expect(readFileSync(join(jobDir, "memory.max"), "utf8")).toBe(String(4 * GIB));
    expect(job.env[JOB_MEMORY_LIMIT_ENV]).toBe("4 GB");
    expect(job.env[DELEGATED_CGROUP_ENV]).toBeUndefined();

    // The shim writes its own PID, then execs the command with its argv intact.
    const run = spawnSync(job.command, job.args, { encoding: "utf8" });
    expect(run.stdout).toBe("hello $HOME\n");
    expect(Number(readFileSync(procs, "utf8"))).toBeGreaterThan(0);

    // cgroupfs lets rmdir remove a dir with control files; a plain dir needs them gone.
    for (const file of ["cgroup.procs", "memory.max"]) rmSync(join(jobDir, file));
    expect(job.onClose()).toEqual({ exceeded: false });
    expect(existsSync(jobDir)).toBe(false);
  });

  test("reports an OOM kill recorded in the job cgroup", () => {
    enable();
    const job = jobMemorySpawn("/bin/true", [], {});
    const jobDir = join(job.args[2], "..");
    writeFileSync(join(jobDir, "memory.events"), "low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\n");
    expect(job.onClose()).toEqual({ exceeded: true, label: "4 GB" });
    // Idempotent: a second close (error after close) returns the same answer.
    expect(job.onClose()).toEqual({ exceeded: true, label: "4 GB" });
  });

  test("runs uncapped when the job cgroup cannot be created", () => {
    enable();
    rmSync(serviceDir, { recursive: true, force: true });
    const job = jobMemorySpawn("/bin/true", ["a"], {});
    expect(job.command).toBe("/bin/true");
    expect(job.env[JOB_MEMORY_LIMIT_ENV]).toBeUndefined();
  });
});

describe("in-job OOM detection", () => {
  test("only counts kills after the snapshot, and only inside a limited job", () => {
    const jobDir = join(serviceDir, "job-1-1");
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, "memory.events"), "oom_kill 2\n");
    setSelf(`${SERVICE}/job-1-1`);
    const deps = { cgroupRoot, selfCgroupFile };

    expect(jobMemoryOomSnapshot({}, deps)).toBeUndefined();
    const snapshot = jobMemoryOomSnapshot({ [JOB_MEMORY_LIMIT_ENV]: "4 GB" }, deps);
    expect(snapshot).toBe(2);
    expect(jobMemoryExceededSince(snapshot, deps)).toBe(false);
    writeFileSync(join(jobDir, "memory.events"), "oom_kill 3\n");
    expect(jobMemoryExceededSince(snapshot, deps)).toBe(true);
    expect(jobMemoryExceededSince(undefined, deps)).toBe(false);
  });

  test("names the cap in the failure reason", () => {
    expect(jobMemoryLimitReason("4 GB")).toBe("agent exceeded the job memory limit (4 GB)");
  });
});

describe("real delegated service cgroup", () => {
  test.skipIf(!delegatedServiceAvailable())(
    "a runaway job is OOM-killed at its cap while the job and the daemon survive",
    () => {
      const job = join(dir, "job.ts");
      writeFileSync(
        job,
        `import { spawnSync } from "child_process";
import { jobMemoryExceededSince, jobMemoryOomSnapshot } from ${JSON.stringify(join(SRC, "job-cgroup.ts"))};
const snapshot = jobMemoryOomSnapshot();
spawnSync(process.execPath, ["-e", "const a = []; for (;;) a.push(Buffer.alloc(16 << 20, 1));"]);
console.log("job-exceeded=" + jobMemoryExceededSince(snapshot) + " arg=" + process.argv[2]);
process.exit(3);
`,
      );
      const daemon = join(dir, "daemon.ts");
      writeFileSync(
        daemon,
        `import { spawn } from "child_process";
import { enableJobCgroups, jobMemorySpawn } from ${JSON.stringify(join(SRC, "job-cgroup.ts"))};
console.log(enableJobCgroups({ percent: 1, totalMemoryBytes: 256 * 100 * 1024 * 1024 }));
const job = jobMemorySpawn(process.execPath, [${JSON.stringify(job)}, "keep $HOME"], process.env);
const child = spawn(job.command, job.args, { stdio: "inherit", env: job.env });
child.on("close", (code) => console.log("code=" + code + " daemon=" + JSON.stringify(job.onClose())));
`,
      );
      const run = spawnSync(
        "systemd-run",
        [
          "--user",
          "--wait",
          "--pipe",
          "--quiet",
          "--collect",
          "-p",
          "Delegate=yes",
          "-p",
          "MemoryMax=2G",
          "-p",
          "MemorySwapMax=0",
          `--setenv=${DELEGATED_CGROUP_ENV}=1`,
          process.execPath,
          daemon,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(run.stdout).toContain("Job memory limit: 256 MB per job");
      expect(run.stdout).toContain("job-exceeded=true arg=keep $HOME");
      expect(run.stdout).toContain('code=3 daemon={"exceeded":true,"label":"256 MB"}');
    },
    60_000,
  );
});
