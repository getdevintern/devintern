/**
 * Parsing and formatting for `[defaults].job_memory_max`.
 *
 * Kept free of workspace/state imports so the config parser can validate the
 * setting without a module cycle (`workspace/config.ts` → this file, and
 * `worker/job-memory.ts` → `workspace/config.ts`).
 *
 * Accepted values:
 * - `off`, `none`, `disabled`, or `0` — no per-job limit
 * - `50%` — a fraction of physical RAM
 * - `8GB`, `512MB`, `1.5G`, `8192MiB`, `1024K` — an absolute size (binary
 *   units: `GB` means GiB, 1024³ bytes)
 */

/** Fraction of physical RAM used when `job_memory_max` is unset. */
export const DEFAULT_JOB_MEMORY_FRACTION = 0.5;

/** A resolved per-job memory limit. */
export interface JobMemoryLimit {
  /** Limit in bytes, written to `memory.max` (and `MemoryMax=`). */
  maxBytes: number;
  /** Human-readable size, e.g. `8 GB`, used in run failure reasons. */
  label: string;
}

/** Raised for a malformed `job_memory_max` value. */
export class JobMemoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobMemoryConfigError";
  }
}

const OFF_VALUES = new Set(["off", "none", "disabled", "0"]);
const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;
const PERCENT_PATTERN = /^(\d+(?:\.\d+)?)\s*%$/;

/**
 * Parse a `job_memory_max` value.
 *
 * @param value - Raw setting; `undefined`, empty, or an off value disables it.
 * @param totalBytes - Physical RAM used to resolve `N%` (defaults to unknown).
 * @returns The resolved limit, or null when the limit is off.
 * @throws {JobMemoryConfigError} When the value is not a supported size.
 */
export function parseJobMemoryMax(
  value: string | undefined,
  totalBytes = Number.NaN,
): JobMemoryLimit | null {
  const raw = value?.trim() ?? "";
  if (!raw || OFF_VALUES.has(raw.toLowerCase())) return null;

  const percent = PERCENT_PATTERN.exec(raw);
  if (percent) {
    const fraction = Number(percent[1]) / 100;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new JobMemoryConfigError(
        `[defaults].job_memory_max must be between 1% and 100% or a size such as "8GB".`,
      );
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      throw new JobMemoryConfigError(
        `[defaults].job_memory_max cannot use a percentage when physical RAM is unknown.`,
      );
    }
    const maxBytes = Math.floor(totalBytes * fraction);
    return { maxBytes, label: formatByteLimit(maxBytes) };
  }

  const size = SIZE_PATTERN.exec(raw);
  const unit = size?.[2]?.toLowerCase();
  const multiplier = unit ? SIZE_UNITS[unit] : undefined;
  const amount = size ? Number(size[1]) : Number.NaN;
  if (!size || multiplier === undefined || !Number.isFinite(amount) || amount <= 0) {
    throw new JobMemoryConfigError(
      `[defaults].job_memory_max must be "off", a percentage such as "50%", or a size such as "8GB" or "512MB".`,
    );
  }
  const maxBytes = Math.round(amount * multiplier);
  return { maxBytes, label: formatByteLimit(maxBytes) };
}

/**
 * Resolve a raw setting the way the worker does, applying the default fraction
 * when the key is absent.
 *
 * @param value - Raw setting; `undefined` means the default fraction.
 * @param totalBytes - Memory budget used to resolve the default and percentages.
 * @param defaultFraction - Fraction used when the key is absent (the worker
 *   divides {@link DEFAULT_JOB_MEMORY_FRACTION} by its job slots plus the
 *   webhook surface's slot, so the whole fleet, not one job, stays near the
 *   default budget).
 * @returns The resolved limit, or null when explicitly turned off.
 */
export function resolveJobMemoryMax(
  value: string | undefined,
  totalBytes: number,
  defaultFraction: number = DEFAULT_JOB_MEMORY_FRACTION,
): JobMemoryLimit | null {
  if (value?.trim()) return parseJobMemoryMax(value, totalBytes);
  return parseJobMemoryMax(`${defaultFraction * 100}%`, totalBytes);
}

/**
 * Format bytes as a compact binary size (`8 GB`, `512 MB`, `1.5 GB`).
 *
 * @param bytes - Size in bytes.
 * @returns A label safe to put in run failure reasons.
 */
export function formatByteLimit(bytes: number): string {
  const units: Array<[number, string]> = [
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "KB"],
  ];
  for (const [size, suffix] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      const formatted = Number.isInteger(value)
        ? String(value)
        : value.toFixed(1).replace(/\.0$/, "");
      return `${formatted} ${suffix}`;
    }
  }
  return `${bytes} B`;
}

/**
 * Validate a `job_memory_max` value for the workspace parser.
 *
 * @param value - Raw setting, if present.
 * @returns A problem string for `[defaults].job_memory_max`, or undefined when valid.
 */
export function jobMemoryMaxProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    // A percentage only needs RAM at resolution time; any positive number works here.
    parseJobMemoryMax(value, 8 * 1024 ** 3);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
