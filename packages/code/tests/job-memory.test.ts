import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  JOB_MEMORY_WEBHOOK_JOB_SLOTS,
  loadJobMemoryPlan,
  parseJobMemoryMax,
  primeJobMemorySupport,
  resolveJobMemoryMax,
  resolveJobMemoryPlanForStartup,
  resetJobMemorySupportForTests,
  systemdScopeAvailable,
} from "../src/lib/worker/job-memory";
import {
  recordJobScopeClaim,
  stopLeftoverJobScopes,
  withLeftoverJobScopeCleanup,
} from "../src/lib/worker/job-scope-cleanup";
import {
  claimJobScopeSlice,
  jobScopeClaimMarkerName,
  jobScopeClaimMarkerPath,
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

  test("the default cap is split across max_concurrency jobs plus the webhook slot", () => {
    const dir = workspaceWith(
      '[workspace.execution]\nisolation = "best_effort_host"\nmax_concurrency = 4',
    );
    const plan = loadJobMemoryPlan({ DEVINTERN_WORKSPACE_DIR: dir });
    const budget = Math.min(totalmem(), cgroupMemoryLimit() ?? Number.POSITIVE_INFINITY);
    const jobs = 4 + JOB_MEMORY_WEBHOOK_JOB_SLOTS;
    const expected = Math.floor(budget * (DEFAULT_JOB_MEMORY_FRACTION / jobs));
    if (plan.limit) expect(plan.limit.maxBytes).toBe(expected);
    expect(
      resolveJobMemoryMax(undefined, 16 * GIB, DEFAULT_JOB_MEMORY_FRACTION / jobs)?.maxBytes,
    ).toBe(Math.floor(16 * GIB * (DEFAULT_JOB_MEMORY_FRACTION / jobs)));
  });

  test("a full worker and a concurrent webhook job stay within the default budget", () => {
    // The bug: with max_concurrency = 1 each surface used 50%, so one worker
    // job plus one CI-fix job could reach 100% of the budget plus daemons.
    const dir = workspaceWith(
      '[workspace.execution]\nisolation = "best_effort_host"\nmax_concurrency = 1',
    );
    const plan = loadJobMemoryPlan({ DEVINTERN_WORKSPACE_DIR: dir });
    const budget = Math.min(totalmem(), cgroupMemoryLimit() ?? Number.POSITIVE_INFINITY);
    // Both processes resolve the same plan, so the worst case is one worker
    // slot plus one webhook slot, each at this cap.
    const concurrent = 1 + JOB_MEMORY_WEBHOOK_JOB_SLOTS;
    if (plan.limit) {
      expect(plan.limit.maxBytes).toBe(
        Math.floor(budget * (DEFAULT_JOB_MEMORY_FRACTION / concurrent)),
      );
      expect(plan.limit.maxBytes * concurrent).toBeLessThanOrEqual(
        budget * DEFAULT_JOB_MEMORY_FRACTION,
      );
    }
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

  test("puts job scopes in the workspace's job slice only for the claiming surface", () => {
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    const sliceOf = (spec: { systemdArgs?: string[] }) =>
      spec.systemdArgs?.find((arg) => arg.startsWith("--slice="));
    const spawnFor = (dir: string) =>
      jobMemorySpawn("/bin/echo", ["hi"], { DEVINTERN_WORKSPACE_DIR: dir }, plan);
    try {
      // Standalone dashboard retries and one-off CLI runs never claim a slice,
      // so a starting or stopping worker cannot stop their jobs.
      expect(sliceOf(spawnFor("/srv/ws-a"))).toBeUndefined();
      claimJobScopeSlice("/srv/ws-a");
      const a = spawnFor("/srv/ws-a");
      expect(sliceOf(a)).toBe(`--slice=${jobScopeSliceName("/srv/ws-a")}`);
      expect(sliceOf(spawnFor("/srv/ws-a/"))).toBe(sliceOf(a));
      expect(sliceOf(spawnFor("/srv/ws-b"))).toBeUndefined();
      // A detached dashboard retry must outlive the process that spawned it,
      // so it opts out even when this process claimed the workspace slice.
      expect(
        sliceOf(
          jobMemorySpawn("/bin/echo", ["hi"], { DEVINTERN_WORKSPACE_DIR: "/srv/ws-a" }, plan, {
            slice: false,
          }),
        ),
      ).toBeUndefined();
      // The webhook server owns a different slice, so neither surface's
      // startup/stop cleanup can stop the other's in-flight jobs.
      claimJobScopeSlice("/srv/ws-a", "webhook");
      expect(sliceOf(spawnFor("/srv/ws-a"))).toBe(
        `--slice=${jobScopeSliceName("/srv/ws-a", "webhook")}`,
      );
      expect(jobScopeSliceName("/srv/ws-a", "webhook")).not.toBe(jobScopeSliceName("/srv/ws-a"));
    } finally {
      releaseJobScopeSliceForTests();
    }
    // The installed unit stops the slice for its own surface after the daemon
    // exits, but only when the claim marker names this unit invocation.
    const workerUnit = renderSystemdUnit({
      execPath: "/usr/bin/devintern",
      projectDir: "/srv/ws-a",
    });
    expect(workerUnit).toContain(`systemctl --user stop ${jobScopeSliceName("/srv/ws-a")}; fi'`);
    expect(workerUnit).toContain(`cat "state/${jobScopeClaimMarkerName("/srv/ws-a")}"`);
    expect(workerUnit).toContain('"$$INVOCATION_ID"');
    const webhookUnit = renderSystemdUnit({
      execPath: "/usr/bin/devintern",
      projectDir: "/srv/ws-a",
      listen: true,
    });
    expect(webhookUnit).toContain(
      `systemctl --user stop ${jobScopeSliceName("/srv/ws-a", "webhook")}; fi'`,
    );
    expect(webhookUnit).toContain(`cat "state/${jobScopeClaimMarkerName("/srv/ws-a", "webhook")}"`);
  });

  test("ExecStopPost stops the slice only for the invocation that claimed it", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-slice-claim-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = join(dir, "systemctl.log");
    writeFileSync(
      join(binDir, "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
`,
      { mode: 0o755 },
    );
    const workspaceDir = join(dir, "workspace");
    mkdirSync(workspaceDir);
    const unit = renderSystemdUnit({ execPath: "/usr/bin/devintern", projectDir: workspaceDir });
    const line = unit.split("\n").find((entry) => entry.startsWith("ExecStopPost="));
    expect(line).toBeString();
    // systemd turns `$$` into a literal `$` before the shell runs the command.
    const command = (line ?? "").replace(/^ExecStopPost=-?/, "").replace(/\$\$/g, "$");
    const slice = jobScopeSliceName(workspaceDir);
    const baseEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const stopCalls = () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .split("\n")
            .filter((entry) => entry.includes("--user stop"))
        : [];
    const run = (invocation: string | undefined) =>
      spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        cwd: workspaceDir,
        env: invocation === undefined ? baseEnv : { ...baseEnv, INVOCATION_ID: invocation },
      });
    try {
      // Start failed before the worker claimed the slice (another worker holds
      // the lock): the stale/absent marker must not stop that worker's jobs.
      expect(run("unit-invocation-1").status).toBe(0);
      expect(stopCalls()).toEqual([]);

      // A manual worker claimed the slice: it removes the old invocation's
      // marker, so the unit's deferred stop still must not run.
      expect(recordJobScopeClaim(workspaceDir, { INVOCATION_ID: "unit-invocation-1" })).toBe(true);
      expect(recordJobScopeClaim(workspaceDir, {})).toBe(false);
      expect(existsSync(jobScopeClaimMarkerPath(workspaceDir))).toBe(false);
      expect(run("unit-invocation-1").status).toBe(0);
      expect(stopCalls()).toEqual([]);

      // The unit's own worker claimed it: its ExecStopPost stops the slice.
      expect(recordJobScopeClaim(workspaceDir, { INVOCATION_ID: "unit-invocation-1" })).toBe(true);
      expect(run("unit-invocation-2").status).toBe(0);
      expect(stopCalls()).toEqual([]);
      expect(run("unit-invocation-1").status).toBe(0);
      expect(stopCalls()).toEqual([`--user stop ${slice}`]);
    } finally {
      releaseJobScopeSliceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("stops leftover job scopes only when the slice still holds a live scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-leftover-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "systemctl.log");
    // Fake systemctl: log the call. is-active follows FAKE_ACTIVE; the slice is
    // only "live" when FAKE_SCOPES=1, matching whether a scope is reported in
    // FAKE_SLICE (the startup probe leaves an active but empty slice behind).
    writeFileSync(
      join(binDir, "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
case "$*" in
  *is-active*) [ "$FAKE_ACTIVE" = "1" ] || exit 1 ;;
  *list-units*) [ "$FAKE_SCOPES" = "1" ] && printf '%s\\n' "run-test.scope loaded active running probe" ;;
  *show*) [ "$FAKE_SCOPES" = "1" ] && printf 'Slice=%s\\n' "$FAKE_SLICE" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const workspaceDir = join(dir, "workspace");
    const slice = jobScopeSliceName(workspaceDir);
    const base = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      XDG_RUNTIME_DIR: dir,
      FAKE_SLICE: slice,
    };
    const calls = () => readFileSync(logPath, "utf8").trim().split("\n");
    try {
      expect(await stopLeftoverJobScopes({ ...base, FAKE_ACTIVE: "0" })).toBe(false);
      expect(calls()).toEqual([`--user is-active --quiet ${slice}`]);

      // The startup probe created the slice, but it holds no scope: stopping it
      // on every clean start logged a false leftover warning.
      expect(await stopLeftoverJobScopes({ ...base, FAKE_ACTIVE: "1", FAKE_SCOPES: "0" })).toBe(
        false,
      );
      expect(calls().at(-1)).toContain("--user list-units");
      expect(calls().some((call) => call.includes("--user stop"))).toBe(false);

      expect(await stopLeftoverJobScopes({ ...base, FAKE_ACTIVE: "1", FAKE_SCOPES: "1" })).toBe(
        true,
      );
      expect(calls().at(-1)).toBe(`--user stop ${slice}`);
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
if [ "$1" = "--version" ]; then
  echo "systemd 252"
  exit 0
fi
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

  test("only the shim marker reports a memory-limit hit, not the exit status", () => {
    const plan = {
      mechanism: "systemd-scope" as const,
      limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
    };
    // A service-manager/drain SIGTERM reaches the child as exit 143.
    expect(jobMemorySpawn("/bin/echo", ["drain"], {}, plan).onClose(143)).toEqual({
      exceeded: false,
    });
    // A bare SIGKILL (operator `kill -9`, manager SIGKILL, drain) is not proof
    // of hitting the cap: it must not rewrite a real failure as a memory hit.
    expect(jobMemorySpawn("/bin/echo", ["killed"], {}, plan).onClose(137)).toEqual({
      exceeded: false,
      possibleKill: true,
    });
    expect(jobMemorySpawn("/bin/echo", ["lost"], {}, plan).onClose(null)).toEqual({
      exceeded: false,
      possibleKill: true,
    });
    // The shim's marker (written from the scope's `oom_kill` counter) is proof.
    const marked = jobMemorySpawn("/bin/echo", ["oom"], {}, plan);
    writeFileSync(marked.env[JOB_MEMORY_MARKER_ENV] ?? "", "1\n");
    expect(marked.onClose(1)).toEqual({ exceeded: true, label: "512 MB" });
    expect(jobMemorySpawn("/bin/echo", ["oom-ok"], {}, plan).onClose(0)).toEqual({
      exceeded: false,
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

      // The unwrapped rerun must not inherit the scope markers: the child would
      // otherwise read the launcher's own cgroup and blame an unrelated OOM on
      // a cap that was never applied.
      const unwrapped = jobMemorySpawn(
        "/bin/sh",
        ["-c", 'printf "%s" "${DEVINTERN_JOB_MEMORY_LIMIT_LABEL-unset}"'],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        {
          mechanism: "systemd-scope",
          limit: { maxBytes: 512 * 1024 ** 2, label: "512 MB" },
        },
      );
      const clean = spawnSync(unwrapped.command, unwrapped.args, {
        encoding: "utf8",
        env: unwrapped.env,
        timeout: 30_000,
      });
      expect(clean.stdout).toBe("unset");
      expect(unwrapped.onClose(0)).toEqual({ exceeded: false });
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

describe("systemd scope probe", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetJobMemorySupportForTests();
    releaseJobScopeSliceForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A workspace whose configured cap is 1 GB, plus an empty fake-binary directory. */
  function hostWith(): {
    dir: string;
    binDir: string;
    workspaceDir: string;
    logPath: string;
    env: Record<string, string | undefined>;
  } {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-probe-"));
    dirs.push(dir);
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "systemd-run.log");
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
    // The test runner pins the override; this test reads workspace.toml.
    delete env.DEVINTERN_JOB_MEMORY_MAX;
    return { dir, binDir, workspaceDir, logPath, env };
  }

  test("systemd < 236: probe rejects --collect, so no job starts a failing scope", async () => {
    // Stand-in for systemd < 236: the bare MemoryMax probe succeeds, but the
    // real job argv (which always adds --collect) is rejected.
    const { binDir, logPath, env } = hostWith();
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
for arg in "$@"; do
  [ "$arg" = "--" ] && break
  if [ "$arg" = "--collect" ]; then
    echo "systemd-run: unrecognized option '--collect'" >&2
    exit 1
  fi
done
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    resetJobMemorySupportForTests();
    const plan = await resolveJobMemoryPlanForStartup(env);
    expect(plan.mechanism).toBe("none");
    expect(plan.reason).toContain("systemd-run");

    // The spawn path trusts the cached result: the job runs unwrapped instead
    // of starting a scope the launcher would then rerun (the old loop).
    const spec = jobMemorySpawn("/bin/echo", ["old-systemd"], env);
    expect(spec.limited).toBe(false);
    expect(spec.systemdArgs).toBeUndefined();
    const run = spawnSync(spec.command, spec.args, { encoding: "utf8", env: spec.env });
    expect(run.stdout.trim()).toBe("old-systemd");
    expect(run.status).toBe(0);

    // The probe exercised the flag the host lacks rather than only MemoryMax.
    expect(readFileSync(logPath, "utf8").split("\n")[0]).toContain("--collect");
  });

  test("probe includes a claimed job slice, so a rejected one disables the cap", async () => {
    const { binDir, workspaceDir, logPath, env } = hostWith();
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
for arg in "$@"; do
  [ "$arg" = "--" ] && break
  case "$arg" in
    --slice=*) echo "systemd-run: cannot create slice" >&2; exit 1 ;;
  esac
done
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    claimJobScopeSlice(workspaceDir);
    resetJobMemorySupportForTests();
    const plan = await resolveJobMemoryPlanForStartup(env);
    expect(plan.mechanism).toBe("none");
    expect(plan.reason).toContain("systemd-run");
    expect(readFileSync(logPath, "utf8")).toContain(`--slice=${jobScopeSliceName(workspaceDir)}`);
  });

  test("worker startup probes its job slice before the lock claims it", async () => {
    const { binDir, workspaceDir, logPath, env } = hostWith();
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
for arg in "$@"; do
  [ "$arg" = "--" ] && break
  case "$arg" in
    --slice=*) echo "systemd-run: cannot create slice" >&2; exit 1 ;;
  esac
done
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    // The worker probes before `beforeAcquirersStart` claims the slice (the
    // lock is not held yet), so the probe must name the slice explicitly.
    // Before: it probed without a slice and cached "supported"; the first jobs
    // then failed their scope and ran unwrapped.
    releaseJobScopeSliceForTests();
    resetJobMemorySupportForTests();
    const plan = await resolveJobMemoryPlanForStartup(env, "worker");
    expect(plan.mechanism).toBe("none");
    expect(readFileSync(logPath, "utf8")).toContain(`--slice=${jobScopeSliceName(workspaceDir)}`);
  });

  test("a transient base probe failure still enables the cap", async () => {
    const { dir, binDir, logPath, env } = hostWith();
    const failuresPath = join(dir, "base-probe-failures");
    // The base probe is the first scope invocation. Fail it once, then let the
    // retry (and every optional probe) succeed: a single transient
    // systemd-run failure must not cache "unsupported" for the whole window.
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "systemd 258"
  exit 0
fi
printf '%s\\n' "$*" >> "${logPath}"
n=$(cat "${failuresPath}" 2>/dev/null || echo 0)
if [ "$n" -lt 1 ]; then
  echo $((n + 1)) > "${failuresPath}"
  echo "systemd-run: transient failure" >&2
  exit 1
fi
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    resetJobMemorySupportForTests();
    const plan = await resolveJobMemoryPlanForStartup(env);
    expect(plan.mechanism).toBe("systemd-scope");
    expect(plan.limit?.label).toBe("1 GB");
    expect(readFileSync(failuresPath, "utf8").trim()).toBe("1");

    // Before: the failed probe was cached as unsupported, so this was unwrapped.
    const spec = jobMemorySpawn("/bin/echo", ["after-transient"], env);
    expect(spec.limited).toBe(true);
    expect(spec.systemdArgs).toContain("MemoryMax=1073741824");
    expect(spec.onClose(0)).toEqual({ exceeded: false });
  });

  test("a transient expansion-flags probe failure keeps the flag on systemd 254+", async () => {
    const { dir, binDir, logPath, env } = hostWith();
    const failuresPath = join(dir, "expand-probe-failures");
    // Stand-in for systemd 258: the first two scopes with
    // --expand-environment=no fail transiently; the version probe still says
    // the flag exists and the job scope after them succeeds.
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "systemd 258"
  exit 0
fi
printf '%s\\n' "$*" >> "${logPath}"
case " $* " in
  *" --expand-environment=no "*)
    n=$(cat "${failuresPath}" 2>/dev/null || echo 0)
    if [ "$n" -lt 2 ]; then
      echo $((n + 1)) > "${failuresPath}"
      echo "systemd-run: transient failure" >&2
      exit 1
    fi
    ;;
esac
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    resetJobMemorySupportForTests();
    const plan = await resolveJobMemoryPlanForStartup(env);
    expect(plan.mechanism).toBe("systemd-scope");
    // Before: the failed probe was cached as "unsupported", so this was false
    // for five minutes and systemd 258 expanded ${VAR} in the job argv.
    expect(plan.noExpand).toBe(true);

    const value = "literal ${HOME} $HOME $$";
    const spec = jobMemorySpawn("/bin/echo", [value], env, plan);
    expect(spec.systemdArgs).toContain("--expand-environment=no");
    const run = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      env: spec.env,
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${value}\n`);
    expect(spec.onClose(0)).toEqual({ exceeded: false });
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

  test("keeps capping jobs after the probe cache window expires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-stale-"));
    dirs.push(dir);
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    // Stand-in for systemd-run: the support probe only needs a zero exit.
    writeFileSync(join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEVINTERN_WORKSPACE_DIR: dir,
      DEVINTERN_JOB_MEMORY_MAX: "1GB",
    };
    const realNow = Date.now;
    let offset = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    resetJobMemorySupportForTests();
    try {
      const plan = await resolveJobMemoryPlanForStartup(env);
      expect(plan.mechanism).toBe("systemd-scope");
      expect(plan.limit?.label).toBe("1 GB");

      // Every job after the 5-minute window used to spawn unwrapped: the stale
      // entry was dropped before the background re-probe could replace it.
      offset = 6 * 60_000;
      const spec = jobMemorySpawn("/bin/echo", ["after-cache-window"], env);
      expect(spec.limited).toBe(true);
      expect(spec.limit?.label).toBe("1 GB");
      expect(spec.systemdArgs).toContain("MemoryMax=1073741824");
      expect(spec.onClose(0)).toEqual({ exceeded: false });
    } finally {
      // Let the background re-probe settle before the module cache is reset.
      await primeJobMemorySupport(env);
      nowSpy.mockRestore();
    }
  });

  test("removes resolver temp files when the job is aborted or times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-resolve-cleanup-"));
    dirs.push(dir);
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "systemd-run"),
      `#!/bin/sh
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
    const fixture = join(dir, "hang.ts");
    writeFileSync(
      fixture,
      `process.on("SIGTERM", () => process.exit(0));\nawait new Promise(() => {});\n`,
    );
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      DEVINTERN_JOB_MEMORY_MAX: "1GB",
    };
    const plan = await resolveJobMemoryPlanForStartup(env);
    expect(plan.mechanism).toBe("systemd-scope");

    // The scoped spawn leaves `devintern-job-memory-<pid>-*` temp files; a
    // close path that returns before `job.onClose` used to leak the spec file.
    // Compare against a baseline because earlier tests in this process leave
    // their own specs behind (they only inspect the spawn spec).
    const leftovers = () =>
      readdirSync(tmpdir()).filter((name) =>
        name.startsWith(`devintern-job-memory-${process.pid}-`),
      );
    const newLeftovers = (before: Set<string>) => leftovers().filter((name) => !before.has(name));

    let baseline = new Set(leftovers());
    const controller = new AbortController();
    const aborted = runResolveConflictsViaCli("acme/widgets", 2, {
      entrypoint: fixture,
      outputStdio: "ignore",
      env,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    expect(await aborted).toEqual({ outcome: "failed", message: "resolver cancelled" });
    expect(newLeftovers(baseline)).toEqual([]);

    baseline = new Set(leftovers());
    const timedOut = await runResolveConflictsViaCli("acme/widgets", 3, {
      entrypoint: fixture,
      outputStdio: "ignore",
      env,
      timeoutMs: 200,
    });
    expect(timedOut).toEqual({
      outcome: "failed",
      message: "resolver timed out after 200ms",
    });
    expect(newLeftovers(baseline)).toEqual([]);
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
