/**
 * Bundled automation catalog.
 *
 * A versioned, shareable set of named automation packs ships with the package
 * under `catalog/`: a `catalog.json` index plus one directory per pack holding
 * `pack.json`, `prompt.md`, and optional `references/`. This module loads and
 * validates that catalog. It never writes to the workspace — see
 * `install.ts` for `devintern automations add`.
 *
 * Validation is intentionally pure filesystem work so `devintern doctor` can
 * report broken entries (missing prompt files, duplicate ids, invalid
 * schedules) and orphaned pack directories (present but unlisted) without
 * touching the network.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { parseCronOrIntervalSchedule } from "./config";

export const CATALOG_INDEX_FILE = "catalog.json";
export const CATALOG_PACKS_DIR = "packs";
export const PACK_MANIFEST_FILE = "pack.json";
export const PACK_PROMPT_FILE = "prompt.md";

/** Cron-or-interval schedule for a pack (same grammar as `[[automations]]`). */
export interface CatalogSchedule {
  cron?: string;
  interval?: string;
}

/** Optional pipeline definition bundled with a pack. */
export interface CatalogPipeline {
  steps: unknown[];
  plugins?: string[];
}

/** A fully resolved catalog pack, with its prompt text inlined. */
export interface CatalogPack {
  id: string;
  name: string;
  description: string;
  schedule: CatalogSchedule;
  openPr: boolean;
  /** Resolved prompt body (the contents of `prompt.md`). */
  prompt: string;
  /** Pack-relative prompt file name. */
  promptFile: string;
  /** Pack-relative reference files (all confirmed to exist when loaded). */
  references: string[];
  /** Optional bundled pipeline (installed by `devintern automations add`). */
  pipeline?: CatalogPipeline;
  /** Absolute pack directory. */
  dir: string;
}

/** Lightweight pack listing entry (no prompt body). */
export interface CatalogPackSummary {
  id: string;
  name: string;
  description: string;
  schedule: CatalogSchedule;
  openPr: boolean;
}

/** One catalog problem. Broken entries are errors; orphaned ones are warnings. */
export interface CatalogIssue {
  level: "error" | "warn";
  packId: string;
  message: string;
}

export interface CatalogValidation {
  packs: CatalogPack[];
  issues: CatalogIssue[];
}

/**
 * Resolve the bundled `catalog/` directory relative to this module.
 *
 * Handles both the source layout (`src/lib/automation/` → `../../../catalog`)
 * and the bundled dist layout (`dist/index.js` → `../catalog`), mirroring the
 * prompt catalog loader.
 */
export function defaultCatalogDir(metaUrl: string = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(metaUrl));
  const isBundle = moduleDir.endsWith("/dist") || moduleDir.endsWith("\\dist");
  return isBundle ? join(moduleDir, "catalog") : join(moduleDir, "..", "..", "..", "catalog");
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate the `catalog.json` index into its declared pack ids. */
export function parseCatalogIndex(value: unknown, sourceLabel: string): string[] {
  if (!isRecord(value)) {
    throw new Error(`${sourceLabel} must be a JSON object.`);
  }
  const packs = value.packs;
  if (!Array.isArray(packs) || packs.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`${sourceLabel}.packs must be an array of non-empty pack id strings.`);
  }
  return (packs as string[]).map((id) => id.trim());
}

/** Reject pack-relative paths that escape the pack directory. */
function resolveInsidePack(packDir: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;
  const resolved = resolve(packDir, relPath);
  const rel = relative(packDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

/** Read a required non-empty string field, recording an error when missing. */
function requiredPackString(
  manifest: Record<string, unknown>,
  key: string,
  id: string,
  issues: CatalogIssue[],
): string {
  const value = manifest[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  issues.push({ level: "error", packId: id, message: `Pack "${id}": ${key} is required.` });
  return "";
}

/** Parse and validate a pack's cron-or-interval schedule. */
function parsePackSchedule(
  manifest: Record<string, unknown>,
  id: string,
  issues: CatalogIssue[],
): CatalogSchedule | undefined {
  const scheduleErrors: string[] = [];
  const schedule = parseCronOrIntervalSchedule(
    isRecord(manifest.schedule) ? manifest.schedule : {},
    { label: `Pack "${id}" schedule` },
    scheduleErrors,
  );
  for (const message of scheduleErrors) {
    issues.push({ level: "error", packId: id, message });
  }
  if (!schedule) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": schedule must set exactly one of cron or interval.`,
    });
    return undefined;
  }
  return { cron: schedule.cron, interval: schedule.interval };
}

