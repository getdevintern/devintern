import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { CronExpressionParser } from "cron-parser";

import { parseToml } from "../workspace/toml";

export interface AutomationConfig {
  id: string;
  enabled: boolean;
  prompt: string;
  cron?: string;
  interval?: string;
  intervalMs?: number;
  repo?: string;
  /**
   * Whether occurrences open a pull request. Opt-in and off by default:
   * omitting it (workspace `worker_task_args` included) never creates PRs.
   */
  openPr?: boolean;
}

/** A cron-or-interval schedule using the `[[automations]]` format. */
export interface CronOrIntervalSchedule {
  cron?: string;
  interval?: string;
  intervalMs?: number;
}

export const SINGLE_REPO_AUTOMATIONS_PATH = ".devintern-code/automations.toml";
const AUTOMATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DURATION_PATTERN = /^(\d+)([mhd])$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Parse a documented interval (`15m`, `6h`, or `1d`) into milliseconds. */
export function parseAutomationInterval(value: string, nowMs = Date.now()): number | null {
  const match = value.match(DURATION_PATTERN);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const intervalMs = amount * unitMs;
  const dueAt = nowMs + intervalMs;
  if (!Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(dueAt) || dueAt > MAX_DATE_MS) {
    return null;
  }
  return intervalMs;
}

/**
 * Validate a cron-or-interval schedule pair using the `[[automations]]`
 * rules: exactly one of the two keys must be set, cron must be a five-field
 * expression that parses, and interval must be a positive `15m`/`6h`/`1d`
 * duration. Every problem found is collected in `errors`.
 *
 * @param table - Raw key/value table holding the schedule keys
 * @param options - `label` for error messages; `cronKey` / `intervalKey`
 *                    rename the keys (messages always use the actual key names)
 * @returns The normalized schedule, or undefined when the pair is absent or
 *          invalid.
 */
