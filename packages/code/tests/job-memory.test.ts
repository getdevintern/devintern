import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir, totalmem } from "os";
import { dirname, join } from "path";

import { runResolveConflictsViaCli } from "../src/lib/acquirers/review-cli";
import { classifyAgentFailure } from "../src/lib/review/address";
import { RunStore } from "../src/lib/state/run-recorder";
import {
  DEFAULT_JOB_MEMORY_FRACTION,
  cgroupMemoryLimit,
  describeJobMemoryPlan,
  formatByteLimit,
  JOB_MEMORY_LABEL_ENV,
  JOB_MEMORY_MARKER_ENV,
  jobMemoryExitReason,
  jobMemoryLimitReason,
  jobMemoryMaxProblem,
  jobMemoryOomSnapshot,
  jobMemoryExceededSince,
  jobMemorySpawn,
  loadJobMemoryPlan,
  parseJobMemoryMax,
  resolveJobMemoryMax,
  resolveJobMemoryPlanForStartup,
  resetJobMemorySupportForTests,
  systemdScopeAvailable,
} from "../src/lib/worker/job-memory";
import {
  stopLeftoverJobScopes,
  withLeftoverJobScopeCleanup,
} from "../src/lib/worker/job-scope-cleanup";
import {
  claimJobScopeSlice,
  jobScopeSliceName,
  releaseJobScopeSliceForTests,
} from "../src/lib/worker/job-scope-slice";
import { renderSystemdUnit } from "../src/lib/worker/service";

const GIB = 1024 ** 3;

describe("job_memory_max parsing", () => {
  test("off values disable the limit", () => {
    for (const value of ["off", "OFF", "none", "disabled", "0", " "]) {
      expect(parseJobMemoryMax(value, 16 * GIB)).toBeNull();
    }
  });

  test("sizes use binary units and a readable label", () => {
    expect(parseJobMemoryMax("8GB", 16 * GIB)).toEqual({ maxBytes: 8 * GIB, label: "8 GB" });
    expect(parseJobMemoryMax("512MB", 16 * GIB)).toEqual({
      maxBytes: 512 * 1024 ** 2,
      label: "512 MB",
    });
    expect(parseJobMemoryMax("1.5G", 16 * GIB)).toEqual({
      maxBytes: Math.round(1.5 * GIB),
      label: "1.5 GB",
    });
    expect(parseJobMemoryMax("1024K", 16 * GIB)).toEqual({ maxBytes: 1024 * 1024, label: "1 MB" });
  });

  test("percentages resolve against physical RAM", () => {
    expect(parseJobMemoryMax("50%", 16 * GIB)).toEqual({ maxBytes: 8 * GIB, label: "8 GB" });
    expect(parseJobMemoryMax("100%", 16 * GIB)?.maxBytes).toBe(16 * GIB);
  });

  test("unset uses the default fraction", () => {
    expect(resolveJobMemoryMax(undefined, 16 * GIB)?.maxBytes).toBe(
      Math.floor(16 * GIB * DEFAULT_JOB_MEMORY_FRACTION),
    );
  });

  test("rejects malformed values", () => {
    for (const value of ["8", "lots", "0%", "101%", "-1GB", "8GB extra"]) {
      expect(jobMemoryMaxProblem(value)).toBeString();
    }
    expect(jobMemoryMaxProblem("8GB")).toBeUndefined();
    expect(jobMemoryMaxProblem("off")).toBeUndefined();
  });

  test("formats sizes compactly", () => {
    expect(formatByteLimit(8 * GIB)).toBe("8 GB");
    expect(formatByteLimit(1.5 * GIB)).toBe("1.5 GB");
    expect(formatByteLimit(700)).toBe("700 B");
  });
});

