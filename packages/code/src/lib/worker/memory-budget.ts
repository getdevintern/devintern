/**
 * Worker host-memory budget: the percentages of host RAM baked into the
 * generated systemd unit, and the absolute byte limits derived from them.
 *
 * The budget keeps a run of heavy agent jobs from exhausting the machine.
 * systemd charges the whole service cgroup (the worker, every run child, every
 * test runner, every browser an agent starts) against `MemoryMax`, so the
 * kernel reclaims or kills inside the worker's own cgroup instead of
 * systemd-oomd picking the user's browser. `MemoryHigh` throttles first;
 * `MemorySwapMax` stops an unbounded swap thrash.
 *
 * Percentages are of host RAM, read when the unit is generated, so the same
 * defaults suit a 16 GB laptop and a 64 GB workstation. They live in
 * `[workspace.execution]` (see `memoryHighPercent` etc. on
 * {@link WorkspaceExecutionSettings}); changing them requires re-running
 * `devintern worker service install` because the values are written into the
 * unit.
 */

/** Fill-in defaults for a worker service: throttle at 50%, cap at 65%, swap at 15%. */
export const DEFAULT_MEMORY_HIGH_PERCENT = 50;
export const DEFAULT_MEMORY_MAX_PERCENT = 65;
export const DEFAULT_MEMORY_SWAP_MAX_PERCENT = 15;

/** Percentage of host RAM for each systemd memory knob. */
export interface MemoryBudgetPercentages {
  /** `MemoryHigh=`: throttle the cgroup above this share of host RAM. */
  highPercent: number;
  /** `MemoryMax=`: hard cap for the whole worker cgroup. */
  maxPercent: number;
  /** `MemorySwapMax=`: swap cap for the worker cgroup (`0` disables swap). */
  swapMaxPercent: number;
}

export const DEFAULT_MEMORY_BUDGET: MemoryBudgetPercentages = {
  highPercent: DEFAULT_MEMORY_HIGH_PERCENT,
  maxPercent: DEFAULT_MEMORY_MAX_PERCENT,
  swapMaxPercent: DEFAULT_MEMORY_SWAP_MAX_PERCENT,
};

/** Absolute byte limits derived from a host's RAM. */
export interface MemoryBudgetBytes {
  memoryHighBytes: number;
  memoryMaxBytes: number;
  memorySwapMaxBytes: number;
}

/**
 * Validate one budget from `workspace.toml`.
 *
 * `highPercent` must not exceed `maxPercent`: a throttle above the hard cap
 * would never trigger, and the resulting unit reads as a typo.
 *
 * @param budget - Percentages to check
 * @returns A human-readable problem, or null when the budget is usable
 */
export function validateMemoryBudget(budget: MemoryBudgetPercentages): string | null {
  const { highPercent, maxPercent, swapMaxPercent } = budget;
  if (!Number.isInteger(highPercent) || highPercent < 1 || highPercent > 100) {
    return "memory_high_percent must be an integer between 1 and 100.";
  }
  if (!Number.isInteger(maxPercent) || maxPercent < 1 || maxPercent > 100) {
    return "memory_max_percent must be an integer between 1 and 100.";
  }
  if (!Number.isInteger(swapMaxPercent) || swapMaxPercent < 0 || swapMaxPercent > 200) {
    return "memory_swap_max_percent must be an integer between 0 and 200.";
  }
  if (highPercent > maxPercent) {
    return "memory_high_percent cannot exceed memory_max_percent.";
  }
  return null;
}

/**
 * Turn percentages of host RAM into the byte values systemd reads.
 *
 * @param budget - Validated percentages
 * @param totalMemoryBytes - Host RAM in bytes (from `/proc/meminfo`)
 * @returns Absolute limits, rounded down to whole bytes
 */
export function memoryBudgetBytes(
  budget: MemoryBudgetPercentages,
  totalMemoryBytes: number,
): MemoryBudgetBytes {
  const total = Math.max(0, Math.floor(totalMemoryBytes));
  return {
    memoryHighBytes: Math.floor((total * budget.highPercent) / 100),
    memoryMaxBytes: Math.floor((total * budget.maxPercent) / 100),
    memorySwapMaxBytes: Math.floor((total * budget.swapMaxPercent) / 100),
  };
}
