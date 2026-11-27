/**
 * Per-job memory limits for worker subprocesses.
 *
 * A runaway agent (`bun test` growing past 40 GB in one checkout) must fail its
 * own job instead of pushing the whole `devintern-worker.service` cgroup over
 * systemd-oomd's pressure limit. Every job CLI child the worker spawns is
 * therefore wrapped in a transient systemd user scope:
 *
 *     systemd-run --user --scope [--expand-environment=no] \
 *       --slice=devintern-jobs-<hash>.slice -p MemoryMax=<limit> \
 *       [-p OOMPolicy=continue] [-p MemorySwapMax=0] \
 *       -- /bin/sh <oom shim> <command> <args…>
 *
 * The scope gives the whole job tree (the CLI child, its agent, and anything
 * the agent starts) its own cgroup and `memory.max`. The kernel OOM killer
 * then kills the offending processes inside that cgroup; the worker and every
 * other job stay up. `OOMPolicy=continue` keeps the scope (and therefore the
 * job CLI that records the outcome) alive when a descendant is killed; scopes
 * accept it only from systemd 253, and older scopes do not stop as a unit on
 * an OOM kill anyway, so it is probed and omitted there. Where the host
 * supports it, `MemorySwapMax=0` also keeps a runaway job from thrashing swap.
 *
 * Arguments are passed to systemd-run verbatim. systemd 258 expands `${VAR}`
 * in scope command lines by default, 254–257 do not unless asked, and older
 * releases never do; `--expand-environment=no` is probed and passed wherever
 * it exists, so no release rewrites a `$` in a prompt or task argument.
 *
 * Detection: the shim runs the command in the foreground, then reads its own
 * scope's `memory.events`. A non-zero `oom_kill` count writes a marker file the
 * parent reads after the child exits. Job children also read their own
 * scope's counter at agent boundaries (`jobMemoryOomSnapshot` /
 * `jobMemoryExceededSince`), so the run can record the specific reason even
 * when the agent, not the job CLI, was the process that got killed.
 *
 * The mechanism is chosen at runtime: Linux + a working `systemd-run --user`
 * user manager use scopes; everywhere else (macOS launchd, containers without
 * systemd, non-Linux) the worker keeps its previous unlimited behavior. The
 * support probe runs asynchronously at worker startup (and lazily on the first
 * job elsewhere) so a wedged user manager cannot block the worker, and both
 * success and failure are re-probed, so a manager that disappears falls back
 * to unlimited jobs. A scope that fails to start at spawn time is retried
 * unwrapped for that attempt and clears the cached support, so the next job
 * re-probes instead of failing for the rest of the cache window. Job scopes
 * are not bound to the service unit: the worker drains running jobs first and
 * stops what is left after the grace period (binding stopped them immediately,
 * before the drain could finish). The lock-holding worker's jobs live in a
 * per-workspace slice instead (`jobScopeSliceArgs`), which the worker stops at
 * startup and the unit stops in `ExecStopPost=`, so a worker that was SIGKILLed
 * or crashed cannot leave jobs running unsupervised.
 */

import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir, totalmem } from "os";
import { dirname, join } from "path";

import { DEFAULT_MAX_CONCURRENCY, loadWorkspaceConfig } from "../workspace/config";
import { resolveWorkspaceDir, workspaceConfigPath } from "../workspace/paths";
import {
  DEFAULT_JOB_MEMORY_FRACTION,
  JobMemoryConfigError,
  resolveJobMemoryMax,
} from "./job-memory-format";
import type { JobMemoryLimit } from "./job-memory-format";
import { jobScopeSliceArgs } from "./job-scope-slice";
import { userBusEnv } from "./service";

export type { JobMemoryLimit } from "./job-memory-format";
export {
  DEFAULT_JOB_MEMORY_FRACTION,
  formatByteLimit,
  JobMemoryConfigError,
  jobMemoryMaxProblem,
  parseJobMemoryMax,
  resolveJobMemoryMax,
} from "./job-memory-format";

/** Environment variable carrying the resolved size label into the job child. */
export const JOB_MEMORY_LABEL_ENV = "DEVINTERN_JOB_MEMORY_LIMIT_LABEL";
/** Environment variable carrying the scope OOM marker path into the job child. */
export const JOB_MEMORY_MARKER_ENV = "DEVINTERN_JOB_MEMORY_MARKER";
/** Environment variable carrying the "scope command started" marker path. */
export const JOB_MEMORY_STARTED_ENV = "DEVINTERN_JOB_MEMORY_STARTED";
/** Environment variable carrying the "ran without a scope" fallback marker path. */
export const JOB_MEMORY_FALLBACK_ENV = "DEVINTERN_JOB_MEMORY_FALLBACK";
/** Environment override for the workspace setting (troubleshooting/tests). */
export const JOB_MEMORY_MAX_ENV = "DEVINTERN_JOB_MEMORY_MAX";