describe("job memory plan", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspaceWith(settings: string): string {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "workspace.toml"),
      `[defaults]\ntracker = "markdown"\n${settings}\n[[repos]]\nname = "local"\nremote = "git@github.com:acme/local.git"\n`,
    );
    return dir;
  }

  test("a workspace without the key and an explicit off value differ", () => {
    const offDir = workspaceWith('job_memory_max = "off"');
    const env = { DEVINTERN_WORKSPACE_DIR: offDir };
    const plan = loadJobMemoryPlan(env);
    expect(plan.mechanism).toBe("none");
    expect(plan.limit).toBeUndefined();
    expect(plan.reason).toContain("job_memory_max is off");
  });

  test("no workspace config leaves jobs unlimited", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-missing-"));
    dirs.push(dir);
    const plan = loadJobMemoryPlan({ DEVINTERN_WORKSPACE_DIR: dir });
    expect(plan.mechanism).toBe("none");
    expect(plan.reason).toContain("no workspace.toml");
  });

  test("an invalid config reports the real parse error, not a missing file", () => {
    const dir = workspaceWith('job_memory_max = "1GB"');
    writeFileSync(
      join(dir, "workspace.toml"),
      `[defaults]\ntracker = "markdown"\njob_memory_max = "1GB"\npoll_interval = "wrong"\n[[repos]]\nname = "local"\nremote = "git@github.com:acme/local.git"\n`,
    );
    const plan = loadJobMemoryPlan({ DEVINTERN_WORKSPACE_DIR: dir });
    expect(plan.mechanism).toBe("none");
    expect(plan.reason).toContain("poll_interval");
    expect(plan.reason).not.toContain("no workspace.toml");
  });

  test("keeps the last valid limit when an unrelated live edit breaks the config", () => {
    const dir = workspaceWith('job_memory_max = "1GB"');
    const env = { DEVINTERN_WORKSPACE_DIR: dir };
    const first = loadJobMemoryPlan(env);
    writeFileSync(
      join(dir, "workspace.toml"),
      `[defaults]\ntracker = "markdown"\njob_memory_max = "1GB"\npoll_interval = "wrong"\n[[repos]]\nname = "local"\nremote = "git@github.com:acme/local.git"\n`,
    );
    const second = loadJobMemoryPlan(env);
    if (first.mechanism === "systemd-scope") {
      expect(second.mechanism).toBe("systemd-scope");
      expect(second.limit?.maxBytes).toBe(GIB);
    } else {
      // No user manager here: the parse still succeeded, so the reason is the
      // unavailable mechanism rather than a config error.
      expect(second.reason).toContain("systemd-run");
      expect(second.reason).not.toContain("could not be read");
    }
  });

  test("the default cap is split across max_concurrency jobs", () => {
    const dir = workspaceWith(
      '[workspace.execution]\nisolation = "best_effort_host"\nmax_concurrency = 4',
    );
    const plan = loadJobMemoryPlan({ DEVINTERN_WORKSPACE_DIR: dir });
    const budget = Math.min(totalmem(), cgroupMemoryLimit() ?? Number.POSITIVE_INFINITY);
    const expected = Math.floor(budget * (DEFAULT_JOB_MEMORY_FRACTION / 4));
    if (plan.limit) expect(plan.limit.maxBytes).toBe(expected);
    expect(
      resolveJobMemoryMax(undefined, 16 * GIB, DEFAULT_JOB_MEMORY_FRACTION / 4)?.maxBytes,
    ).toBe(2 * GIB);
  });

  test("the environment override wins and resolves a size", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-empty-"));
    dirs.push(dir);
    const plan = loadJobMemoryPlan({
      DEVINTERN_WORKSPACE_DIR: dir,
      DEVINTERN_JOB_MEMORY_MAX: "1GB",
    });
    // Either the systemd scope is usable (limit present) or the host has none.
    if (plan.limit) {
      expect(plan.limit.maxBytes).toBe(GIB);
      expect(plan.mechanism).toBe("systemd-scope");
    } else {
      expect(plan.reason).toContain("systemd-run");
    }
  });

  test("describes the effective plan for logs and diagnostics", () => {
    expect(
      describeJobMemoryPlan({
        mechanism: "systemd-scope",
        limit: { maxBytes: 8 * GIB, label: "8 GB" },
        swap: true,
      }),
    ).toBe("Job memory limit: 8 GB per job (systemd scope, swap disabled)");
    expect(
      describeJobMemoryPlan({ mechanism: "none", reason: "[defaults].job_memory_max is off" }),
    ).toBe("Job memory limit: disabled ([defaults].job_memory_max is off)");
  });
});

