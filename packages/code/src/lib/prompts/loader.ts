/**
 * Versioned prompt catalog loader.
 *
 * Role prompts (clarity, estimation, review, fix) live as Markdown files under
 * `packages/code/prompts/` with lightweight frontmatter metadata. This module
 * loads them, resolves per-repo overrides, substitutes `{{placeholder}}`
 * values, and validates that every placeholder the template uses is supplied.
 *
 * Overrides let the worker owner tune prompts without editing TypeScript.
 * They live in the workspace home, never in a repository checkout, so a pull
 * request cannot rewrite the instructions its own agent receives. Resolution
 * order (first match wins):
 *
 *   1. Explicit `overrideDirs` passed by the caller (used by tests and hosts).
 *   2. `DEVINTERN_PROMPTS_DIR`, when set.
 *   3. `<workspace>/prompts/<repo>/`, for the repository the run belongs to
 *      (`DEVINTERN_WORKSPACE_REPO`).
 *   4. `<workspace>/prompts/`, i.e. `~/.devintern/prompts/`.
 *   5. The bundled `prompts/` directory shipped with the package.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseFrontmatter } from "./frontmatter";
import { resolveProjectConfigDir } from "../config/config-dir";
import { WORKSPACE_REPO_ENV } from "../workspace/env";
import { resolveWorkspaceDir } from "../workspace/paths";

/** Keys every prompt file's frontmatter must declare. */
export const REQUIRED_FRONTMATTER_KEYS = [
  "name",
  "description",
  "placeholders",
  "requiredSections",
] as const;

/** Placeholder token pattern, e.g. `{{prDiff}}`. */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** A parsed prompt template ready for placeholder substitution. */
export interface PromptTemplate {
  /** Stable prompt identifier (matches the filename without extension). */
  name: string;
  /** Human-readable purpose shown by the lint tooling. */
  description: string;
  /** Placeholder keys the body may reference. */
  placeholders: string[];
  /** Markdown headings that must appear in the body. */
  requiredSections: string[];
  /** Markdown body with `{{placeholder}}` tokens. */
  body: string;
  /** Absolute path the template was loaded from. */
  sourcePath: string;
}

/** Options controlling prompt lookup. */
export interface LoadPromptOptions {
  /** Override the bundled prompts directory (primarily for tests/hosts). */
  promptsDir?: string;
  /** Explicit override directories, checked before environment/project dirs. */
  overrideDirs?: string[];
  /**
   * Whether to also search ambient override locations (`DEVINTERN_PROMPTS_DIR`
   * and `<workspace>/prompts`). Defaults to `true`. Set to `false` for
   * hermetic lookups that must resolve only bundled prompts plus explicit
   * `overrideDirs` (used by bundled-catalog tests and deterministic lints).
   */
  useAmbientOverrides?: boolean;
}

/**
 * Resolve the bundled `prompts/` directory relative to this module.
 *
 * Handles both the source layout (`src/lib/prompts/` → `../../../prompts`) and
 * the bundled dist layout (`dist/index.js` → `../prompts`).
 *
 * @param metaUrl - `import.meta.url` from the calling module (injectable for tests).
 * @returns Absolute path to the default prompts directory.
 */
export function defaultPromptsDir(metaUrl: string = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(metaUrl));
  const isBundle = moduleDir.endsWith("/dist") || moduleDir.endsWith("\\dist");
  return isBundle ? join(moduleDir, "prompts") : join(moduleDir, "..", "..", "..", "prompts");
}

/** Collect the override directories to search, in precedence order. */
function overrideDirs(options: LoadPromptOptions): string[] {
  const dirs: string[] = [];
  if (options.overrideDirs) {
    dirs.push(...options.overrideDirs);
  }
  if (options.useAmbientOverrides === false) {
    return dirs;
  }
  const envDir = process.env.DEVINTERN_PROMPTS_DIR;
  if (envDir) {
    dirs.push(envDir);
  }
  const workspacePrompts = workspacePromptsDir();
  const repo = process.env[WORKSPACE_REPO_ENV]?.trim();
  if (repo && isSafeRepoSegment(repo)) {
    dirs.push(join(workspacePrompts, repo));
  }
  dirs.push(workspacePrompts);
  warnIgnoredProjectPrompts();
  return dirs;
}

/** Workspace prompt override directory (`~/.devintern/prompts/`). */
export function workspacePromptsDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, "prompts");
}

/** A repo name usable as one path segment (no separators or dot segments). */
function isSafeRepoSegment(repo: string): boolean {
  return !/[\\/]/.test(repo) && repo !== "." && repo !== "..";
}

