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
 * releases never do; `--expand-environment=no` is passed wherever it exists,
 * so no release rewrites a `$` in a prompt or task argument. The flag is
 * probed, with a retry and the binary's version as a tie-breaker, because a
 * transient probe failure must never be mistaken for an old release.
 *
 * Detection: the shim runs the command in the foreground, then reads its own
 * scope's `memory.events`. A non-zero `oom_kill` count writes a marker file the
 * parent reads after the child exits; only that marker reports `exceeded`. A
 * bare 137/`null` exit (an operator `kill -9`, a manager SIGKILL, a drain) is
 * reported as `possibleKill` instead, because it does not prove the cap was
 * hit. Job children also read their own
 * scope's counter at agent boundaries (`jobMemoryOomSnapshot` /
 * `jobMemoryExceededSince`), so the run can record the specific reason even
 * when the agent, not the job CLI, was the process that got killed.
 *
 * The mechanism is chosen at runtime: Linux + a working `systemd-run --user`
 * user manager use scopes; everywhere else (macOS launchd, containers without
 * systemd, non-Linux) the worker keeps its previous unlimited behavior. The
 * support probe runs asynchronously at worker startup (and lazily on the first
 * job elsewhere) so a wedged user manager cannot block the worker. A stale
 * result is re-probed in the background but keeps capping jobs until a probe
 * actually fails, so a manager that disappears falls back to unlimited jobs
 * without an unwrapped gap every cache window. A scope that fails to start at
 * spawn time is retried unwrapped for that attempt and clears the cached
 * support, so the next job re-probes instead of failing for the rest of the
 * cache window. Job scopes
 * are not bound to the service unit: the worker drains running jobs first and
 * stops what is left after the grace period (binding stopped them immediately,
 * before the drain could finish). The lock-holding worker's jobs live in a
 * per-workspace slice instead (`jobScopeSliceArgs`), which the worker stops at
 * startup and the unit stops in `ExecStopPost=`, so a worker that was SIGKILLed
 * or crashed cannot leave jobs running unsupervised. `webhook serve` claims a
 * separate webhook slice and stops it when the process exits, for the same
 * reason. A detached dashboard retry stays out of any claimed slice (see
 * `JobMemorySpawnOptions`).
 */

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
import {
  probeNoExpand,
  probeNoExpandAsync,
  probeSystemdScope,
  probeSystemdScopeAsync,
  resetNoExpandProbeWarningForTests,
} from "./job-memory-probe";
import { OOM_SHIM, SCOPE_LAUNCHER } from "./job-memory-scripts";
import { jobScopeSliceArgs, jobScopeSliceName } from "./job-scope-slice";
import type { JobScopeSurface } from "./job-scope-slice";
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
  /**
   * True only when the job's scope recorded an OOM kill while it ran. A bare
   * 137/`null` exit is not proof of hitting the cap (an operator `kill -9`, a
   * manager SIGKILL, or a drain can produce it), so it sets
   * {@link possibleKill} instead.
   */
  exceeded: boolean;
  /** True when the child died by SIGKILL without the shim's OOM marker. */
  possibleKill?: boolean;
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

/** Options for {@link jobMemorySpawn}; `slice: false` keeps a detached retry out of the claimed slice. */
type JobMemorySpawnOptions = { slice?: boolean };

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
 * Probes the user manager with the argv a real job scope uses — `--collect`,
 * the claimed slice, `MemoryMax`, and the `/bin/sh` OOM-shim wrapper — so a
 * host that would reject a job's scope is rejected here instead of failing
 * every job. `OOMPolicy`, `MemorySwapMax`, and `--expand-environment` are
 * optional extras probed separately. Returns false on non-Linux hosts, in
 * containers without a user manager, and when `systemd-run` is missing. Both
 * success and failure are re-probed after {@link SCOPE_PROBE_RETRY_MS}, so a
 * user manager that starts, restarts, or goes away is picked up again instead
 * of being cached for the whole process.
 *
 * This synchronous probe is for explicit checks (tests, diagnostics). The job
 * spawn path uses the cached result and primes it asynchronously, so a wedged
 * user manager cannot block the worker's event loop.
 *
 * @param env - Environment the spawn will use (resolves the user bus and slice).
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

/** Memory limit the probe applies; any usable limit proves the property works. */
const PROBE_MEMORY_MAX = ["-p", "MemoryMax=67108864"] as const;

/**
 * The stable part of a job scope's argv, probed as one unit.
 *
 * `--collect` (systemd 236+) and the claimed slice are part of every real job
 * invocation, so a host that rejects them must fail the probe: probing only
 * `MemoryMax` would succeed, then every job would start a scope the launcher
 * reruns unwrapped, and each failure would clear the cache into another
 * successful probe (probe-success → failed scope → fallback, forever).
 *
 * The worker probes with the slice it will claim after it takes the workspace
 * lock (`surface`), because the startup probe runs before the lock. Without
 * that, a host that accepts a plain scope but rejects the slice would be
 * cached as supported and the first jobs would fail before the cache clears.
 * Other processes pass no surface and probe only the slice they already own.
 *
 * @param env - Environment resolving the workspace whose slice this process claimed.
 * @param surface - Slice this process will claim after its startup probe.
 * @returns `systemd-run` options every job scope receives.
 */