describe("jobMemorySpawn", () => {
  test("wraps the command in a systemd scope with a fixed OOM shim", () => {
    const spec = jobMemorySpawn(
      "/bin/echo",
      ["hello"],
      { KEEP: "me" },
      {
        mechanism: "systemd-scope",
        limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
        swap: true,
      },
    );
    expect(spec.limited).toBe(true);
    expect(spec.systemdArgs?.[0]).toBe("systemd-run");
    expect(spec.systemdArgs).toContain("MemoryMax=536870912");
    expect(spec.systemdArgs).toContain("OOMPolicy=continue");
    expect(spec.systemdArgs).toContain("MemorySwapMax=0");
    expect(spec.systemdArgs).toContain("--scope");
    expect(spec.systemdArgs).toContain("--collect");
    expect(spec.systemdArgs?.at(-2)).toBe("/bin/echo");
    expect(spec.systemdArgs?.at(-1)).toBe("hello");
    expect(spec.env.KEEP).toBe("me");
    expect(spec.env[JOB_MEMORY_LABEL_ENV]).toBe("512 MB");
    expect(spec.env[JOB_MEMORY_MARKER_ENV]).toContain("devintern-job-memory-");
    expect(spec.onClose(0)).toEqual({ exceeded: false });
  });

  test("omits the swap cap when the host cannot enforce it", () => {
    const spec = jobMemorySpawn(
      "/bin/echo",
      ["hello"],
      {},
      {
        mechanism: "systemd-scope",
        limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
        swap: false,
      },
    );
    expect(spec.systemdArgs).toContain("OOMPolicy=continue");
    expect(spec.systemdArgs).not.toContain("MemorySwapMax=0");
  });

  test("leaves the command untouched without a limit", () => {
    const env = { KEEP: "me" };
    const spec = jobMemorySpawn("/bin/echo", ["hello"], env, { mechanism: "none" });
    expect(spec.limited).toBe(false);
    expect(spec.command).toBe("/bin/echo");
    expect(spec.args).toEqual(["hello"]);
    expect(spec.env).toBe(env);
    expect(spec.onClose(0)).toEqual({ exceeded: false });
  });

  test("passes dollar text verbatim and turns systemd expansion off", () => {
    const spec = jobMemorySpawn(
      "/bin/echo",
      ["literal ${HOME} and $HOME"],
      {},
      {
        mechanism: "systemd-scope",
        limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
        noExpand: true,
      },
    );
    expect(spec.systemdArgs).toContain("--expand-environment=no");
    expect(spec.systemdArgs?.at(-1)).toBe("literal ${HOME} and $HOME");
  });

  test("puts job scopes in the workspace's job slice only for the lock-holding worker", () => {
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    const sliceOf = (spec: { systemdArgs?: string[] }) =>
      spec.systemdArgs?.find((arg) => arg.startsWith("--slice="));
    const spawnFor = (dir: string) =>
      jobMemorySpawn("/bin/echo", ["hi"], { DEVINTERN_WORKSPACE_DIR: dir }, plan);
    try {
      // Standalone dashboard retries and `webhook serve` never claim the
      // slice, so a starting or stopping worker cannot stop their jobs.
      expect(sliceOf(spawnFor("/srv/ws-a"))).toBeUndefined();
      claimJobScopeSlice("/srv/ws-a");
      const a = spawnFor("/srv/ws-a");
      expect(sliceOf(a)).toBe(`--slice=${jobScopeSliceName("/srv/ws-a")}`);
      expect(sliceOf(spawnFor("/srv/ws-a/"))).toBe(sliceOf(a));
      expect(sliceOf(spawnFor("/srv/ws-b"))).toBeUndefined();
    } finally {
      releaseJobScopeSliceForTests();
    }
    // The installed unit stops the same slice after the daemon exits.
    expect(
      renderSystemdUnit({ execPath: "/usr/bin/devintern", projectDir: "/srv/ws-a" }),
    ).toContain(`ExecStopPost=-systemctl --user stop ${jobScopeSliceName("/srv/ws-a")}\n`);
  });

  test("rewrites the shim and launcher after a temp cleaner deletes them", () => {
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    const first = jobMemorySpawn("/bin/echo", ["hi"], {}, plan);
    expect(first.command).toBe(process.execPath);
    rmSync(dirname(first.args[0]), { recursive: true, force: true });
    const second = jobMemorySpawn("/bin/echo", ["hi"], {}, plan);
    expect(second.command).toBe(process.execPath);
    const launcher = second.args[0];
    const shim = second.systemdArgs?.[second.systemdArgs.indexOf("--") + 2];
    expect(shim?.endsWith("oom-shim.sh")).toBe(true);
    expect(existsSync(launcher)).toBe(true);
    expect(existsSync(shim ?? "")).toBe(true);
    expect(launcher).not.toBe(first.args[0]);
    for (const spec of [first, second]) spec.onClose(0);
  });

  test("the startup hook stops leftover scopes before claiming the slice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-claim-"));
    const workspaceDir = join(dir, "workspace");
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    const env = { DEVINTERN_WORKSPACE_DIR: workspaceDir, PATH: dir, XDG_RUNTIME_DIR: dir };
    const sliceArg = () =>
      jobMemorySpawn("/bin/echo", ["hi"], env, plan).systemdArgs?.find((arg) =>
        arg.startsWith("--slice="),
      );
    let sliceInNext: string | undefined = "unset";
    try {
      expect(sliceArg()).toBeUndefined();
      await withLeftoverJobScopeCleanup(async () => {
        sliceInNext = sliceArg();
      }, env)();
      expect(sliceInNext).toBe(`--slice=${jobScopeSliceName(workspaceDir)}`);
    } finally {
      releaseJobScopeSliceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stops leftover job scopes in the workspace slice only when it is active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-leftover-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "systemctl.log");
    // Fake systemctl: log the call; is-active succeeds only when FAKE_ACTIVE=1.
    writeFileSync(
      join(binDir, "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
case "$*" in
  *is-active*) [ "$FAKE_ACTIVE" = "1" ] ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const workspaceDir = join(dir, "workspace");
    const slice = jobScopeSliceName(workspaceDir);
    const base = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      XDG_RUNTIME_DIR: dir,
    };
    try {
      expect(await stopLeftoverJobScopes({ ...base, FAKE_ACTIVE: "0" })).toBe(false);
      expect(readFileSync(logPath, "utf8")).toBe(`--user is-active --quiet ${slice}\n`);
      expect(await stopLeftoverJobScopes({ ...base, FAKE_ACTIVE: "1" })).toBe(true);
      expect(readFileSync(logPath, "utf8").trim().split("\n").at(-1)).toBe(`--user stop ${slice}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("systemd 252: caps memory without OOMPolicy or --expand-environment, argv intact", async () => {
    // Stand-in for systemd 252: getopt rejects --expand-environment (added in
    // 254) and the scope rejects OOMPolicy (added for scopes in 253). It never
    // expands $VAR in a scope command line, so it runs the argv as given.
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-252-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "systemd-run.log");
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
for arg in "$@"; do
  [ "$arg" = "--" ] && break
  case "$arg" in
    --expand-environment*) echo "systemd-run: unrecognized option '$arg'" >&2; exit 1 ;;
    OOMPolicy=*) echo "Unknown assignment: $arg" >&2; exit 1 ;;
  esac
done
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    const workspaceDir = join(dir, "workspace");
    mkdirSync(workspaceDir);
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]\ntracker = "markdown"\njob_memory_max = "1GB"\n[[repos]]\nname = "local"\nremote = "git@github.com:acme/local.git"\n`,
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      XDG_RUNTIME_DIR: dir,
    };
    // The test runner pins the override off; this test reads workspace.toml.
    delete env.DEVINTERN_JOB_MEMORY_MAX;
    try {
      resetJobMemorySupportForTests();
      const plan = await resolveJobMemoryPlanForStartup(env);
      // Before: the OOMPolicy probe failed, so the cap was reported unavailable.
      expect(plan.mechanism).toBe("systemd-scope");
      expect(plan.limit?.maxBytes).toBe(GIB);
      expect(plan.oomPolicy).toBe(false);
      expect(plan.noExpand).toBe(false);

      const value = "task $KEY ${HOME} $$ cost$5";
      const spec = jobMemorySpawn("/bin/echo", [value], env, plan);
      expect(spec.systemdArgs).not.toContain("OOMPolicy=continue");
      expect(spec.systemdArgs).not.toContain("--expand-environment=no");
      const run = spawnSync(spec.command, spec.args, {
        encoding: "utf8",
        env: spec.env,
        timeout: 30_000,
      });
      expect(run.stderr).toBe("");
      // Before: the job received "task $$KEY $${HOME} $$$$ cost$$5".
      expect(run.stdout).toBe(`${value}\n`);
      expect(run.status).toBe(0);
      // The scope really ran (no unwrapped fallback).
      expect(spec.onClose(0)).toEqual({ exceeded: false });
      const jobLine = readFileSync(logPath, "utf8").trim().split("\n").at(-1) ?? "";
      expect(jobLine).toContain("MemoryMax=1073741824");
      expect(jobLine).not.toContain("OOMPolicy");
      expect(jobLine).toEndWith(`/bin/echo ${value}`);
    } finally {
      resetJobMemorySupportForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not report a SIGTERM drain as a memory-limit hit", () => {
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    // A service-manager/drain SIGTERM reaches the child as exit 143. Only the
    // OOM shim marker or a SIGKILL (137/null) can prove an OOM.
    expect(jobMemorySpawn("/bin/echo", ["drain"], {}, plan).onClose(143)).toEqual({
      exceeded: false,
    });
    expect(jobMemorySpawn("/bin/echo", ["killed"], {}, plan).onClose(137)).toEqual({
      exceeded: true,
      label: "512 MB",
    });
  });

  test("runs the command unwrapped when systemd-run fails before the scope starts", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-fallback-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
echo "Failed to start transient scope unit: boom" >&2
exit 1
`,
      { mode: 0o755 },
    );
    try {
      const spec = jobMemorySpawn(
        "/bin/echo",
        ["fallback-ran"],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        {
          mechanism: "systemd-scope",
          limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
        },
      );
      const run = spawnSync(spec.command, spec.args, {
        encoding: "utf8",
        env: spec.env,
        timeout: 30_000,
      });
      expect(run.stderr).toContain("Failed to start transient scope unit");
      expect(run.stdout.trim()).toBe("fallback-ran");
      expect(run.status).toBe(0);
      // No cap was applied, so a zero exit is not reported as a memory hit.
      expect(spec.onClose(0)).toEqual({ exceeded: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a job that started in the scope and failed is not rerun unwrapped", () => {
    // Fake systemd-run that runs the command (as a real scope would) and then
    // reports a failure. The shim's started marker must land at the env path,
    // so the launcher forwards the failure instead of rerunning the job.
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-started-"));
    const binDir = join(dir, "bin");
    const cwd = join(dir, "cwd");
    mkdirSync(binDir);
    mkdirSync(cwd);
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
"$@"
exit 3
`,
      { mode: 0o755 },
    );
    try {
      const spec = jobMemorySpawn(
        "/bin/echo",
        ["ran-once"],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        {
          mechanism: "systemd-scope",
          limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
        },
      );
      const run = spawnSync(spec.command, spec.args, {
        cwd,
        encoding: "utf8",
        env: spec.env,
        timeout: 30_000,
      });
      expect(run.stdout.trim()).toBe("ran-once");
      expect(run.status).toBe(3);
      expect(readdirSync(cwd)).toEqual([]);
      expect(spec.onClose(3)).toEqual({ exceeded: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not bind an installed worker's job scope to its service unit", () => {
    // BindsTo stopped the scope in the same transaction as the service,
    // before the worker's drain grace period could let the job finish.
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    const manual = jobMemorySpawn("/bin/echo", ["hi"], {}, plan);
    expect(manual.systemdArgs?.join(" ")).not.toContain("BindsTo=");

    const service = jobMemorySpawn("/bin/echo", ["hi"], { DEVINTERN_SERVICE: "1" }, plan);
    expect(service.systemdArgs?.join(" ")).not.toContain("BindsTo=");
    expect(service.systemdArgs?.join(" ")).not.toContain("PartOf=");
  });

  test("writes the OOM shim in a private directory, not a predictable path", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-shim-test-"));
    const victim = join(dir, "victim.txt");
    const wrapper = join(dir, "wrapper.ts");
    writeFileSync(victim, "safe");
    writeFileSync(
      wrapper,
      `import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { jobMemorySpawn } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/worker/job-memory.ts"))});
const victim = process.env.VICTIM;
const predictable = join(tmpdir(), \`devintern-job-memory-shim-\${process.pid}.sh\`);
writeFileSync(victim, "safe");
try { unlinkSync(predictable); } catch {}
symlinkSync(victim, predictable);
try {
  jobMemorySpawn("/bin/echo", ["hi"], {}, {
    mechanism: "systemd-scope",
    limit: { maxBytes: 1024 * 1024, label: "1 MB" },
  });
  process.stdout.write(readFileSync(victim, "utf8"));
} finally {
  try { unlinkSync(predictable); } catch {}
}
`,
    );
    try {
      const run = spawnSync(process.execPath, [wrapper], {
        encoding: "utf8",
        env: { ...process.env, VICTIM: victim },
        timeout: 30_000,
      });
      // Old code wrote a fixed shim to that predictable name, following the
      // symlink and truncating the victim with the shim contents.
      expect(run.stdout).toBe("safe");
      expect(readFileSync(victim, "utf8")).toBe("safe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("job memory at a real call site", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetJobMemorySupportForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("spawns the resolver through the wrapped command with env and fd 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-callsite-"));
    dirs.push(dir);
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "systemd-run.log");
    // Stand-in for systemd-run: record the invocation, then run the command
    // after `--` exactly as systemd-run would.
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SYSTEMD_RUN_LOG"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] && shift
exec "$@"
`,
      { mode: 0o755 },
    );
    const workspaceDir = join(dir, "workspace");
    mkdirSync(workspaceDir);
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]\ntracker = "markdown"\njob_memory_max = "1GB"\n[[repos]]\nname = "local"\nremote = "git@github.com:acme/local.git"\n`,
    );
    const fixture = join(dir, "resolver.ts");
    writeFileSync(
      fixture,
      `import { writeSync } from "node:fs";
const fd = Number(process.env.DEVINTERN_RESULT_FD);
const label = process.env.DEVINTERN_JOB_MEMORY_LIMIT_LABEL ?? "unset";
const marker = process.env.DEVINTERN_JOB_MEMORY_MARKER ? "set" : "unset";
writeSync(fd, JSON.stringify({ outcome: "clean", message: \`label=\${label} marker=\${marker}\` }) + "\\n");
`,
    );
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      DEVINTERN_JOB_MEMORY_MAX: "1GB",
      FAKE_SYSTEMD_RUN_LOG: logPath,
    };

    // Resolve + cache the plan the way the worker does at startup.
    const plan = await resolveJobMemoryPlanForStartup(env);
    expect(plan.mechanism).toBe("systemd-scope");
    expect(plan.limit?.label).toBe("1 GB");

    const result = await runResolveConflictsViaCli("acme/widgets", 1, {
      entrypoint: fixture,
      outputStdio: "ignore",
      env,
    });

    expect(result).toEqual({ outcome: "clean", message: "label=1 GB marker=set" });
    const invocations = readFileSync(logPath, "utf8");
    expect(invocations).toContain("--scope");
    expect(invocations).toContain("MemoryMax=1073741824");
  });
});

