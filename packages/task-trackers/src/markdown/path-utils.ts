import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseMarkdownFrontmatter, sanitizeMarkdownTaskKey } from "./frontmatter.ts";

/**
 * Return true when a CLI argument looks like a local file path rather than a PM task key.
 */
export function isMarkdownFilePath(arg: string): boolean {
  return (
    arg.endsWith(".md") ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    (arg.includes("/") && !arg.startsWith("http"))
  );
}

/**
 * Scan a tasks directory for a markdown file matching `taskRef`.
 *
 * Matches, in order:
 * 1. Frontmatter `key` field (exact or sanitized)
 * 2. Filename stem equal to `taskRef` or `{taskRef}-{slug}` (PM naming pattern)
 */
export function findMarkdownTaskFileByKey(
  taskRef: string,
  tasksDirectory: string,
): string | undefined {
  const resolvedDir = resolve(tasksDirectory);
  if (!existsSync(resolvedDir)) {
    return undefined;
  }

  const normalizedRef = sanitizeMarkdownTaskKey(taskRef);
  let entries: string[];

  try {
    entries = readdirSync(resolvedDir).filter((name) => name.endsWith(".md"));
  } catch {
    return undefined;
  }

  for (const file of entries) {
    const filePath = join(resolvedDir, file);
    try {
      const content = readFileSync(filePath, "utf8");
      const { frontmatter, hasFrontmatter } = parseMarkdownFrontmatter(content);
      if (!hasFrontmatter || !frontmatter.key) {
        continue;
      }

      if (
        frontmatter.key === taskRef ||
        sanitizeMarkdownTaskKey(frontmatter.key) === normalizedRef
      ) {
        return filePath;
      }
    } catch {
      continue;
    }
  }

  for (const file of entries) {
    const stem = file.slice(0, -3);
    if (stem === taskRef || stem.startsWith(`${taskRef}-`)) {
      return join(resolvedDir, file);
    }
  }

  return undefined;
}

/**
 * Resolve a task reference to an absolute markdown file path.
 *
 * Accepts explicit paths or keys looked up under `tasksDirectory`.
 */
export function resolveMarkdownTaskPath(
  taskRef: string,
  tasksDirectory?: string,
  cwd = process.cwd(),
): string {
  if (isMarkdownFilePath(taskRef) || isAbsolute(taskRef)) {
    return resolve(cwd, taskRef);
  }

  if (!tasksDirectory) {
    throw new Error(
      `Cannot resolve markdown task "${taskRef}" without MARKDOWN_TASKS_DIR or a file path`,
    );
  }

  const filename = taskRef.endsWith(".md") ? taskRef : `${taskRef}.md`;
  const directPath = resolve(tasksDirectory, filename);
  if (existsSync(directPath)) {
    return directPath;
  }

  const scanned = findMarkdownTaskFileByKey(taskRef, tasksDirectory);
  if (scanned) {
    return scanned;
  }

  return directPath;
}

/**
 * Filename stem without extension.
 */
export function markdownFilenameStem(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}