/** Parse the optional `openPr` boolean (defaults to false). */
function parsePackOpenPr(
  manifest: Record<string, unknown>,
  id: string,
  issues: CatalogIssue[],
): boolean {
  if (manifest.openPr === undefined) return false;
  if (typeof manifest.openPr !== "boolean") {
    issues.push({ level: "error", packId: id, message: `Pack "${id}": openPr must be a boolean.` });
    return false;
  }
  return manifest.openPr;
}

/** Resolve a pack's prompt file and read its body. */
function parsePackPrompt(
  packDir: string,
  manifest: Record<string, unknown>,
  id: string,
  issues: CatalogIssue[],
): { prompt: string; promptFile: string } {
  const promptFile =
    typeof manifest.prompt === "string" && manifest.prompt.trim()
      ? manifest.prompt.trim()
      : PACK_PROMPT_FILE;
  const promptPath = resolveInsidePack(packDir, promptFile);
  if (!promptPath) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": prompt file "${promptFile}" must stay inside the pack directory.`,
    });
    return { prompt: "", promptFile };
  }
  if (!existsSync(promptPath)) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": prompt file "${promptFile}" does not exist.`,
    });
    return { prompt: "", promptFile };
  }
  try {
    return { prompt: readFileSync(promptPath, "utf8"), promptFile };
  } catch (error) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": cannot read prompt file "${promptFile}": ${(error as Error).message}`,
    });
    return { prompt: "", promptFile };
  }
}

/** Parse the optional `references` list, warning on dangling entries. */
function parsePackReferences(
  packDir: string,
  manifest: Record<string, unknown>,
  id: string,
  issues: CatalogIssue[],
): string[] {
  const references: string[] = [];
  if (manifest.references === undefined) return references;
  if (
    !Array.isArray(manifest.references) ||
    manifest.references.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": references must be an array of non-empty strings.`,
    });
    return references;
  }
  for (const reference of manifest.references as string[]) {
    const trimmed = reference.trim();
    const resolved = resolveInsidePack(packDir, trimmed);
    if (!resolved || !existsSync(resolved)) {
      issues.push({
        level: "warn",
        packId: id,
        message: `Pack "${id}": reference "${trimmed}" does not resolve to a file in the pack.`,
      });
      continue;
    }
    references.push(trimmed);
  }
  return references;
}

/** Parse the optional bundled `pipeline` definition. */
function parsePackPipeline(
  manifest: Record<string, unknown>,
  id: string,
  issues: CatalogIssue[],
): CatalogPipeline | undefined {
  if (manifest.pipeline === undefined) return undefined;
  if (!isRecord(manifest.pipeline) || !Array.isArray(manifest.pipeline.steps)) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": pipeline.steps must be an array.`,
    });
    return undefined;
  }
  const plugins = manifest.pipeline.plugins;
  if (
    plugins !== undefined &&
    (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== "string" || !entry.trim()))
  ) {
    issues.push({
      level: "error",
      packId: id,
      message: `Pack "${id}": pipeline.plugins must be an array of non-empty strings.`,
    });
    return undefined;
  }
  return { steps: manifest.pipeline.steps, plugins: plugins as string[] | undefined };
}

/**
 * Parse one `pack.json` and resolve its prompt and references.
 *
 * @param packDir - Absolute pack directory
 * @param expectedId - Id from the catalog index the manifest must match
 */
function parsePackManifest(
  packDir: string,
  expectedId: string,
): { pack?: CatalogPack; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const fail = (message: string): { issues: CatalogIssue[] } => {
    issues.push({ level: "error", packId: expectedId, message });
    return { issues };
  };

  let manifest: unknown;
  try {
    manifest = readJsonFile(join(packDir, PACK_MANIFEST_FILE));
  } catch (error) {
    return fail(`Pack "${expectedId}": ${(error as Error).message}`);
  }
  if (!isRecord(manifest)) {
    return fail(`Pack "${expectedId}": ${PACK_MANIFEST_FILE} must be a JSON object.`);
  }

  const id = manifest.id;
  if (typeof id !== "string" || !id.trim()) {
    return fail(`Pack "${expectedId}": ${PACK_MANIFEST_FILE}.id must be a non-empty string.`);
  }
  if (id !== expectedId) {
    return fail(
      `Pack "${expectedId}": ${PACK_MANIFEST_FILE}.id "${id}" does not match its directory name.`,
    );
  }

  const pack: CatalogPack = {
    id,
    name: requiredPackString(manifest, "name", id, issues),
    description: requiredPackString(manifest, "description", id, issues),
    schedule: parsePackSchedule(manifest, id, issues) ?? {},
    openPr: parsePackOpenPr(manifest, id, issues),
    ...parsePackPrompt(packDir, manifest, id, issues),
    references: parsePackReferences(packDir, manifest, id, issues),
    pipeline: parsePackPipeline(manifest, id, issues),
    dir: packDir,
  };

  if (issues.some((issue) => issue.level === "error")) {
    return { issues };
  }
  return { pack, issues };
}