/** How a job's memory is contained, if at all. */
export type JobMemoryMechanism = "systemd-scope" | "none";

/** Resolution of the workspace setting plus the available mechanism. */
export interface JobMemoryPlan {
  /** Applied limit; absent when the plan does not limit anything. */
  limit?: JobMemoryLimit;
  mechanism: JobMemoryMechanism;
  /** Why no limit is applied (logging/diagnostics). */
  reason?: string;
  /** Whether the scope also forbids swap (defaults to the probed support). */
  swap?: boolean;
  /**
   * Whether the scope accepts `OOMPolicy=continue` (systemd 253+). Defaults to
   * the probed support, or true when unprobed: an unsupported property fails
   * the scope start, which reruns the job unwrapped and re-probes.
   */
  oomPolicy?: boolean;
  /**
   * Whether systemd-run accepts `--expand-environment=no` (systemd 254+).
   * Defaults to the probed support, or true when unprobed, for the same
   * reason: failing loudly into the fallback beats a rewritten argument.
   */
  noExpand?: boolean;
}

/** What the parent learned after the job child exited. */
export interface JobMemoryClose {
  exceeded: boolean;
  label?: string;
}

/** A wrapped spawn: command/argv/env plus the close-time OOM check. */
export interface JobMemorySpawn {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** True when the process runs inside a memory-limited scope. */
  limited: boolean;
  /** The applied limit, when limited. */
  limit?: JobMemoryLimit;
  /** The `systemd-run` argv the launcher invokes (tests and diagnostics). */
  systemdArgs?: string[];
  /** Read the scope's OOM marker (or kill signal) exactly once. */
  onClose(exitCode: number | null): JobMemoryClose;
}

/**
 * Shim script run inside the scope. It is written to a file rather than passed
 * through `systemd-run`'s argv: systemd expands `$VAR` / `${VAR}` in ExecStart
 * arguments, which would mangle the shell variables below.
 *
 * The command runs in the foreground so it keeps the parent's stdio (including
 * the `DEVINTERN_RESULT_FD` channel) and stdin. After it exits, the shim reads
 * the scope's `memory.events`; the counter survives until the scope is
 * unloaded, which happens after the shim exits, so this read is not racy.
 */
const OOM_SHIM = `#!/bin/sh
# Tell the launcher that the scope command actually started. Without this
# marker a systemd-run failure before exec is retried unwrapped instead of
# being mistaken for the job's own exit status.
[ -n "$DEVINTERN_JOB_MEMORY_STARTED" ] && printf '1\\n' > "$DEVINTERN_JOB_MEMORY_STARTED" 2>/dev/null
# Scope teardown sends SIGTERM as soon as the runaway is killed; catch it so
# this process can read the scope's OOM counter before the cgroup disappears.
# (A caught trap, not an ignored signal, so the command keeps the default
# SIGTERM disposition and the worker's drain still stops it gracefully.)
trap ':' TERM
"$@"
status=$?
cg=$(cat /proc/self/cgroup 2>/dev/null)
cg=\${cg#0::}
if grep -Eq '^oom_kill [1-9][0-9]*$' "/sys/fs/cgroup\${cg}/memory.events" 2>/dev/null; then
  printf '1\\n' > "$DEVINTERN_JOB_MEMORY_MARKER" 2>/dev/null
fi
exit "$status"
`;

/**
 * Launcher around `systemd-run` that retries the command unwrapped when the
 * scope never starts.
 *
 * `systemd-run --user --scope` can fail before exec (a restarted user manager,
 * a bad `XDG_RUNTIME_DIR`, a bad property). Treating that exit status as the
 * job's own result would fail every job while the 5-minute support cache still
 * said scopes work. The shim writes a started marker as its first action; if
 * it is absent after a non-zero `systemd-run` exit, the scope never ran the
 * command, so this reruns it without a limit for this attempt.
 *
 * A file-based argv keeps prompts byte-for-byte intact (no shell quoting in
 * the fallback path).
 */