function probeBaseArgs(
  env: Record<string, string | undefined>,
  surface?: JobScopeSurface,
): string[] {
  const workspaceDir = resolveWorkspaceDir(env);
  return [
    "--collect",
    // Only when this process owns (or will own) the workspace's job slice;
    // standalone runs never claim one and must not fail the probe on a slice
    // they will not use.
    ...(surface
      ? [`--slice=${jobScopeSliceName(workspaceDir, surface)}`]
      : jobScopeSliceArgs(workspaceDir)),
    ...PROBE_MEMORY_MAX,
  ];
}

/** The base probe plus each optional extra, probed on its own. */
function probeArgvs(
  env: Record<string, string | undefined>,
  surface?: JobScopeSurface,
): {
  base: string[];
  oomPolicy: string[];
  swap: string[];
  noExpand: string[];
} {
  const base = probeBaseArgs(env, surface);
  return {
    base,
    oomPolicy: [...base, "-p", "OOMPolicy=continue"],
    swap: [...base, "-p", "MemorySwapMax=0"],
    noExpand: ["--expand-environment=no", ...base],
  };
}

function unsupported(probedAt: number): SystemdScopeSupport {
  return { available: false, memorySwap: false, oomPolicy: false, noExpand: false, probedAt };
}

const SCOPE_PROBE_RETRY_MS = 5 * 60_000;
let systemdScopeSupport: SystemdScopeSupport | undefined;
let probeInFlight: Promise<SystemdScopeSupport> | undefined;

/** Last successfully parsed workspace setting, reused when a live edit breaks. */
let lastGoodJobMemorySetting: { path: string; setting: JobMemorySetting } | undefined;
/** Deduplicates the warning for a config that keeps failing to parse. */
let configErrorWarned: string | undefined;

/**
 * The cached probe result, including one older than the refresh window.
 *
 * A stale result is still the last known truth: the spawn path keeps using it
 * while a background re-probe runs, so a long-running worker never spawns an
 * unwrapped job just because the refresh has not finished. Only a probe that
 * actually fails replaces the cache with "unavailable".
 */
function currentSystemdScopeSupport(): SystemdScopeSupport | undefined {
  return systemdScopeSupport;
}

/** Whether the cached result is old enough to re-probe in the background. */
function supportIsStale(support: SystemdScopeSupport): boolean {
  return Date.now() - support.probedAt >= SCOPE_PROBE_RETRY_MS;
}

/**
 * Probe the user manager without blocking the event loop and cache the result.
 *
 * Called once at worker startup (and lazily by the first job spawn in other
 * entry points). Concurrent callers share one probe.
 *
 * @param env - Environment the job spawn will use (resolves the user bus).
 * @param surface - Slice this process will claim after a startup probe.
 * @returns The probed support, cached for {@link SCOPE_PROBE_RETRY_MS}.
 */