/**
 * Load and validate every pack in the catalog.
 *
 * Returns the valid packs plus every problem found. `error` issues are broken
 * entries (unusable); `warn` issues are orphaned directories or dangling
 * references (reported but non-fatal).
 */
export function validateCatalog(dir: string = defaultCatalogDir()): CatalogValidation {
  const issues: CatalogIssue[] = [];
  const packs: CatalogPack[] = [];

  const indexPath = join(dir, CATALOG_INDEX_FILE);
  if (!existsSync(indexPath)) {
    issues.push({
      level: "error",
      packId: "",
      message: `Catalog index ${indexPath} is missing.`,
    });
    return { packs, issues };
  }

  let declaredIds: string[];
  try {
    declaredIds = parseCatalogIndex(readJsonFile(indexPath), indexPath);
  } catch (error) {
    issues.push({ level: "error", packId: "", message: (error as Error).message });
    return { packs, issues };
  }

  const declared = new Set<string>();
  for (const id of declaredIds) {
    if (declared.has(id)) {
      issues.push({
        level: "error",
        packId: id,
        message: `Duplicate pack id "${id}" in ${CATALOG_INDEX_FILE}.`,
      });
      continue;
    }
    declared.add(id);
  }

  for (const id of declared) {
    const packDir = join(dir, CATALOG_PACKS_DIR, id);
    const manifestPath = join(packDir, PACK_MANIFEST_FILE);
    if (!existsSync(packDir)) {
      issues.push({
        level: "error",
        packId: id,
        message: `Pack "${id}" is listed in ${CATALOG_INDEX_FILE} but its directory is missing.`,
      });
      continue;
    }
    if (!existsSync(manifestPath)) {
      issues.push({
        level: "error",
        packId: id,
        message: `Pack "${id}" is missing ${PACK_MANIFEST_FILE}.`,
      });
      continue;
    }
    const parsed = parsePackManifest(packDir, id);
    issues.push(...parsed.issues);
    if (parsed.pack) packs.push(parsed.pack);
  }

  const packsRoot = join(dir, CATALOG_PACKS_DIR);
  if (existsSync(packsRoot)) {
    for (const entry of readdirSync(packsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || declared.has(entry.name)) continue;
      issues.push({
        level: "warn",
        packId: entry.name,
        message: `Pack directory "${entry.name}" exists but is not listed in ${CATALOG_INDEX_FILE} (orphaned).`,
      });
    }
  }

  return { packs, issues };
}

/** Summaries of every valid pack in the catalog. */
export function listCatalogPacks(dir: string = defaultCatalogDir()): {
  packs: CatalogPackSummary[];
  issues: CatalogIssue[];
} {
  const { packs, issues } = validateCatalog(dir);
  return {
    packs: packs.map(({ id, name, description, schedule, openPr }) => ({
      id,
      name,
      description,
      schedule,
      openPr,
    })),
    issues,
  };
}

/**
 * Load one pack by id.
 *
 * @throws When the pack is missing or fails validation.
 */
export function loadCatalogPack(id: string, dir: string = defaultCatalogDir()): CatalogPack {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Unknown automation pack "${id}". Run \`devintern automations list\`.`);
  }
  const packDir = join(dir, CATALOG_PACKS_DIR, id);
  if (!existsSync(packDir)) {
    throw new Error(`Unknown automation pack "${id}". Run \`devintern automations list\`.`);
  }
  const { pack, issues } = parsePackManifest(packDir, id);
  if (!pack) {
    const detail = issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid automation pack "${id}": ${detail}`);
  }
  return pack;
}