describe("cgroupMemoryLimit", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("takes the smallest finite limit while walking ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-cgroup-"));
    dirs.push(root);
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/b/memory.max"), "max\n");
    writeFileSync(join(root, "a/memory.max"), "1073741824\n");
    writeFileSync(join(root, "memory.max"), "536870912\n");
    expect(cgroupMemoryLimit(root, "/a/b")).toBe(512 * 1024 ** 2);
  });

  test("returns undefined when every level is unlimited or missing", () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-cgroup-"));
    dirs.push(root);
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/b/memory.max"), "max\n");
    writeFileSync(join(root, "a/memory.max"), "max\n");
    expect(cgroupMemoryLimit(root, "/a/b")).toBeUndefined();
  });
});

describe("classifyAgentFailure", () => {
  const base = { code: 137, timedOut: false, maxTurnsReached: false, timeoutMinutes: 60 };

  test("reports the memory limit instead of a signal exit", () => {
    expect(classifyAgentFailure({ ...base, memoryLimitExceeded: true })).toBe(
      jobMemoryLimitReason(),
    );
  });

  test("keeps a successful run successful even if a descendant was killed", () => {
    expect(classifyAgentFailure({ ...base, code: 0, memoryLimitExceeded: true })).toBeUndefined();
  });

  test("names the configured size", () => {
    expect(jobMemoryLimitReason("8 GB")).toBe("agent exceeded the job memory limit (8 GB)");
  });

  test("child-side snapshots are inert outside a limited job", () => {
    expect(jobMemoryOomSnapshot({})).toBeUndefined();
    expect(jobMemoryExceededSince(undefined)).toBe(false);
    expect(jobMemoryExitReason(1, undefined)).toBeUndefined();
  });
});