export async function primeJobMemorySupport(
  env: Record<string, string | undefined> = process.env,
  surface?: JobScopeSurface,
): Promise<SystemdScopeSupport> {
  const cached = currentSystemdScopeSupport();
  if (cached !== undefined && !supportIsStale(cached)) return cached;
  if (probeInFlight !== undefined) return probeInFlight;

  probeInFlight = (async () => {
    const now = Date.now();
    if (process.platform !== "linux") return unsupported(now);
    const probeEnv = systemdProbeEnv(env);
    const argvs = probeArgvs(env, surface);
    const command = probeCommand();
    // Retry a transient `systemd-run` failure once before caching
    // "unsupported", the same way `probeNoExpand` absorbs one.
    if (!(await probeSystemdScopeAsync(argvs.base, probeEnv, command))) {
      if (!(await probeSystemdScopeAsync(argvs.base, probeEnv, command))) return unsupported(now);
    }
    const [oomPolicy, memorySwap, noExpand] = await Promise.all([
      probeSystemdScopeAsync(argvs.oomPolicy, probeEnv, command),
      probeSystemdScopeAsync(argvs.swap, probeEnv, command),
      probeNoExpandAsync(argvs.noExpand, probeEnv, command),
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
  resetNoExpandProbeWarningForTests();
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
  if (cached !== undefined && !supportIsStale(cached)) return cached;
  const now = Date.now();
  const probeEnv = systemdProbeEnv(env);
  const argvs = probeArgvs(env);
  if (process.platform !== "linux") {
    systemdScopeSupport = unsupported(now);
    return systemdScopeSupport;
  }
  const command = probeCommand();
  if (!probeSystemdScope(argvs.base, probeEnv, command)) {
    systemdScopeSupport = unsupported(now);
    return systemdScopeSupport;
  }
  systemdScopeSupport = {
    available: true,
    oomPolicy: probeSystemdScope(argvs.oomPolicy, probeEnv, command),
    memorySwap: probeSystemdScope(argvs.swap, probeEnv, command),
    noExpand: probeNoExpand(argvs.noExpand, probeEnv, command),
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
  const probeEnv: Record<string, string | undefined> = {
    ...env,
    ...userBusEnv({ env: env as NodeJS.ProcessEnv }),
  };
  // The probe runs the same shim a job does (see {@link probeCommand}); never
  // let it write a limited job child's in-progress markers, which would make
  // an empty probe look like a memory-limit hit.
  for (const name of [
    JOB_MEMORY_LABEL_ENV,
    JOB_MEMORY_MARKER_ENV,
    JOB_MEMORY_STARTED_ENV,
    JOB_MEMORY_FALLBACK_ENV,
  ]) {
    delete probeEnv[name];
  }
  return probeEnv;
}

/**
 * Command the probe runs inside the scope: the same `/bin/sh` + OOM shim
 * wrapper a job gets, so a host without `/bin/sh` (or one where the shim
 * cannot run) fails the probe instead of every job's scope.
 */
function probeCommand(): string[] {
  const shim = ensureOomShim();
  if (shim === undefined) return [process.execPath, "-e", ""];
  // The shim is probed without markers (see {@link systemdProbeEnv}); its own
  // empty command exits immediately.
  return ["/bin/sh", shim, process.execPath, "-e", ""];
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
 * @param surface - Slice the worker will claim after taking the workspace
 *   lock, probed up front so a host that rejects it never caches a successful
 *   plain-scope probe.
 * @returns The plan with a resolved limit or the reason it is disabled.
 */
export async function resolveJobMemoryPlanForStartup(
  env: Record<string, string | undefined> = process.env,
  surface?: JobScopeSurface,
): Promise<JobMemoryPlan> {
  const setting = resolveJobMemorySetting(env);
  if ("reason" in setting) return { mechanism: "none", reason: setting.reason };
  const support = await primeJobMemorySupport(env, surface);
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

/**
 * Job slots outside the worker's own `max_concurrency` that the default
 * budget must cover.
 *
 * `webhook serve` runs CI-fix, conflict-resolution, and auto-merge jobs through
 * a single-concurrency queue (`webhook/runtime.ts`), in a separate process
 * that reads the same `workspace.toml`. Scheduled automations and estimations
 * take a worker supervisor slot, so `max_concurrency` already counts them.
 * Reserving this one slot keeps a full worker and a concurrent webhook job at
 * the documented ~50% budget instead of 50% each.
 */
export const JOB_MEMORY_WEBHOOK_JOB_SLOTS = 1;

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
    // run at once (the worker's slots plus the webhook surface's single job) so
    // concurrent jobs do not each claim the full 50%.
    const jobs = Math.max(1, read.setting.maxConcurrency) + JOB_MEMORY_WEBHOOK_JOB_SLOTS;
    const defaultFraction = DEFAULT_JOB_MEMORY_FRACTION / jobs;
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
    return { mechanism: "none", reason: "systemd-run --user --scope cannot start a job scope" };
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
 * Plan for the spawn path: never probes synchronously.
 *
 * Before the first probe there is nothing to wrap, so that one spawn runs
 * unwrapped while the probe starts. After that the last known support is used
 * even when it is stale, with a background re-probe; a probe that fails
 * replaces the cache with "unavailable" and the following jobs run unwrapped.
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
  if (supportIsStale(support)) {
    // Refresh in the background while this job keeps the last known cap.
    void primeJobMemorySupport(env).catch(() => {
      // A failed probe is retried after the retry window.
    });
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
 * @param options - Spawn options (detached retries skip the claimed slice).
 * @returns The spawn spec and a close-time OOM check.
 */
export function jobMemorySpawn(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  plan: JobMemoryPlan = loadJobMemoryPlanCached(env),
  options: JobMemorySpawnOptions = {},
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
    // A detached retry opts out (options.slice === false) so the worker's
    // startup/ExecStopPost cleanup cannot stop a run meant to outlive it.
    ...(options.slice === false ? [] : jobScopeSliceArgs(resolveWorkspaceDir(env))),
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
          // Only the shim marker proves the cap was hit: it is written after
          // the command exits when the scope's `oom_kill` counter is non-zero.
          // systemd-oomd can terminate the whole scope instead, killing the
          // shim before it can read `memory.events`, but that exit status also
          // matches an operator `kill -9`, a manager SIGKILL, and a drain, so
          // it is recorded as merely possible instead of rewriting a real
          // result. Callers also check their own timeout/abort flags first.
          const marked = existsSync(marker);
          closed = marked
            ? { exceeded: true, label: limit.label }
            : exitCode === null || exitCode === 137
              ? { exceeded: false, possibleKill: true }
              : { exceeded: false };
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
