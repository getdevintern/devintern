import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { CronExpressionParser } from "cron-parser";

import { parseToml } from "./workspace/toml";
import { getPreset } from "./automations/presets";
import { listPresetNames, resolvePresetOutputMode } from "./automations/preset-registry";
import type { PresetOutputMode } from "./automations/preset-registry";

export interface AutomationConfig {
  id: string;
  enabled: boolean;
  prompt?: string;
  /** Built-in preset name; mutually exclusive with {@linkcode prompt}. */
  preset?: string;
  /** Preset output channel (`ticket` or `pull_request`). */
  outputMode?: PresetOutputMode;
  /** Preset-specific documentation path overrides (docs-drift-guard). */
  docPaths?: string[];
  /** Preset-specific first-run starting SHA (docs-drift-guard). */
  baselineSha?: string;
  cron?: string;
  interval?: string;
  intervalMs?: number;
  repo?: string;
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
 * Validate and normalize `[[automations]]` tables, collecting every error.
 *
 * Entries either carry a `prompt` (free-form automation) or name a `preset`
 * (built-in behavior with typed defaults). Unknown presets, unsupported
 * output modes, invalid path overrides, and prompt/preset mixing are all
 * rejected with actionable errors while parsing continues for other entries.
 */
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

    const presetName = stringValue("preset");
    const prompt = stringValue("prompt");
    if (presetName && prompt) {
      errors.push(
        `${label} cannot combine prompt and preset; preset entries get their prompt from the preset definition.`,
      );
    }
    if (!presetName && !prompt) errors.push(`${label}.prompt is required.`);

    let presetConfig: {
      preset: string;
      outputMode?: PresetOutputMode;
      docPaths?: string[];
      baselineSha?: string;
    } | null = null;
    if (presetName) {
      const definition = getPreset(presetName);
      if (!definition) {
        errors.push(
          `${label}.preset "${presetName}" is not a known automation preset. Known presets: ${listPresetNames().join(", ")}.`,
        );
      } else {
        const entryErrors: string[] = [];
        const outputMode = resolvePresetOutputMode(definition, table, (message) =>
          entryErrors.push(message),
        );
        if (outputMode) presetConfig = { preset: presetName, outputMode };
        definition.validateOptions?.({
          table,
          error: (message) => entryErrors.push(message),
        });
        for (const message of entryErrors) errors.push(`${label}: ${message}`);
        if (outputMode && entryErrors.length === 0) {
          presetConfig = {
            ...presetConfig,
            preset: presetName,
            outputMode,
            ...(Array.isArray(table.doc_paths) ? { docPaths: table.doc_paths as string[] } : {}),
            ...(typeof table.baseline_sha === "string"
              ? { baselineSha: table.baseline_sha.trim().toLowerCase() }
              : {}),
          };
        }
      }
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

    const entryIsValid =
      id !== undefined &&
      typeof enabledValue === "boolean" &&
      Boolean(cron) !== Boolean(interval) &&
      (!interval || intervalMs !== null) &&
      // Exactly one of prompt / preset, with the preset side fully valid.
      (presetName ? presetConfig !== null : prompt !== undefined);

    if (entryIsValid) {
      automations.push({
        id: id as string,
        enabled: enabledValue,
        ...(presetName
          ? {
              preset: (presetConfig as { preset: string }).preset,
              outputMode: (presetConfig as { outputMode: PresetOutputMode }).outputMode,
              docPaths: presetConfig?.docPaths,
              baselineSha: presetConfig?.baselineSha,
            }
          : { prompt: prompt as string }),
        cron,
        interval,
        intervalMs: intervalMs ?? undefined,
        repo,
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
