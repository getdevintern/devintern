import { CronExpressionParser } from "cron-parser";

import { parseAutomationInterval } from "./automation-config";

/**
 * One workspace `[[estimations]]` entry: a scheduled story-point sweep.
 *
 * Same schedule grammar as `[[automations]]`, but the job body is a single
 * `query` — the automation prompt pipeline is never used, and there is no
 * `repo` because estimation never touches a repository.
 */
export interface EstimationConfig {
  id: string;
  enabled: boolean;
  /** Tracker query selecting the tickets to estimate (same language as `--query`). */
  query: string;
  cron?: string;
  interval?: string;
  intervalMs?: number;
}

const ESTIMATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate and normalize workspace `[[estimations]]` tables, collecting every error. */
export function parseEstimationEntries(value: unknown): {
  estimations: EstimationConfig[];
  errors: string[];
} {
  const errors: string[] = [];
  const estimations: EstimationConfig[] = [];
  const ids = new Set<string>();
  if (value === undefined || value === null) return { estimations, errors };
  if (!Array.isArray(value)) {
    return { estimations, errors: ["[[estimations]] must be an array of tables."] };
  }

  for (const [index, raw] of value.entries()) {
    const label = `[[estimations]][${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${label} must be a table.`);
      continue;
    }
    const table = raw as Record<string, unknown>;
    const stringValue = (key: string): string | undefined => {
      const item = table[key];
      if (item === undefined || item === null) return undefined;
      if (typeof item !== "string" || !item.trim()) {
        errors.push(`${label}.${key} must be a non-empty string.`);
        return undefined;
      }
      return item.trim();
    };

    // Estimation is not an implement job: no prompt pipeline, no repository,
    // and no `kind` selector.
    for (const forbidden of ["prompt", "repo", "kind"] as const) {
      if (table[forbidden] !== undefined) errors.push(`${label}.${forbidden} is not supported.`);
    }

    const id = stringValue("id");
    if (!id) errors.push(`${label}.id is required.`);
    else if (!ESTIMATION_ID_PATTERN.test(id))
      errors.push(`${label}.id must contain only letters, digits, ".", "_", or "-".`);
    else if (ids.has(id)) errors.push(`Duplicate estimation id "${id}".`);
    else ids.add(id);

    const enabledValue = table.enabled;
    if (typeof enabledValue !== "boolean") errors.push(`${label}.enabled must be a boolean.`);
    const query = stringValue("query");
    if (!query) errors.push(`${label}.query is required.`);

    const cron = stringValue("cron");
    const interval = stringValue("interval");
    if (Boolean(cron) === Boolean(interval)) {
      errors.push(`${label} must set exactly one of cron or interval.`);
    }
    if (cron) {
      if (cron.split(/\s+/).length !== 5) {
        errors.push(`${label}.cron must be a five-field cron expression.`);
      } else {
        try {
          CronExpressionParser.parse(cron);
        } catch (error) {
          errors.push(`${label}.cron is invalid: ${(error as Error).message}`);
        }
      }
    }
    const intervalMs = interval ? parseAutomationInterval(interval) : undefined;
    if (interval && intervalMs === null) {
      errors.push(`${label}.interval must use a positive duration such as 15m, 6h, or 1d.`);
    }

    if (
      id &&
      typeof enabledValue === "boolean" &&
      query &&
      Boolean(cron) !== Boolean(interval) &&
      (!interval || intervalMs !== null)
    ) {
      estimations.push({
        id,
        enabled: enabledValue,
        query,
        cron,
        interval,
        intervalMs: intervalMs ?? undefined,
      });
    }
  }
  return { estimations, errors };
}
