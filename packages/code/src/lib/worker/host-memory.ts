/**
 * Host memory pressure for worker admission.
 *
 * The admission supervisor asks {@link createHostMemoryAdmission} before it
 * starts another job. Under pressure it defers new work instead of piling more
 * agent processes, test runners, and browsers onto a machine that is already
 * reclaiming or swapping. Running jobs are never interrupted: a single job
 * cannot be paused, and the systemd cgroup budget (see `memory-budget.ts`) is
 * the hard stop for a run that keeps growing.
 *
 * Two signals are used, both cheap reads:
 *
 * - host availability (`/proc/meminfo` `MemAvailable`), the same number
 *   `free -m` shows. It counts reclaimable page cache, so it does not
 *   over-report pressure from file cache.
 * - PSI memory pressure (`some avg10`), the share of the last ten seconds some
 *   task stalled on memory. A high value means the host is already under
 *   memory pressure even if some memory is still nominally free.
 *
 * When the worker itself runs in a memory-limited cgroup, its own anonymous
 * usage (`memory.stat` `anon`) against `memory.max` is checked as well: 85% of
 * the worker's own budget is a more direct signal than host-wide availability,
 * and it applies on a busy host where other apps are the reason free memory is
 * low. Page cache charged to the cgroup is excluded because it is reclaimable.
 *
 * Every reader is best-effort. A missing `/proc` file (macOS, a container
 * without cgroup v2) disables only that signal; no error ever reaches the
 * scheduler.
 */

import { readFileSync } from "fs";

/** Point-in-time memory reading used for an admission decision. */
export interface HostMemorySnapshot {
  /** Host RAM in bytes (`MemTotal`). */
  totalBytes: number;
  /** Memory available for new work without swapping (`MemAvailable`). */
  availableBytes: number;
  /** Linux PSI `some avg10` for memory, when available. */
  pressureSomeAvg10?: number;
  /** Worker cgroup anonymous memory, when the process runs under a cgroup limit. */
  cgroupUsedBytes?: number;
  /** Worker cgroup hard limit (`memory.max`), when it is not `max`. */
  cgroupMaxBytes?: number;
}

/** Injectable file reader, platform, and environment (tests). */
export interface HostMemoryDeps {
  readFile?: (path: string) => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Thresholds for {@link memoryAdmissionBlockReason}. */
export interface MemoryAdmissionLimits {
  /** Free memory must be at least this share of host RAM. Default 5%. */
  minAvailableShare?: number;
  /** Free memory must be at least this many bytes, whatever the share. Default 512 MiB. */
  minAvailableBytes?: number;
  /** Defer when PSI `some avg10` reaches this percentage. Default 50. */
  maxPressureSomeAvg10?: number;
  /** Defer when the worker cgroup uses this share of its `MemoryMax`. Default 85%. */
  cgroupMaxShare?: number;
}

const DEFAULT_MIN_AVAILABLE_SHARE = 0.05;
const DEFAULT_MIN_AVAILABLE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_PRESSURE_SOME_AVG10 = 50;
const DEFAULT_CGROUP_MAX_SHARE = 0.85;

function readUtf8(path: string, deps: HostMemoryDeps): string | null {
  try {
    return (deps.readFile ?? ((file) => readFileSync(file, "utf8")))(path);
  } catch {
    return null;
  }
}

/** Parse the two `/proc/meminfo` fields the admission gate needs. */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  let totalKb: number | undefined;
  let availableKb: number | undefined;
  for (const line of text.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (match[1] === "MemTotal") totalKb = value;
    else availableKb = value;
  }
  if (totalKb === undefined || availableKb === undefined) return null;
  return { totalBytes: totalKb * 1024, availableBytes: availableKb * 1024 };
}

