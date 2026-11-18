/** Typed field readers for raw `workspace.toml` tables; each collects errors instead of throwing. */

import { DEFAULT_AUTO_MERGE_REVIEW_LABEL } from "../review/merge-gate";

export function asTable(value: unknown, label: string, errors: string[]): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be a table.`);
    return {};
  }
  return value as Record<string, unknown>;
}

export function asTableArray(
  value: unknown,
  label: string,
  errors: string[],
): Record<string, unknown>[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of tables.`);
    return [];
  }
  const tables: Record<string, unknown>[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}[${index}] must be a table.`);
      continue;
    }
    tables.push(entry as Record<string, unknown>);
  }
  return tables;
}

export function readString(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string | undefined {
  const value = table[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label}.${key} must be a non-empty string.`);
    return undefined;
  }
  return value.trim();
}

export function readStringList(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string[] {
  const value = table[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push(`${label}.${key} must be an array of non-empty strings.`);
    return [];
  }
  return (value as string[]).map((item) => item.trim());
}

export function readOptionalBoolean(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): boolean | undefined {
  const value = table[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    errors.push(`${label}.${key} must be a boolean.`);
    return undefined;
  }
  return value;
}

export function readOptionalInteger(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
  bounds: { min: number; max?: number; message: string },
): number | undefined {
  const value = table[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min) {
    errors.push(bounds.message);
    return undefined;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    errors.push(bounds.message);
    return undefined;
  }
  return value;
}

export function readEnvTable(
  table: Record<string, unknown>,
  label: string,
  errors: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(asTable(table.env, `${label}.env`, errors))) {
    if (typeof value !== "string") {
      errors.push(`${label}.env.${key} must be a string.`);
      continue;
    }
    env[key] = value;
  }
  return env;
}

/** Read an auto-merge glob list, rejecting absolute and parent-relative globs. */
export function readGlobList(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string[] {
  const globs = readStringList(table, key, label, errors);
  for (const glob of globs) {
    if (glob.startsWith("/") || glob.split("/").includes("..")) {
      errors.push(`${label}.${key} entry "${glob}" must be a repo-relative glob.`);
    }
  }
  return globs;
}

/** `auto_merge_review_label`: default label when unset, `""` disables. */
export function readReviewLabel(
  workspaceTable: Record<string, unknown>,
  label: string,
  errors: string[],
): string {
  const value = workspaceTable.auto_merge_review_label;
  if (value === undefined || value === null) return DEFAULT_AUTO_MERGE_REVIEW_LABEL;
  if (typeof value !== "string") {
    errors.push(`${label}.auto_merge_review_label must be a string ("" disables labeling).`);
    return DEFAULT_AUTO_MERGE_REVIEW_LABEL;
  }
  return value.trim();
}