const SCOPE_LAUNCHER = `const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const signals = require("node:os").constants.signals;
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));

function stdio() {
  return ["inherit", "inherit", "inherit", process.env.DEVINTERN_RESULT_FD ? "inherit" : "ignore"];
}

function exitFor(code, signal) {
  process.exit(code === null ? 128 + (signals[signal] || 0) : code);
}

function start(command, args, onDone) {
  let child;
  let settled = false;
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    onDone(code, signal, error);
  };
  try {
    child = spawn(command, args, { stdio: stdio() });
  } catch (error) {
    finish(null, null, error);
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child may already have exited.
      }
    });
  }
  child.on("error", (error) => finish(null, null, error));
  child.on("close", (code, signal) => finish(code, signal, null));
}

function runUnwrapped() {
  writeFileSync(spec.fallback, "1\\n");
  start(spec.command, spec.args, (code, signal, error) => {
    if (error) process.exit(127);
    exitFor(code, signal);
  });
}

start(spec.systemd[0], spec.systemd.slice(1), (code, signal, error) => {
  if (error) {
    runUnwrapped();
    return;
  }
  // A signal means the worker is draining (or killing) the job; never rerun it.
  if (signal === null && code !== 0 && !existsSync(spec.started)) {
    runUnwrapped();
    return;
  }
  exitFor(code, signal);
});
`;

let spawnCounter = 0;
let oomShimPath: string | undefined;
let oomLauncherPath: string | undefined;
let oomShimDir: string | undefined;

/**
 * Write and return the OOM shim and scope launcher scripts, or undefined.
 * Rewritten if a temp cleaner (systemd-tmpfiles) removed them under an idle
 * worker: every job would otherwise die with "Module not found" before the
 * launcher's fallback runs. They live in a private (0700) `mkdtemp` dir, not a
 * predictable path a local user could pre-plant with a symlink.
 */
function ensureOomShim(): string | undefined {
  if (oomShimPath !== undefined && existsSync(oomShimPath) && existsSync(oomLauncherPath ?? "")) {
    return oomShimPath;
  }
  removeOomShimDir();
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "devintern-job-memory-"));
    const path = join(dir, "oom-shim.sh");
    const launcher = join(dir, "scope-launcher.cjs");
    // `wx` refuses to follow a pre-existing path (including a symlink).
    writeFileSync(path, OOM_SHIM, { encoding: "utf8", mode: 0o700, flag: "wx" });
    writeFileSync(launcher, SCOPE_LAUNCHER, { encoding: "utf8", mode: 0o600, flag: "wx" });
    oomShimPath = path;
    oomLauncherPath = launcher;
    oomShimDir = dir;
    process.once("exit", () => removeOomShimDir());
  } catch {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
    // A read-only tmpdir still allows the plain scope wrapper below; the
    // marker simply never appears, so the parent falls back to exit status.
    return undefined;
  }
  return oomShimPath;
}

function removeOomShimDir(): void {
  if (oomShimDir === undefined) return;
  try {
    rmSync(oomShimDir, { recursive: true, force: true });
  } catch {
    // Best effort: leftover temp state under the OS tmpdir is harmless.
  }
  oomShimDir = undefined;
  oomShimPath = undefined;
  oomLauncherPath = undefined;
}

/**
 * Whether `systemd-run --user --scope` can apply a memory limit on this host.
 *
 * Probes the user manager with `MemoryMax` alone on a transient scope;
 * `OOMPolicy`, `MemorySwapMax`, and `--expand-environment` are optional extras
 * probed separately. Returns false on non-Linux hosts, in containers without a user
 * manager, and when `systemd-run` is missing. Both success and failure are
 * re-probed after {@link SCOPE_PROBE_RETRY_MS}, so a user manager that starts,
 * restarts, or goes away is picked up again instead of being cached for the
 * whole process.
 *
 * This synchronous probe is for explicit checks (tests, diagnostics). The job
 * spawn path uses the cached result and primes it asynchronously, so a wedged
 * user manager cannot block the worker's event loop.
 *
 * @param env - Environment the spawn will use (resolves the user bus).
 */
export function systemdScopeAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readSystemdScopeSupport(env).available;
}

/**
 * Whether this host also accepts `MemorySwapMax=0` on the job scope.
 *
 * Probed separately from {@link systemdScopeAvailable}: hosts without swap
 * accounting still get a RAM-only `MemoryMax` cap instead of no cap at all.
 */
export function systemdScopeSwapLimitable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readSystemdScopeSupport(env).memorySwap;
}

interface SystemdScopeSupport {
  available: boolean;
  memorySwap: boolean;
  /** Scope accepts `OOMPolicy=continue` (systemd 253+). */
  oomPolicy: boolean;
  /** systemd-run accepts `--expand-environment=no` (systemd 254+). */
  noExpand: boolean;
  probedAt: number;
}

