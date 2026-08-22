import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { CronExpressionParser } from "cron-parser";
import { getProjectKeyEnvVar, loadTrackerConfig } from "@devintern/task-trackers";
import type { TrackerConfig } from "@devintern/task-trackers";

import { parseToml } from "./workspace/toml";

export type AutomationAction = "headless" | "create_ticket";

export interface AutomationConfig {
  id: string;
  enabled: boolean;
  prompt: string;
  action: AutomationAction;
  cron?: string;
  interval?: string;
  intervalMs?: number;
  repo?: string;
  trackerProject?: string;
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
    const prompt = stringValue("prompt");
    if (!prompt) errors.push(`${label}.prompt is required.`);
    const actionValue = stringValue("action");
    if (actionValue && actionValue !== "headless" && actionValue !== "create_ticket") {
      errors.push(`${label}.action must be "headless" or "create_ticket".`);
    }

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

    const repo = stringValue("repo");
    if (repo && options.repoNames && !options.repoNames.has(repo)) {
      errors.push(`${label}.repo "${repo}" does not match any [[repos]] name.`);
    }
    const trackerProject = stringValue("tracker_project");

    if (
      id &&
      typeof enabledValue === "boolean" &&
      prompt &&
      (actionValue === "headless" || actionValue === "create_ticket") &&
      Boolean(cron) !== Boolean(interval) &&
      (!interval || intervalMs !== null)
    ) {
      automations.push({
        id,
        enabled: enabledValue,
        prompt,
        action: actionValue,
        cron,
        interval,
        intervalMs: intervalMs ?? undefined,
        repo,
        trackerProject,
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

/** Default project/team/board/repository for the selected tracker. */
export function configuredTrackerProject(
  tracker: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  const key = getProjectKeyEnvVar(tracker.toLowerCase());
  return key ? env[key] : undefined;
}

/** Resolve PM's tracker config using the run environment without changing the worker process. */
export async function resolvePmTrackerConfig(
  baseDir: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<TrackerConfig> {
  const originalEnv = { ...process.env };
  const resolutionEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, resolutionEnv);
    return await loadTrackerConfig(".devintern-pm", baseDir);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

/** Default project from the exact tracker configuration PM will use at execution time. */
function resolvedTrackerProject(config: TrackerConfig): string | undefined {
  switch (config.backend.type) {
    case "jira":
      return config.jira?.defaultProjectKey;
    case "linear":
      return config.linear?.defaultTeamKey;
    case "trello":
      return config.trello?.defaultBoardId;
    case "azure-devops":
      return config.azureDevOps?.defaultProject;
    case "asana":
      return config.asana?.defaultProjectGid;
    case "github":
      return config.github?.repository;
    case "markdown":
      return undefined;
  }
}

/** Startup-only semantic validation against PM's resolved tracker configuration. */
export function validateAutomationProjects(
  automations: AutomationConfig[],
  trackerConfig: TrackerConfig,
): void {
  const errors = automations
    .filter(
      (automation) =>
        automation.action === "create_ticket" &&
        !automation.trackerProject &&
        !resolvedTrackerProject(trackerConfig),
    )
    .map(
      (automation) =>
        `Automation "${automation.id}" uses create_ticket but has no tracker_project and the tracker has no default project.`,
    );
  if (errors.length > 0)
    throw new Error(`Invalid automation configuration:\n- ${errors.join("\n- ")}`);
}
