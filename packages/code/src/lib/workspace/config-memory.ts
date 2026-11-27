/**
 * `[workspace.execution]` host-memory budget parsing.
 *
 * Split out of `config.ts` because the parser is right at its file-length
 * budget and these keys are self-contained. The `[workspace.execution]`
 * values are percentages of host RAM written into the generated systemd unit;
 * see `worker/memory-budget.ts`. `[defaults].job_memory_max` is the per-job
 * scope cap; see `worker/job-memory.ts`.
 */

import {
  DEFAULT_MEMORY_HIGH_PERCENT,
  DEFAULT_MEMORY_MAX_PERCENT,
  DEFAULT_MEMORY_SWAP_MAX_PERCENT,
  validateMemoryBudget,
} from "../worker/memory-budget";
import type { MemoryBudgetPercentages } from "../worker/memory-budget";
import { jobMemoryMaxProblem } from "../worker/job-memory-format";
import { readOptionalInteger, readString } from "./config-readers";

/**
 * Read and validate the memory percentages, defaulting each one that is
 * absent or malformed.
 *
 * @param table - The `[workspace.execution]` table
 * @param label - Table name used in error messages
 * @param errors - Accumulator for validation problems
 */
export function parseMemoryBudget(
  table: Record<string, unknown>,
  label: string,
  errors: string[],
): MemoryBudgetPercentages {
  const memory = {
    highPercent:
      readOptionalInteger(table, "memory_high_percent", label, errors, {
        min: 1,
        max: 100,
        message: `${label}.memory_high_percent must be an integer between 1 and 100.`,
      }) ?? DEFAULT_MEMORY_HIGH_PERCENT,
    maxPercent:
      readOptionalInteger(table, "memory_max_percent", label, errors, {
        min: 1,
        max: 100,
        message: `${label}.memory_max_percent must be an integer between 1 and 100.`,
      }) ?? DEFAULT_MEMORY_MAX_PERCENT,
    swapMaxPercent:
      readOptionalInteger(table, "memory_swap_max_percent", label, errors, {
        min: 0,
        max: 200,
        message: `${label}.memory_swap_max_percent must be an integer between 0 and 200.`,
      }) ?? DEFAULT_MEMORY_SWAP_MAX_PERCENT,
  };
  const problem = validateMemoryBudget(memory);
  if (problem) errors.push(`${label}.${problem}`);
  return memory;
}

/**
 * Read and validate `[defaults].job_memory_max`.
 *
 * @param table - The `[defaults]` table
 * @param errors - Accumulator for validation problems
 */
export function readJobMemoryMax(
  table: Record<string, unknown>,
  errors: string[],
): string | undefined {
  const value = readString(table, "job_memory_max", "[defaults]", errors);
  const problem = jobMemoryMaxProblem(value);
  if (problem) errors.push(problem);
  return value;
}
