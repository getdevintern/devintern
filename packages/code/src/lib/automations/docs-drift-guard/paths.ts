/**
 * Documentation path selection for the docs-drift-guard preset.
 *
 * Default coverage: everything under `docs/`, any nested `AGENTS.md` /
 * `CLAUDE.md`, and `README*` files. Entries may override the pattern list
 * with `doc_paths` in the automation table. All patterns are repo-relative
 * posix globs evaluated against paths from `git diff --name-status`.
 */

import { getPreset } from "../preset-registry";

/** Default documentation glob patterns (repo-relative). */
export const DOCS_DRIFT_DEFAULT_DOC_PATTERNS: readonly string[] = [
  "docs/**/*.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "README*",
];

/** Characters allowed in a doc path override: word chars, path separators, glob metacharacters. */
const DOC_PATH_PATTERN = /^[A-Za-z0-9_\-./?*[\]!]+$/;

/** Validate the raw `doc_paths` table value, collecting actionable errors. */
export function validateDocPathOverrides(
  raw: unknown,
  onError: (message: string) => void,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    onError("doc_paths must be an array of repo-relative glob strings.");
    return undefined;
  }
  const patterns: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      onError("doc_paths entries must be non-empty strings.");
      continue;
    }
    const pattern = item.trim();
    const invalid = validateDocPathPattern(pattern);
    if (invalid) {
      onError(`doc_paths entry "${pattern}" ${invalid}`);
      continue;
    }
    patterns.push(pattern);
  }
  if (patterns.length === 0 && raw.length > 0) return undefined;
  return patterns;
}

function validateDocPathPattern(pattern: string): string | null {
  if (pattern.startsWith("/")) return 'must be repo-relative (no leading "/").';
  if (/^[A-Za-z]:/.test(pattern)) return "must be repo-relative (no drive letters).";
  if (pattern.includes("\\")) return "must use forward slashes.";
  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "..")) {
    return 'must not traverse outside the repository ("..").';
  }
  if (!DOC_PATH_PATTERN.test(pattern)) {
    return 'may only contain letters, digits, "/", "-", "_", ".", and glob characters (* ? [ ] !).';
  }
  return null;
}

/** Convert one glob pattern to a regular expression source (posix paths). */
export function docPathPatternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**` crosses directory boundaries. `/**/` also matches the root.
        if (pattern[index + 2] === "/" && (index === 0 || pattern[index - 1] === "/")) {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when `path` (posix, repo-relative) matches any documentation pattern. */
export function isDocumentationPath(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((pattern) => docPathPatternToRegExp(pattern).test(normalized));
}

/** Preset name of the docs-drift-guard definition. */
export const DOCS_DRIFT_GUARD_PRESET = "docs-drift-guard";

/** Doc pattern overrides configured for a docs-drift-guard automation, or the defaults. */
export function resolveDocPatterns(options: Record<string, unknown>): readonly string[] {
  const override = options.docPaths;
  return Array.isArray(override) && override.length > 0
    ? (override as string[])
    : DOCS_DRIFT_DEFAULT_DOC_PATTERNS;
}

/** True when the named preset is the docs-drift-guard definition. */
export function isDocsDriftGuardPreset(name: string | undefined): boolean {
  return name === DOCS_DRIFT_GUARD_PRESET && getPreset(DOCS_DRIFT_GUARD_PRESET) !== undefined;
}