/**
 * Real-scope test: spawns a process that ignores its memory cap, and asserts
 * the scope kills it while this test process stays alive. Skipped on hosts
 * without a usable systemd user manager.
 */
describe("job memory scope integration", () => {
  test.skipIf(!systemdScopeAvailable())(
    "passes prompt text through without systemd variable expansion",
    async () => {
      const spec = jobMemorySpawn(
        "/bin/echo",
        ["literal ${HOME} and ${PATH}"],
        { ...process.env },
        {
          mechanism: "systemd-scope",
          limit: { maxBytes: 128 * 1024 ** 2, label: "128 MB" },
          swap: true,
        },
      );
      const stdout = await new Promise<string>((resolve) => {
        const child = spawn(spec.command, spec.args, {
          stdio: ["ignore", "pipe", "ignore"],
          env: spec.env,
        });
        let text = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        child.on("close", () => resolve(text));
      });
      expect(stdout.trim()).toBe("literal ${HOME} and ${PATH}");
      expect(spec.onClose(0)).toEqual({ exceeded: false });
    },
    60_000,
  );

  test.skipIf(!systemdScopeAvailable())(
    "kills a runaway child and reports the memory-limit outcome",
    async () => {
      const spec = jobMemorySpawn(
        process.execPath,
        ["-e", "const held = []; for (;;) held.push(Buffer.alloc(16 * 1024 * 1024, 1));"],
        { ...process.env },
        {
          mechanism: "systemd-scope",
          limit: { maxBytes: 256 * 1024 ** 2, label: "256 MB" },
          swap: true,
        },
      );
      expect(spec.limited).toBe(true);

      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(spec.command, spec.args, {
          stdio: "ignore",
          env: spec.env,
        });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      });

      // The parent (this test process) is still running, and the runaway was
      // killed rather than allowed to grow unbounded.
      expect(spawnSync("/bin/true", [], { stdio: "ignore" }).status).toBe(0);
      expect(exitCode).not.toBe(0);
      const memory = spec.onClose(exitCode);
      expect(memory.exceeded).toBe(true);
      expect(memory.label).toBe("256 MB");

      const previous = process.env[JOB_MEMORY_LABEL_ENV];
      process.env[JOB_MEMORY_LABEL_ENV] = memory.label ?? "";
      try {
        expect(
          classifyAgentFailure({
            code: exitCode,
            timedOut: false,
            maxTurnsReached: false,
            timeoutMinutes: 60,
            memoryLimitExceeded: true,
          }),
        ).toBe("agent exceeded the job memory limit (256 MB)");
      } finally {
        if (previous === undefined) delete process.env[JOB_MEMORY_LABEL_ENV];
        else process.env[JOB_MEMORY_LABEL_ENV] = previous;
      }
    },
    120_000,
  );

  test.skipIf(!systemdScopeAvailable())(
    "keeps the job CLI alive so it records the memory-limit run outcome",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-outcome-"));
      const dbPath = join(dir, "queue.db");
      const wrapperPath = join(dir, "job-cli.ts");
      const runRecorderPath = join(import.meta.dir, "../src/lib/state/run-recorder.ts");
      const jobMemoryPath = join(import.meta.dir, "../src/lib/worker/job-memory.ts");
      // A stand-in for the job CLI: it stays inside the scope, starts a runaway
      // descendant, and records what it saw in a real RunStore, exactly like a
      // task run does after its agent is killed.
      writeFileSync(
        wrapperPath,
        `import { spawn } from "node:child_process";
const { RunStore } = await import(${JSON.stringify(runRecorderPath)});
const { jobMemoryExceededSince, jobMemoryLimitReason, jobMemoryOomSnapshot } = await import(${JSON.stringify(jobMemoryPath)});
const store = new RunStore(process.env.TEST_JOB_MEMORY_DB);
const runId = store.createRun({ origin: "task", taskKey: "JOB-MEMORY-TEST" });
const before = jobMemoryOomSnapshot();
const hog = spawn(process.execPath, ["-e", "const held = []; for (;;) held.push(Buffer.alloc(16 * 1024 * 1024, 1));"], { stdio: "ignore" });
await new Promise((resolve) => hog.on("close", () => resolve(undefined)));
const exceeded = jobMemoryExceededSince(before);
store.finishRun(runId, "failed", exceeded ? jobMemoryLimitReason() : "hog survived the cap");
store.close();
process.exit(0);
`,
        "utf8",
      );
      try {
        const spec = jobMemorySpawn(
          process.execPath,
          [wrapperPath],
          { ...process.env, TEST_JOB_MEMORY_DB: dbPath },
          {
            mechanism: "systemd-scope",
            limit: { maxBytes: 256 * 1024 ** 2, label: "256 MB" },
            swap: true,
          },
        );
        const exitCode = await new Promise<number | null>((resolve) => {
          const child = spawn(spec.command, spec.args, {
            stdio: "ignore",
            env: spec.env,
          });
          child.on("error", () => resolve(null));
          child.on("close", (code) => resolve(code));
        });

        // The wrapper is the job CLI. With the scope's OOMPolicy=continue it
        // survives its descendant's OOM kill and exits normally; with the
        // default OOMPolicy=stop systemd would kill it and the run below would
        // never be finished.
        expect(exitCode).toBe(0);
        expect(spec.onClose(exitCode).exceeded).toBe(true);

        const store = new RunStore(dbPath, { readonly: true });
        try {
          const run = store.listRuns({ taskKey: "JOB-MEMORY-TEST" })[0];
          expect(run?.status).toBe("failed");
          expect(run?.outcomeReason).toBe("agent exceeded the job memory limit (256 MB)");
        } finally {
          store.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
