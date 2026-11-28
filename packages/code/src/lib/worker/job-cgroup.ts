/**
 * Per-job memory limits through the service unit's delegated cgroup.
 *
 * The installed systemd unit sets `Delegate=yes`, which hands the service
 * cgroup to the daemon. At startup the daemon moves itself into a leaf
 * (`devintern-daemon/`) and enables the memory controller for its children.
 * Each subprocess job then gets its own child cgroup with `memory.max`:
 *
 *     devintern-worker.service/     MemoryMax= budget (all jobs together)
 *     ├── devintern-daemon/         the worker itself
 *     ├── job-<pid>-1/              memory.max = per-job cap
 *     └── job-<pid>-2/
 *
 * A runaway job hits its own `memory.max`, so the kernel OOM killer picks a
 * process inside that job and the worker and other jobs stay up. Jobs stay
 * inside the service cgroup, so the service-wide budget (`memory-budget.ts`)
 * still bounds them in total, and systemd stops them with the unit as before.
 *
 * The job's process joins its cgroup before it execs: the spawn goes through
 * `/bin/sh -c 'echo $$ > <cgroup.procs>; exec "$@"'`, so there is no window in
 * which the job (or anything it forks) runs outside the limit.
 *
 * Without a delegated cgroup (macOS, a manually started worker, a unit
 * installed before this change, cgroup v1) jobs run unlimited, as before.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { WorkspaceExecutionSettings } from "../workspace/config-types";
// The daemon's leaf: cgroup v2 forbids processes in an inner node.
import { DAEMON_CGROUP_LEAF, hostTotalMemoryBytes } from "./host-memory";

/** Set by the generated unit next to `Delegate=yes`. */
export const DELEGATED_CGROUP_ENV = "DEVINTERN_DELEGATED_CGROUP";
/** Exported into a limited job: the cap's label (e.g. `2.6 GB`). */
export const JOB_MEMORY_LIMIT_ENV = "DEVINTERN_JOB_MEMORY_LIMIT";

const CGROUP_ROOT = "/sys/fs/cgroup";

/** Where the cgroup v2 hierarchy and this process's membership are read (tests). */
export interface JobCgroupDeps {
  cgroupRoot?: string;
  selfCgroupFile?: string;
  platform?: NodeJS.Platform;
}

interface EnabledJobCgroups {
  /** Absolute path of the delegated service cgroup. */
  root: string;
  limitBytes: number;
  label: string;
}

let enabled: EnabledJobCgroups | undefined;
let jobCounter = 0;
/** Job cgroups whose processes outlived the job CLI; removed once empty. */
const pendingRemoval = new Set<string>();

/** Format a byte count the way the cap is reported (`512 MB`, `2.6 GB`). */
export function formatJobMemoryLimit(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Number(gib.toFixed(1))} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * The per-job cap in percent of host RAM: the configured value, or by default
 * an equal share of the service's `MemoryMax` budget per concurrent job.
 *
 * @param execution - `[workspace.execution]` settings.
 * @returns A percentage; 0 means "no per-job cap".
 */
export function jobMemoryPercent(execution: {
  maxConcurrency: number;
  memory: { maxPercent: number };
  jobMemoryMaxPercent?: number;
}): number {
  if (execution.jobMemoryMaxPercent !== undefined) return execution.jobMemoryMaxPercent;
  return Math.max(
    1,
    Math.floor(execution.memory.maxPercent / Math.max(1, execution.maxConcurrency)),
  );
}