/** Base probe: the only property a usable job scope needs. */
const PROBE_BASE = ["-p", "MemoryMax=67108864"] as const;
/** Optional extras, each probed on its own so a missing one never disables the cap. */
const PROBE_OOM_POLICY = [...PROBE_BASE, "-p", "OOMPolicy=continue"] as const;
const PROBE_SWAP = [...PROBE_BASE, "-p", "MemorySwapMax=0"] as const;
const PROBE_NO_EXPAND = ["--expand-environment=no", ...PROBE_BASE] as const;

function unsupported(probedAt: number): SystemdScopeSupport {
  return { available: false, memorySwap: false, oomPolicy: false, noExpand: false, probedAt };
}

const SCOPE_PROBE_RETRY_MS = 5 * 60_000;
const SCOPE_PROBE_TIMEOUT_MS = 5_000;
let systemdScopeSupport: SystemdScopeSupport | undefined;
let probeInFlight: Promise<SystemdScopeSupport> | undefined;

/** Last successfully parsed workspace setting, reused when a live edit breaks. */
let lastGoodJobMemorySetting: { path: string; setting: JobMemorySetting } | undefined;
/** Deduplicates the warning for a config that keeps failing to parse. */
let configErrorWarned: string | undefined;

/** The cached probe result, or undefined once it is stale. */
function currentSystemdScopeSupport(): SystemdScopeSupport | undefined {
  if (systemdScopeSupport === undefined) return undefined;
  if (Date.now() - systemdScopeSupport.probedAt >= SCOPE_PROBE_RETRY_MS) {
    systemdScopeSupport = undefined;
    return undefined;
  }
  return systemdScopeSupport;
}

/**
 * Probe the user manager without blocking the event loop and cache the result.
 *
 * Called once at worker startup (and lazily by the first job spawn in other
 * entry points). Concurrent callers share one probe.
 *
 * @param env - Environment the job spawn will use (resolves the user bus).
 * @returns The probed support, cached for {@link SCOPE_PROBE_RETRY_MS}.
 */
export async function primeJobMemorySupport(
  env: Record<string, string | undefined> = process.env,
): Promise<SystemdScopeSupport> {
  const cached = currentSystemdScopeSupport();
  if (cached !== undefined) return cached;
  if (probeInFlight !== undefined) return probeInFlight;

  probeInFlight = (async () => {
    const now = Date.now();
    if (process.platform !== "linux") return unsupported(now);
    const probeEnv = systemdProbeEnv(env);
    if (!(await probeSystemdScopeAsync(PROBE_BASE, probeEnv))) return unsupported(now);
    const [oomPolicy, memorySwap, noExpand] = await Promise.all([
      probeSystemdScopeAsync(PROBE_OOM_POLICY, probeEnv),
      probeSystemdScopeAsync(PROBE_SWAP, probeEnv),
      probeSystemdScopeAsync(PROBE_NO_EXPAND, probeEnv),
    ]);
    return { available: true, memorySwap, oomPolicy, noExpand, probedAt: now };
  })().then(
    (support) => {
      systemdScopeSupport = support;
      probeInFlight = undefined;
      return support;
    },
    (error: unknown) => {
      probeInFlight = undefined;
      throw error;
    },
  );
  return probeInFlight;
}

/**
 * Clear the cached probe result (tests that simulate different hosts or a
 * user manager going away).
 */
export function resetJobMemorySupportForTests(): void {
  systemdScopeSupport = undefined;
  probeInFlight = undefined;
  lastGoodJobMemorySetting = undefined;
  configErrorWarned = undefined;
}

/**
 * Drop the cached support after a runtime scope failure, so the next job
 * re-probes instead of trusting a success that no longer holds.
 */
function invalidateSystemdScopeSupport(): void {
  systemdScopeSupport = undefined;
}

/** Synchronous probe used by explicit {@link systemdScopeAvailable} checks. */
function readSystemdScopeSupport(env: Record<string, string | undefined>): SystemdScopeSupport {
  const cached = currentSystemdScopeSupport();
  if (cached !== undefined) return cached;
  const now = Date.now();
  if (process.platform !== "linux" || !probeSystemdScope(PROBE_BASE, systemdProbeEnv(env))) {
    systemdScopeSupport = unsupported(now);
    return systemdScopeSupport;
  }
  const probeEnv = systemdProbeEnv(env);
  systemdScopeSupport = {
    available: true,
    oomPolicy: probeSystemdScope(PROBE_OOM_POLICY, probeEnv),
    memorySwap: probeSystemdScope(PROBE_SWAP, probeEnv),
    noExpand: probeSystemdScope(PROBE_NO_EXPAND, probeEnv),
    probedAt: now,
  };
  return systemdScopeSupport;
}