let warnedProjectPromptsDir: string | null = null;

/**
 * Warn once per directory when a project still has `.devintern-code/prompts/`.
 * Those overrides are no longer read: they moved to `~/.devintern/prompts/`.
 */
function warnIgnoredProjectPrompts(): void {
  let dir: string;
  try {
    dir = join(resolveProjectConfigDir(), "prompts");
  } catch {
    return;
  }
  if (dir === warnedProjectPromptsDir || !existsSync(dir)) return;
  warnedProjectPromptsDir = dir;
  console.warn(`⚠️  Ignoring prompt overrides in ${dir}.`);
  console.warn(`   Move them to ${workspacePromptsDir()}/ to keep using them.`);
}

/**
 * Resolve the file path for a named prompt, honouring overrides.
 *
 * @param name - Prompt name without extension (e.g. `clarity`).
 * @param options - Lookup options.
 * @returns Absolute path to the prompt file (may not exist until read).
 */
export function resolvePromptPath(name: string, options: LoadPromptOptions = {}): string {
  const filename = `${name}.md`;
  for (const dir of overrideDirs(options)) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return join(options.promptsDir ?? defaultPromptsDir(), filename);
}

/** Extract placeholder keys used in a template body, in first-seen order. */
export function extractPlaceholders(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1];
    if (key && !found.includes(key)) {
      found.push(key);
    }
  }
  return found;
}

/** Convert a frontmatter attribute into a string list. */
function toStringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/**
 * Load and parse a prompt template from disk.
 *
 * @param name - Prompt name without extension.
 * @param options - Lookup options.
 * @returns Parsed template metadata and body.
 * @throws When the file is missing or its frontmatter is invalid.
 */
export function loadPromptTemplate(name: string, options: LoadPromptOptions = {}): PromptTemplate {
  const sourcePath = resolvePromptPath(name, options);
  if (!existsSync(sourcePath)) {
    throw new Error(`Prompt '${name}' not found at ${sourcePath}`);
  }

  const raw = readFileSync(sourcePath, "utf8");
  const { attributes, body, errors } = parseFrontmatter(raw, sourcePath);
  if (errors.length > 0) {
    throw new Error(`Invalid prompt frontmatter:\n${errors.join("\n")}`);
  }

  const missing = REQUIRED_FRONTMATTER_KEYS.filter((key) => attributes[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Prompt '${sourcePath}' is missing frontmatter keys: ${missing.join(", ")}`);
  }

  const declaredName = String(attributes.name);
  if (declaredName !== name) {
    throw new Error(
      `Prompt '${sourcePath}' declares name '${declaredName}' but was loaded as '${name}'`,
    );
  }

  return {
    name: declaredName,
    description: String(attributes.description),
    placeholders: toStringList(attributes.placeholders),
    requiredSections: toStringList(attributes.requiredSections),
    body,
    sourcePath,
  };
}

/**
 * Substitute `{{placeholder}}` values into a template body.
 *
 * Only placeholders present in the template are considered; any placeholder the
 * body references that is absent from `replacements` raises an error so a
 * missing value can never ship an unresolved `{{token}}` to an agent. Values
 * are injected verbatim and never re-scanned, so untrusted content (e.g. a PR
 * diff) cannot accidentally trip placeholder validation.
 *
 * @param template - Parsed prompt template.
 * @param replacements - Placeholder keys mapped to their values.
 * @returns Rendered prompt text (trimmed).
 * @throws When the template references a placeholder with no replacement.
 */
export function renderPrompt(
  template: PromptTemplate,
  replacements: Record<string, string>,
): string {
  const used = extractPlaceholders(template.body);
  const missing = used.filter((key) => !(key in replacements));
  if (missing.length > 0) {
    throw new Error(
      `Prompt '${template.name}' has unresolved placeholder(s): ${missing.join(", ")}`,
    );
  }

  // Replace in a single pass; user-supplied values are inserted verbatim and
  // never re-scanned for placeholders.
  const body = template.body.replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (_match, key: string) => replacements[key] ?? "",
  );

  return body.trim();
}

/**
 * Load a prompt template and render it with the given replacements.
 *
 * @param name - Prompt name without extension.
 * @param replacements - Placeholder keys mapped to their values.
 * @param options - Lookup options.
 * @returns Rendered prompt text.
 */
export function loadPrompt(
  name: string,
  replacements: Record<string, string>,
  options: LoadPromptOptions = {},
): string {
  return renderPrompt(loadPromptTemplate(name, options), replacements);
}