export function parseCronOrIntervalSchedule(
  table: Record<string, unknown>,
  options: { label: string; cronKey?: string; intervalKey?: string },
  errors: string[],
): CronOrIntervalSchedule | undefined {
  const cronKey = options.cronKey ?? "cron";
  const intervalKey = options.intervalKey ?? "interval";
  const { label } = options;
  const readScheduleString = (key: string): string | undefined => {
    const item = table[key];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${label}.${key} must be a non-empty string.`);
      return undefined;
    }
    return item.trim();
  };

  const cron = readScheduleString(cronKey);
  const interval = readScheduleString(intervalKey);
  const pairInvalid = Boolean(cron) === Boolean(interval);
  if (pairInvalid) {
    errors.push(`${label} must set exactly one of ${cronKey} or ${intervalKey}.`);
  }

  let cronValid = true;
  if (cron) {
    if (cron.split(/\s+/).length !== 5) {
      errors.push(`${label}.${cronKey} must be a five-field cron expression.`);
      cronValid = false;
    } else {
      try {
        CronExpressionParser.parse(cron);
      } catch (error) {
        errors.push(`${label}.${cronKey} is invalid: ${(error as Error).message}`);
        cronValid = false;
      }
    }
  }

  const intervalMs = interval ? parseAutomationInterval(interval) : undefined;
  let intervalValid = true;
  if (interval && intervalMs === null) {
    errors.push(`${label}.${intervalKey} must use a positive duration such as 15m, 6h, or 1d.`);
    intervalValid = false;
  }

  if (pairInvalid || !cronValid || !intervalValid) return undefined;
  return { cron, interval, intervalMs: intervalMs ?? undefined };
}

/** First occurrence of a schedule strictly after `afterMs` (cron uses host timezone). */
export function nextScheduleOccurrence(schedule: CronOrIntervalSchedule, afterMs: number): number {
  if (schedule.intervalMs) return afterMs + schedule.intervalMs;
  if (!schedule.cron) throw new Error("Schedule has no cron expression");
  return CronExpressionParser.parse(schedule.cron, { currentDate: new Date(afterMs) })
    .next()
    .getTime();
}

/** Validate and normalize `[[automations]]` tables, collecting every error. */
export function parseAutomationEntries(
  value: unknown,
  options: { sourceLabel: string; repoNames?: Set<string> },
): { automations: AutomationConfig[]; errors: string[] } {
  const errors: string[] = [];
  const automations: AutomationConfig[] = [];
  const ids = new Set<string>();
  if (value === undefined || value === null) return { automations, errors };
  if (!Array.isArray(value)) {
    return { automations, errors: ["[[automations]] must be an array of tables."] };
  }

  for (const [index, raw] of value.entries()) {
    const label = `[[automations]][${index}]`;
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
      return key === "prompt" ? item : item.trim();
    };

    const id = stringValue("id");
    if (!id) errors.push(`${label}.id is required.`);
    else if (!AUTOMATION_ID_PATTERN.test(id))
      errors.push(`${label}.id must contain only letters, digits, ".", "_", or "-".`);
    else if (ids.has(id)) errors.push(`Duplicate automation id "${id}".`);
    else ids.add(id);

    const enabledValue = table.enabled;
    if (typeof enabledValue !== "boolean") errors.push(`${label}.enabled must be a boolean.`);
    if (table.kind !== undefined) {
      errors.push(
        `${label}.kind is not supported; scheduled estimation belongs in [[estimations]].`,
      );
    }
    const prompt = stringValue("prompt");
    if (!prompt) errors.push(`${label}.prompt is required.`);

    const schedule = parseCronOrIntervalSchedule(table, { label }, errors);

    // PR creation is opt-in per automation: omitted or `false` means no PR,
    // no review branch, and no PR labels for this schedule's occurrences.
    const openPrValue = table.open_pr;
    const openPr = typeof openPrValue === "boolean" ? openPrValue : false;
    if (openPrValue !== undefined && openPrValue !== null && typeof openPrValue !== "boolean") {
      errors.push(`${label}.open_pr must be a boolean.`);
    }

    const repo = stringValue("repo");
    if (repo && options.repoNames && !options.repoNames.has(repo)) {
      errors.push(`${label}.repo "${repo}" does not match any [[repos]] name.`);
    }

    if (id && typeof enabledValue === "boolean" && prompt && schedule) {
      automations.push({
        id,
        enabled: enabledValue,
        prompt,
        cron: schedule.cron,
        interval: schedule.interval,
        intervalMs: schedule.intervalMs,
        repo,
        openPr,
      });
    }
  }
  return { automations, errors };
}

/** Parse the single-repository automation TOML file. */
export function parseAutomationConfig(text: string, sourceLabel = SINGLE_REPO_AUTOMATIONS_PATH) {
  let document: Record<string, unknown>;
  try {
    document = parseToml(text);
  } catch (error) {
    throw new Error(`Failed to parse ${sourceLabel}: ${(error as Error).message}`);
  }
  const result = parseAutomationEntries(document.automations, { sourceLabel });
  if (result.errors.length > 0) {
    throw new Error(`Invalid ${sourceLabel}:\n- ${result.errors.join("\n- ")}`);
  }
  return result.automations;
}

/** Load single-repository automations, returning an empty list when absent. */
export function loadSingleRepoAutomations(baseDir = process.cwd()): AutomationConfig[] {
  const path = join(baseDir, SINGLE_REPO_AUTOMATIONS_PATH);
  return existsSync(path) ? parseAutomationConfig(readFileSync(path, "utf8"), path) : [];
}

/** Value-taking review flag; its separate value is the next token. */
const PR_FLAGS_WITH_VALUE = new Set(["--auto-review-iterations"]);
/** PR/review flags in every form the CLI accepts, bare or `--flag=value`. */
const PR_FLAG_PATTERN = /^(?:--create-pr|--auto-review(?:-iterations)?)(?:=.*)?$/;
/** `--create-pr` forms that actually enable PR creation (`--create-pr=false` is not one). */
const CREATE_PR_PATTERN = /^--create-pr(?:=(?!false$).*)?$/;

/**
 * CLI args for one automation occurrence, derived from the workspace/task
 * default flags (`[defaults].worker_task_args` or `workerTaskArgs()`).
 *
 * The automation's own `open_pr` setting is the source of truth for PR
 * creation — never an inherited flag list:
 *
 * - `open_pr = true`: the defaults pass through with `--create-pr` appended
 *   when missing, so the setting alone guarantees PR creation; auto-review
 *   and PR labels keep working exactly as configured.
 * - `open_pr` off (the default): strip every PR/review flag from the
 *   defaults (so workspace-level `--create-pr --auto-review` — in bare or
 *   `--flag=value` form — cannot leak in) and append `--no-git` so the run
 *   makes no branch, no push, and no PR — the work lands wherever the
 *   prompt says it should.
 */
export function automationTaskArgs(automation: { openPr?: boolean }, baseArgs: string[]): string[] {
  if (automation.openPr) {
    return baseArgs.some((arg) => CREATE_PR_PATTERN.test(arg))
      ? baseArgs
      : [...baseArgs, "--create-pr"];
  }
  const filtered: string[] = [];
  let skipNext = false;
  for (const arg of baseArgs) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (PR_FLAGS_WITH_VALUE.has(arg)) {
      skipNext = true;
      continue;
    }
    if (PR_FLAG_PATTERN.test(arg)) continue;
    filtered.push(arg);
  }
  if (!filtered.includes("--no-git")) filtered.push("--no-git");
  return filtered;
}