/** This process's cgroup v2 path (relative to the mount), if any. */
function ownCgroupPath(deps: JobCgroupDeps): string | undefined {
  try {
    const text = readFileSync(deps.selfCgroupFile ?? "/proc/self/cgroup", "utf8");
    return /^0::(.+)$/m.exec(text)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Turn on per-job cgroups for this process when its service cgroup is
 * delegated. Call once at startup, before any job is spawned.
 *
 * @param options - Cap in percent of host RAM, host RAM in bytes, environment.
 * @param deps - Injectable cgroup paths (tests).
 * @returns A one-line description of the effective cap for the startup log.
 */
export function enableJobCgroups(
  options: { percent: number; totalMemoryBytes: number | undefined; env?: NodeJS.ProcessEnv },
  deps: JobCgroupDeps = {},
): string {
  enabled = undefined;
  const env = options.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return "Job memory limit: not available on this platform";
  if (options.percent <= 0) return "Job memory limit: off (job_memory_max_percent = 0)";
  if (env[DELEGATED_CGROUP_ENV] !== "1") {
    return (
      "Job memory limit: off (needs the installed worker service; " +
      "run `devintern worker service install` to update an older unit)"
    );
  }
  if (!options.totalMemoryBytes) return "Job memory limit: off (host memory size unknown)";
  const relative = ownCgroupPath(deps);
  if (!relative) return "Job memory limit: off (no cgroup v2 membership)";

  const alreadyInLeaf = relative.endsWith(`/${DAEMON_CGROUP_LEAF}`);
  // Only the unit's main process owns the delegated cgroup; never a job
  // (or anything an agent started inside one).
  if (!alreadyInLeaf && !relative.endsWith(".service")) {
    return "Job memory limit: off (this process is not the service's main process)";
  }
  const cgroupRoot = deps.cgroupRoot ?? CGROUP_ROOT;
  const self = join(cgroupRoot, relative);
  const root = alreadyInLeaf ? dirname(self) : self;
  try {
    const controllers = readFileSync(join(root, "cgroup.controllers"), "utf8");
    if (!/\bmemory\b/.test(controllers)) {
      return "Job memory limit: off (the memory controller is not delegated to the service)";
    }
    if (!alreadyInLeaf) {
      const leaf = join(root, DAEMON_CGROUP_LEAF);
      mkdirSync(leaf, { recursive: true });
      // Move every process (the daemon and anything it already started) out
      // of the inner node; the kernel takes one PID per write.
      const pids = readFileSync(join(root, "cgroup.procs"), "utf8").split("\n").filter(Boolean);
      for (const pid of pids) writeFileSync(join(leaf, "cgroup.procs"), pid);
    }
    writeFileSync(join(root, "cgroup.subtree_control"), "+memory");
  } catch (error) {
    return `Job memory limit: off (could not set up the service cgroup: ${(error as Error).message})`;
  }
  const limitBytes = Math.floor((options.totalMemoryBytes * options.percent) / 100);
  enabled = { root, limitBytes, label: formatJobMemoryLimit(limitBytes) };
  return `Job memory limit: ${enabled.label} per job (${options.percent}% of host RAM)`;
}

/**
 * Startup entry point for the worker and `webhook serve`: resolve the cap from
 * `[workspace.execution]`, enable per-job cgroups, and log the result.
 *
 * @param execution - Workspace execution settings (defaults when no workspace).
 */
export function startJobCgroups(
  execution: Pick<WorkspaceExecutionSettings, "maxConcurrency" | "memory" | "jobMemoryMaxPercent">,
): void {
  console.log(
    `   ${enableJobCgroups({ percent: jobMemoryPercent(execution), totalMemoryBytes: hostTotalMemoryBytes() })}`,
  );
}

/** Forget the enabled state (tests). */
export function resetJobCgroupsForTests(): void {
  enabled = undefined;
  jobCounter = 0;
  pendingRemoval.clear();
}

/** What the parent learned when a job exited. */
export interface JobMemoryClose {
  /** The kernel OOM-killed a process in the job because it hit its cap. */
  exceeded: boolean;
  label?: string;
}

/** A job spawn, wrapped to join its own memory-limited cgroup when enabled. */
export interface JobMemorySpawn {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** Read the job's OOM counter and remove its cgroup. Safe to call twice. */
  onClose(): JobMemoryClose;
}

function removeCgroup(dir: string): boolean {
  try {
    rmdirSync(dir);
    return true;
  } catch (error) {
    // ENOENT: already gone. EBUSY: a detached descendant is still running.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function readOomKills(dir: string): number {
  try {
    const events = readFileSync(join(dir, "memory.events"), "utf8");
    return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Wrap a job subprocess so it runs in its own memory-limited cgroup.
 *
 * Unchanged command/args/env when per-job cgroups are not enabled, so every
 * caller works the same on hosts without them.
 *
 * @param command - Executable.
 * @param args - Its arguments.
 * @param env - Child environment.
 */
export function jobMemorySpawn(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): JobMemorySpawn {
  // A job never owns the service cgroup, even if an agent starts a worker in it.
  const { [DELEGATED_CGROUP_ENV]: _delegated, ...jobEnv } = env;
  const passthrough: JobMemorySpawn = {
    command,
    args: [...args],
    env: jobEnv,
    onClose: () => ({ exceeded: false }),
  };
  if (!enabled) return passthrough;
  for (const dir of pendingRemoval) if (removeCgroup(dir)) pendingRemoval.delete(dir);

  const { label, limitBytes } = enabled;
  const dir = join(enabled.root, `job-${process.pid}-${++jobCounter}`);
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, "memory.max"), String(limitBytes));
  } catch (error) {
    removeCgroup(dir);
    console.warn(
      `⚠️  Job memory limit: could not create a job cgroup (${(error as Error).message}); running without the cap`,
    );
    return passthrough;
  }
  // Swap counts against the cap only where swap accounting exists.
  if (existsSync(join(dir, "memory.swap.max"))) {
    try {
      writeFileSync(join(dir, "memory.swap.max"), "0");
    } catch {
      // RAM-only cap.
    }
  }
  let closed: JobMemoryClose | undefined;
  return {
    command: "/bin/sh",
    // `$0` is the job's cgroup.procs; if joining fails, the job runs uncapped
    // and must not read the daemon's counter as its own.
    args: [
      "-c",
      `echo $$ > "$0" 2>/dev/null || unset ${JOB_MEMORY_LIMIT_ENV}; exec "$@"`,
      join(dir, "cgroup.procs"),
      command,
      ...args,
    ],
    env: { ...jobEnv, [JOB_MEMORY_LIMIT_ENV]: label },
    onClose: () => {
      if (closed) return closed;
      closed = readOomKills(dir) > 0 ? { exceeded: true, label } : { exceeded: false };
      if (!removeCgroup(dir)) pendingRemoval.add(dir);
      return closed;
    },
  };
}

/**
 * The run failure reason for a job that hit its cap.
 *
 * @param label - Cap label; defaults to the one the parent exported.
 */
export function jobMemoryLimitReason(
  label: string | undefined = process.env[JOB_MEMORY_LIMIT_ENV],
): string {
  return `agent exceeded the job memory limit${label ? ` (${label})` : ""}`;
}

/**
 * Inside a job: this cgroup's OOM-kill counter, captured before an agent
 * starts. Undefined outside a limited job.
 */
export function jobMemoryOomSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  deps: JobCgroupDeps = {},
): number | undefined {
  if (!env[JOB_MEMORY_LIMIT_ENV]) return undefined;
  const relative = ownCgroupPath(deps);
  if (!relative) return undefined;
  return readOomKills(join(deps.cgroupRoot ?? CGROUP_ROOT, relative));
}

/**
 * Inside a job: whether the kernel OOM-killed something in this job since
 * {@link jobMemoryOomSnapshot}.
 */
export function jobMemoryExceededSince(
  snapshot: number | undefined,
  deps: JobCgroupDeps = {},
): boolean {
  if (snapshot === undefined) return false;
  const relative = ownCgroupPath(deps);
  if (!relative) return false;
  return readOomKills(join(deps.cgroupRoot ?? CGROUP_ROOT, relative)) > snapshot;
}