/**
 * Add the user bus variables a `systemd-run --user` invocation needs when the
 * caller's environment has neither. Job call sites build their own env (often
 * without a login session), so probing once from `process.env` and then
 * spawning with a stripped env made every job fail with "Failed to connect to
 * user scope bus".
 */
function systemdProbeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, ...userBusEnv({ env: env as NodeJS.ProcessEnv }) };
}

function probeSystemdScope(
  options: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  const probe = spawnSync(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--quiet",
      ...options,
      // `process.execPath` exists on every host, unlike `/bin/true` (absent
      // on NixOS). `-e ""` exits immediately without needing a script file.
      "--",
      process.execPath,
      "-e",
      "",
    ],
    { stdio: "ignore", timeout: SCOPE_PROBE_TIMEOUT_MS, env },
  );
  return probe.status === 0;
}

function probeSystemdScopeAsync(
  options: readonly string[],
  env: Record<string, string | undefined>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settled guards a single resolution.
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The probe may already have exited.
      }
      finish(false);
    }, SCOPE_PROBE_TIMEOUT_MS);
    try {
      child = spawn(
        "systemd-run",
        ["--user", "--scope", "--quiet", ...options, "--", process.execPath, "-e", ""],
        { stdio: "ignore", env },
      );
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Resolve the workspace's per-job memory limit and the mechanism to enforce it.
 *
 * Reading the config per spawn keeps a live-edited `[defaults].job_memory_max`
 * effective without a restart. A missing workspace config leaves jobs
 * unlimited (manual runs and tests that never set one up).
 *
 * This is the synchronous variant for explicit resolution (tests, diagnostics,
 * `worker doctor`): it may block on the `systemd-run` probe. The job spawn path
 * uses {@link loadJobMemoryPlanCached} so a wedged user manager cannot stall
 * the worker.
 *
 * @param env - Environment used for the override and the config location.
 * @returns The plan; `mechanism: "none"` with a reason when no limit applies.
 */
export function loadJobMemoryPlan(
  env: Record<string, string | undefined> = process.env,
): JobMemoryPlan {
  return buildJobMemoryPlan(env, readSystemdScopeSupport(env));
}

/**
 * Resolve the startup plan asynchronously, probing the user manager once.
 *
 * Used by the worker at startup so the effective cap (or why there is none) is
 * known and logged before the first job.
 *
 * @param env - Worker environment.
 * @returns The plan with a resolved limit or the reason it is disabled.
 */
export async function resolveJobMemoryPlanForStartup(
  env: Record<string, string | undefined> = process.env,
): Promise<JobMemoryPlan> {
  const setting = resolveJobMemorySetting(env);
  if ("reason" in setting) return { mechanism: "none", reason: setting.reason };
  const support = await primeJobMemorySupport(env);
  return planFromSupport(setting.limit, support);
}

/**
 * One-line description of a plan for startup logs and diagnostics.
 *
 * @param plan - Resolved plan.
 * @returns Human-readable effective limit or why it is disabled.
 */
export function describeJobMemoryPlan(plan: JobMemoryPlan): string {
  if (plan.mechanism === "systemd-scope" && plan.limit) {
    return `Job memory limit: ${plan.limit.label} per job (systemd scope${plan.swap ? ", swap disabled" : ""})`;
  }
  return `Job memory limit: disabled${plan.reason ? ` (${plan.reason})` : ""}`;
}

/** A resolved workspace setting plus the jobs expected to run together. */
interface JobMemorySetting {
  value: string | undefined;
  maxConcurrency: number;
}

/** Resolve the limit setting without probing the manager. */
function resolveJobMemorySetting(
  env: Record<string, string | undefined>,
): { limit: JobMemoryLimit } | { reason: string } {
  if (process.platform !== "linux") {
    return { reason: `no job memory limit on ${process.platform}` };
  }
  const read = readJobMemorySetting(env);
  if ("reason" in read) return { reason: read.reason };
  let limit: JobMemoryLimit | null;
  try {
    // The default is a fleet budget: divide it by the number of jobs that can
    // run at once so four concurrent jobs do not each claim the full 50%.
    const defaultFraction = DEFAULT_JOB_MEMORY_FRACTION / Math.max(1, read.setting.maxConcurrency);
    limit = resolveJobMemoryMax(read.setting.value, usableMemoryBytes(), defaultFraction);
  } catch (error) {
    return {
      reason: error instanceof JobMemoryConfigError ? error.message : String(error),
    };
  }
  if (limit === null) return { reason: "[defaults].job_memory_max is off" };
  return { limit };
}

function planFromSupport(limit: JobMemoryLimit, support: SystemdScopeSupport): JobMemoryPlan {
  if (!support.available) {
    return { mechanism: "none", reason: "systemd-run --user --scope is unavailable" };
  }
  return {
    mechanism: "systemd-scope",
    limit,
    swap: support.memorySwap,
    oomPolicy: support.oomPolicy,
    noExpand: support.noExpand,
  };
}

function buildJobMemoryPlan(
  env: Record<string, string | undefined>,
  support: SystemdScopeSupport | undefined,
): JobMemoryPlan {
  const setting = resolveJobMemorySetting(env);
  if ("reason" in setting) return { mechanism: "none", reason: setting.reason };
  if (support === undefined) {
    return { mechanism: "none", reason: "job memory support has not been probed" };
  }
  return planFromSupport(setting.limit, support);
}

/**
 * Plan for the spawn path: never probes synchronously, kicks off an async
 * probe when the cached result is missing or stale, and leaves that one spawn
 * unwrapped rather than blocking the worker for up to the probe timeout.
 */
function loadJobMemoryPlanCached(env: Record<string, string | undefined>): JobMemoryPlan {
  const setting = resolveJobMemorySetting(env);
  if ("reason" in setting) return { mechanism: "none", reason: setting.reason };
  const support = currentSystemdScopeSupport();
  if (support === undefined) {
    void primeJobMemorySupport(env).catch(() => {
      // A failed probe is retried after the retry window; the job still runs.
    });
    return { mechanism: "none", reason: "job memory support is being probed" };
  }
  return planFromSupport(setting.limit, support);
}

/**
 * Read the raw setting: an environment override wins, otherwise the workspace
 * config. A config that fails to parse keeps the last successfully loaded
 * setting so a live edit cannot silently drop the cap; when nothing was ever
 * loaded, the real parse error is reported instead of "no workspace.toml".
 */
function readJobMemorySetting(
  env: Record<string, string | undefined>,
): { setting: JobMemorySetting } | { reason: string } {
  const override = env[JOB_MEMORY_MAX_ENV];
  if (override !== undefined) {
    return {
      setting: { value: override, maxConcurrency: DEFAULT_MAX_CONCURRENCY },
    };
  }
  const configPath = workspaceConfigPath(env.DEVINTERN_WORKSPACE_DIR);
  if (!existsSync(configPath)) {
    return { reason: "no workspace.toml (job memory limit applies to workspace runs)" };
  }
  try {
    const config = loadWorkspaceConfig(configPath);
    const setting: JobMemorySetting = {
      value: config.defaults.jobMemoryMax,
      maxConcurrency: config.workspace.execution.maxConcurrency,
    };
    lastGoodJobMemorySetting = { path: configPath, setting };
    configErrorWarned = undefined;
    return { setting };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const good = lastGoodJobMemorySetting;
    if (good?.path === configPath) {
      warnConfigErrorOnce(configPath, message);
      return { setting: good.setting };
    }
    return { reason: `workspace.toml could not be read: ${message}` };
  }
}

function warnConfigErrorOnce(configPath: string, message: string): void {
  const key = `${configPath}\0${message}`;
  if (configErrorWarned === key) return;
  configErrorWarned = key;
  console.warn(`⚠️  Job memory limit: keeping the last valid workspace config (${message})`);
}

/**
 * Memory budget for percentages and the default: the smaller of physical RAM
 * and the nearest finite cgroup v2 limit. A container that runs systemd can
 * report host RAM through `os.totalmem()`, so a default of "50% of RAM" would
 * otherwise exceed the container's own cap.
 */
function usableMemoryBytes(): number {
  const physical = totalmem();
  const cgroup = cgroupMemoryLimit();
  return cgroup === undefined ? physical : Math.min(physical, cgroup);
}

/** The calling process's cgroup v2 path from `/proc/self/cgroup`, if any. */
function ownCgroupPath(): string | undefined {
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const match = /^0::(.+)$/m.exec(cgroup);
    return match?.[1].trim();
  } catch {
    return undefined;
  }
}

