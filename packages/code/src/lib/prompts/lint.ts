/**
 * Prompt catalog lint.
 *
 * Validates every `prompts/*.md` file so the catalog stays reviewable and the
 * loader never encounters a malformed template at runtime. Ported from the
 * `lint-agents.sh` idea in msitarzewski/agency-agents: fail the build when a
 * prompt has malformed frontmatter, is missing required sections, or contains
 * placeholders that are not declared in metadata.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "./frontmatter";
import { REQUIRED_FRONTMATTER_KEYS, defaultPromptsDir, extractPlaceholders } from "./loader";

/** A single prompt lint finding. */
export interface PromptLintIssue {
  /** Prompt file the issue belongs to. */
  file: string;
  /** Human-readable description of the problem. */
  message: string;
}

/** Convert a frontmatter attribute into a string list. */
function toStringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/**
 * Lint every Markdown prompt in a directory.
 *
 * Checks:
 * - frontmatter is present and well-formed;
 * - required keys (`name`, `description`, `placeholders`, `requiredSections`) exist;
 * - the declared `name` matches the filename;
 * - every `requiredSections` heading appears in the body;
 * - every `{{placeholder}}` used in the body is declared in `placeholders`;
 * - every declared placeholder is actually used.
 *
 * @param promptsDir - Directory containing `*.md` prompt files.
 * @returns Findings, empty when the catalog is valid.
 */
export function lintPrompts(promptsDir: string = defaultPromptsDir()): PromptLintIssue[] {
  const issues: PromptLintIssue[] = [];

  let entries: string[];
  try {
    entries = readdirSync(promptsDir);
  } catch {
    return [{ file: promptsDir, message: `prompts directory not found: ${promptsDir}` }];
  }

  const files = entries.filter((entry) => entry.endsWith(".md")).sort();
  if (files.length === 0) {
    issues.push({ file: promptsDir, message: "no prompt files (*.md) found" });
    return issues;
  }

  for (const filename of files) {
    const file = join(promptsDir, filename);
    const expectedName = filename.replace(/\.md$/, "");
    const raw = readFileSync(file, "utf8");
    const { attributes, body, errors } = parseFrontmatter(raw, file);

    for (const error of errors) {
      issues.push({ file, message: error });
    }
    if (errors.length > 0) {
      continue;
    }

    for (const key of REQUIRED_FRONTMATTER_KEYS) {
      if (attributes[key] === undefined) {
        issues.push({ file, message: `missing required frontmatter key '${key}'` });
      }
    }

    const declaredName = attributes.name;
    if (typeof declaredName === "string" && declaredName !== expectedName) {
      issues.push({
        file,
        message: `frontmatter name '${declaredName}' does not match filename '${expectedName}'`,
      });
    }

    for (const section of toStringList(attributes.requiredSections)) {
      if (!body.includes(section)) {
        issues.push({ file, message: `missing required section '${section}'` });
      }
    }

    const declared = toStringList(attributes.placeholders);
    const used = extractPlaceholders(body);

    for (const placeholder of used) {
      if (!declared.includes(placeholder)) {
        issues.push({
          file,
          message: `placeholder '{{${placeholder}}}' is used but not declared in frontmatter`,
        });
      }
    }

    for (const placeholder of declared) {
      if (!used.includes(placeholder)) {
        issues.push({
          file,
          message: `placeholder '${placeholder}' is declared but never used in the body`,
        });
      }
    }
  }

  return issues;
}

/**
 * Render lint findings as a human-readable report.
 *
 * @param issues - Findings from {@link lintPrompts}.
 * @returns Multi-line report string.
 */
export function formatLintIssues(issues: PromptLintIssue[]): string {
  return issues.map((issue) => `  ${issue.file}: ${issue.message}`).join("\n");
}