/** Parse the `some avg10=` value of a PSI `memory` file. */
export function parsePsiSomeAvg10(text: string): number | undefined {
  const match = /^some\s+avg10=([\d.]+)/m.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The worker's own cgroup v2 usage and limit, or null when it is not limited.
 *
 * `/proc/self/cgroup` gives the path relative to the cgroup mount; the mount
 * point is `/sys/fs/cgroup` on every modern Linux distribution.
 *
 * Usage is anonymous memory (`memory.stat` `anon`) when available, not
 * `memory.current`: page cache charged to the cgroup is reclaimable and a
 * build-heavy worker would otherwise look full while it has plenty of
 * anonymous headroom.
 *
 * @param deps - Injectable reader (tests)
 */
export function readCgroupMemory(
  deps: HostMemoryDeps = {},
): { usedBytes: number; maxBytes: number } | null {
  const membership = readUtf8("/proc/self/cgroup", deps);
  if (!membership) return null;
  const unified = membership
    .split("\n")
    .map((line) => /^0::(.+)$/.exec(line)?.[1])
    .find((path): path is string => Boolean(path));
  if (!unified) return null;
  const base = `/sys/fs/cgroup${unified.replace(/\/$/, "")}`;
  const current = readUtf8(`${base}/memory.current`, deps)?.trim();
  const max = readUtf8(`${base}/memory.max`, deps)?.trim();
  if (!current || !max || max === "max") return null;
  const stats = readUtf8(`${base}/memory.stat`, deps);
  const anon = stats ? /^anon\s+(\d+)$/m.exec(stats)?.[1] : undefined;
  const usedBytes = Number(anon ?? current);
  const maxBytes = Number(max);
  if (!Number.isFinite(usedBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) return null;
  return { usedBytes, maxBytes };
}

/**
 * Host RAM in bytes from `/proc/meminfo`, or undefined when it cannot be read
 * (macOS, a platform without procfs).
 *
 * Used when generating the systemd unit: the percentages in `workspace.toml`
 * are converted to the absolute byte limits systemd stores in the unit.
 *
 * @param deps - Injectable reader and platform (tests)
 */
export function hostTotalMemoryBytes(deps: HostMemoryDeps = {}): number | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return undefined;
  const meminfo = readUtf8("/proc/meminfo", deps);
  if (!meminfo) return undefined;
  const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo)?.[1];
  if (!total) return undefined;
  const bytes = Number(total) * 1024;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

/**
 * Read the host and cgroup memory signals. Returns null when `/proc/meminfo`
 * is unavailable (macOS, or a platform without procfs).
 *
 * @param deps - Injectable reader, platform, and environment (tests)
 */
export function readHostMemorySnapshot(deps: HostMemoryDeps = {}): HostMemorySnapshot | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return null;
  const meminfo = readUtf8("/proc/meminfo", deps);
  if (!meminfo) return null;
  const parsed = parseMeminfo(meminfo);
  if (!parsed) return null;

  const psiText = readUtf8("/proc/pressure/memory", deps);
  const psi = psiText ? parsePsiSomeAvg10(psiText) : undefined;
  const cgroup = readCgroupMemory(deps);

  return {
    ...parsed,
    ...(psi !== undefined ? { pressureSomeAvg10: psi } : {}),
    ...(cgroup ? { cgroupUsedBytes: cgroup.usedBytes, cgroupMaxBytes: cgroup.maxBytes } : {}),
  };
}

/** One decimal place for log/queue messages, without trailing `.0`. */
function percent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/** Whole gigabytes for log/queue messages. */
function gib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

/**
 * Why the host cannot admit another job right now, or null when it can.
 *
 * The checks run in the order that gives the most actionable reason: the
 * worker's own cgroup budget first (it is the one the unit enforces), then
 * host availability, then PSI.
 *
 * @param snapshot - A reading from {@link readHostMemorySnapshot}
 * @param limits - Optional threshold overrides
 * @returns A short human-readable reason, or null when admission is fine
 */
export function memoryAdmissionBlockReason(
  snapshot: HostMemorySnapshot,
  limits: MemoryAdmissionLimits = {},
): string | null {
  const cgroupShare = limits.cgroupMaxShare ?? DEFAULT_CGROUP_MAX_SHARE;
  if (
    snapshot.cgroupUsedBytes !== undefined &&
    snapshot.cgroupMaxBytes !== undefined &&
    snapshot.cgroupUsedBytes >= snapshot.cgroupMaxBytes * cgroupShare
  ) {
    return (
      `the worker's own memory budget is ${percent(
        (snapshot.cgroupUsedBytes / snapshot.cgroupMaxBytes) * 100,
      )} full ` + `(${gib(snapshot.cgroupUsedBytes)} of ${gib(snapshot.cgroupMaxBytes)})`
    );
  }

  const share = limits.minAvailableShare ?? DEFAULT_MIN_AVAILABLE_SHARE;
  const floor = limits.minAvailableBytes ?? DEFAULT_MIN_AVAILABLE_BYTES;
  const required = Math.max(snapshot.totalBytes * share, floor);
  if (snapshot.availableBytes < required) {
    return `only ${gib(snapshot.availableBytes)} of host memory is available (need ${gib(required)})`;
  }

  const maxPressure = limits.maxPressureSomeAvg10 ?? DEFAULT_MAX_PRESSURE_SOME_AVG10;
  if (snapshot.pressureSomeAvg10 !== undefined && snapshot.pressureSomeAvg10 >= maxPressure) {
    return `the host is under memory pressure (PSI some avg10 ${percent(snapshot.pressureSomeAvg10)})`;
  }

  return null;
}

/**
 * Build the supervisor's admission probe. The returned function reads the
 * current snapshot on every call and never throws.
 *
 * `DEVINTERN_MEMORY_ADMISSION=0` disables the gate (foreground debugging or a
 * host whose `/proc` reporting is known to be misleading).
 *
 * @param options - Threshold overrides plus injectable reader/environment (tests)
 * @returns A function returning a reason when new work should wait
 */
export function createHostMemoryAdmission(
  options: MemoryAdmissionLimits & HostMemoryDeps = {},
): () => string | null {
  const env = options.env ?? process.env;
  if (env.DEVINTERN_MEMORY_ADMISSION === "0") return () => null;
  return () => {
    try {
      const snapshot = readHostMemorySnapshot(options);
      return snapshot ? memoryAdmissionBlockReason(snapshot, options) : null;
    } catch {
      // Admission must fail open: a broken reader must never idle the worker.
      return null;
    }
  };
}