/**
 * The nearest finite `memory.max` at or above a cgroup v2 path.
 *
 * Walking ancestors is what catches a container limit: the worker's own
 * `memory.max` is often `max`, while the container's cgroup above it has the
 * real cap.
 *
 * @param cgroupRoot - cgroup v2 mount point (injectable for tests).
 * @param cgroupPath - Starting cgroup path; defaults to this process's.
 * @returns The smallest finite limit in bytes, or undefined when unlimited.
 */
export function cgroupMemoryLimit(
  cgroupRoot = "/sys/fs/cgroup",
  cgroupPath: string | undefined = ownCgroupPath(),
): number | undefined {
  if (cgroupPath === undefined) return undefined;
  let current = cgroupPath.startsWith("/") ? cgroupPath : `/${cgroupPath}`;
  let limit: number | undefined;
  for (;;) {
    try {
      const raw = readFileSync(join(cgroupRoot, current, "memory.max"), "utf8").trim();
      if (raw !== "" && raw !== "max") {
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) {
          limit = limit === undefined ? value : Math.min(limit, value);
        }
      }
    } catch {
      // No memory controller at this level; keep walking.
    }
    if (current === "/") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return limit;
}

/**
 * Wrap a job spawn in a memory-limited systemd scope.
 *
 * Without a limit the returned command/args/env are unchanged, so every call
 * site keeps working on macOS and host without a systemd user manager.
 *
 * @param command - Executable to run.
 * @param args - Its arguments.
 * @param env - Child environment (defaults to `process.env`).
 * @param plan - Pre-resolved plan (tests); defaults to the non-blocking cached plan.
 * @returns The spawn spec and a close-time OOM check.
 */
export function jobMemorySpawn(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  plan: JobMemoryPlan = loadJobMemoryPlanCached(env),
): JobMemorySpawn {
  const childArgs = [...args];
  if (!plan.limit || plan.mechanism !== "systemd-scope") {
    return {
      command,
      args: childArgs,
      env,
      limited: false,
      onClose: () => ({ exceeded: false }),
    };
  }

  const limit = plan.limit;
  // Never probe synchronously here: an explicit plan may omit `swap`, and the
  // cached probe is the only non-blocking source. A missing result keeps the
  // RAM-only cap instead of stalling the spawn.
  // An "unavailable" cache entry says nothing about the optional extras.
  const cached = currentSystemdScopeSupport();
  const support = cached?.available ? cached : undefined;
  const swap = plan.swap ?? support?.memorySwap ?? false;
  const oomPolicy = plan.oomPolicy ?? support?.oomPolicy ?? true;
  const noExpand = plan.noExpand ?? support?.noExpand ?? true;
  const spawnId = `${process.pid}-${spawnCounter++}-${randomUUID()}`;
  const base = join(tmpdir(), `devintern-job-memory-${spawnId}`);
  const marker = `${base}.marker`;
  const startedMarker = `${base}.started`;
  const fallbackMarker = `${base}.fallback`;
  const specFile = `${base}.json`;
  const cleanup = (): void => {
    for (const path of [marker, startedMarker, fallbackMarker, specFile]) {
      rmSync(path, { force: true });
    }
  };
  cleanup();
  const childEnv = {
    // Call sites build their own env, often without a login session, so add
    // the user bus here instead of relying on the worker's process.env (the
    // probe may have succeeded from process.env while the child env fails).
    ...env,
    ...userBusEnv({ env: env as NodeJS.ProcessEnv }),
    [JOB_MEMORY_LABEL_ENV]: limit.label,
    [JOB_MEMORY_MARKER_ENV]: marker,
    [JOB_MEMORY_STARTED_ENV]: startedMarker,
    [JOB_MEMORY_FALLBACK_ENV]: fallbackMarker,
  };
  let closed: JobMemoryClose | undefined;
  const shim = ensureOomShim();
  const commandArgs = shim ? ["/bin/sh", shim, command, ...childArgs] : [command, ...childArgs];
  const systemdArgs = [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    // Remove failed transient scopes instead of leaving one loaded unit per
    // failed (often OOM-killed) job in the user manager.
    "--collect",
    // Arguments go through verbatim: without this flag systemd 258+ expands
    // `${VAR}` in scope command lines (older releases never expand, so the
    // flag is only omitted where it does not exist and is not needed).
    ...(noExpand ? ["--expand-environment=no"] : []),
    // Lock-holding worker only; stopped after a hard kill (job-scope-cleanup.ts).
    ...jobScopeSliceArgs(resolveWorkspaceDir(env)),
    "-p",
    `MemoryMax=${limit.maxBytes}`,
    // Keep the rest of the scope alive when the kernel OOM killer picks a
    // descendant (the agent, or a test it started). Without this the scope
    // stops as a unit and the job CLI dies before it can record why. Scopes
    // before systemd 253 reject the property but also never stop on OOM.
    ...(oomPolicy ? ["-p", "OOMPolicy=continue"] : []),
    ...(swap ? ["-p", "MemorySwapMax=0"] : []),
    "--",
    ...commandArgs,
  ];
  let spawnCommand = "systemd-run";
  let spawnArgs = systemdArgs.slice(1);
  const launcher = oomLauncherPath;
  if (
    shim !== undefined &&
    launcher !== undefined &&
    markerWritable(startedMarker, fallbackMarker)
  ) {
    try {
      writeFileSync(
        specFile,
        JSON.stringify({
          started: startedMarker,
          fallback: fallbackMarker,
          systemd: systemdArgs,
          command,
          args: childArgs,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      spawnCommand = process.execPath;
      spawnArgs = [launcher, specFile];
    } catch {
      // Without a launcher spec the scope still runs; the job just loses the
      // one-attempt fallback and the start marker.
      cleanup();
    }
  }
  return {
    command: spawnCommand,
    args: spawnArgs,
    env: childEnv,
    limited: true,
    limit,
    systemdArgs,
    onClose: (exitCode) => {
      if (closed === undefined) {
        if (existsSync(fallbackMarker)) {
          // systemd-run never started the scope; the launcher already reran
          // the command unwrapped for this attempt.
          invalidateSystemdScopeSupport();
          console.warn(
            `⚠️  Job memory limit unavailable: systemd-run could not start the job scope; ` +
              `this job ran without the ${limit.label} cap`,
          );
          closed = { exceeded: false };
        } else {
          // The shim writes the marker when it survives the kill. systemd-oomd
          // can terminate the whole scope instead, killing the shim before it
          // reads `memory.events`; in that case the wrapper's own exit status
          // is the only signal. SIGTERM (143) is deliberately excluded: it is
          // the normal drain/shutdown signal, and reporting it as an OOM kill
          // rewrites real resolver results. Callers also check their own
          // timeout/abort flags first.
          const killed = exitCode === null || exitCode === 137;
          const exceeded = existsSync(marker) || killed;
          closed = exceeded ? { exceeded: true, label: limit.label } : { exceeded: false };
        }
        cleanup();
      }
      return closed;
    },
  };
}

/** Whether both marker files can be created, so fallback detection is reliable. */
function markerWritable(...paths: string[]): boolean {
  for (const path of paths) {
    try {
      writeFileSync(path, "", { mode: 0o600, flag: "wx" });
      rmSync(path, { force: true });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Snapshot the job scope's kernel OOM-kill counter before an agent starts.
 *
 * Returns undefined when this process is not a memory-limited job child (no
 * {@link JOB_MEMORY_LABEL_ENV} in the environment) or the cgroup cannot be
 * read, so manual runs and unsupported hosts keep their current behavior.
 *
 * @param env - Environment that carries the job-limit marker.
 * @returns The counter, or undefined when no job scope applies.
 */
export function jobMemoryOomSnapshot(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  if (!env[JOB_MEMORY_LABEL_ENV]) return undefined;
  return readOwnOomKills();
}

/**
 * Whether the job scope's OOM-kill counter advanced since {@link jobMemoryOomSnapshot}.
 *
 * @param snapshot - Counter captured before the agent spawn.
 * @returns True when the kernel OOM killer ran inside this job's cgroup.
 */
export function jobMemoryExceededSince(snapshot: number | undefined): boolean {
  if (snapshot === undefined) return false;
  const current = readOwnOomKills();
  return current !== undefined && current > snapshot;
}

/**
 * The memory-limit reason for a failed agent spawn, or undefined when the
 * failure was not caused by this job's cgroup.
 *
 * Every agent spawn inside a limited job can use this so an OOM is reported as
 * the limit rather than as a generic non-zero exit (which is retried).
 *
 * @param exitCode - Agent exit code; a zero exit is never a memory failure.
 * @param snapshot - Counter captured before the spawn.
 * @returns The failure reason, or undefined for a non-memory failure.
 */
export function jobMemoryExitReason(
  exitCode: number | null,
  snapshot: number | undefined,
): string | undefined {
  if (exitCode === 0 || snapshot === undefined) return undefined;
  return jobMemoryExceededSince(snapshot) ? jobMemoryLimitReason() : undefined;
}

/**
 * The failure reason recorded when a job hits its memory limit.
 *
 * @param label - Resolved size label; defaults to the one exported by the job parent.
 * @returns A single-line reason suitable for a run record or PR comment.
 */
export function jobMemoryLimitReason(
  label: string | undefined = process.env[JOB_MEMORY_LABEL_ENV],
): string {
  return `agent exceeded the job memory limit${label ? ` (${label})` : ""}`;
}

/** Read the calling process's cgroup-v2 `oom_kill` counter. */
function readOwnOomKills(): number | undefined {
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const match = /^0::(.+)$/m.exec(cgroup);
    if (!match) return undefined;
    const events = readFileSync(`/sys/fs/cgroup${match[1].trim()}/memory.events`, "utf8");
    const oom = /^oom_kill (\d+)$/m.exec(events);
    return oom ? Number(oom[1]) : 0;
  } catch {
    return undefined;
  }
}
