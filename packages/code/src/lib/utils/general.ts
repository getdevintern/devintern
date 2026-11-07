import { fetchWithRetry as sharedFetchWithRetry } from "@devintern/utils";
import { existsSync, mkdirSync } from "fs";
import { Utils } from "./registry";
import type {
  ExecutionPreferenceConflict,
  ExecutionPreferences,
  ExtractedExecutionPreferences,
} from "./types";

/**
 * Ensure a directory exists, creating it recursively when missing.
 *
 * @param dirPath - Directory path to create
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Format an ISO date string for display.
 *
 * @param dateString - Input date string
 * @returns Locale-formatted date/time, or the original string on parse failure
 */
export function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleString();
  } catch {
    return dateString;
  }
}

/**
 * Sanitize a filename by replacing invalid path characters.
 *
 * @param filename - Original filename
 */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_");
}

/**
 * Extract the hostname from a URL string.
 *
 * @param url - URL to parse
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
}

/**
 * Truncate text to a maximum length with ellipsis.
 *
 * @param text - Input text
 * @param maxLength - Maximum length including ellipsis
 */
export function truncateText(text: string, maxLength = 100): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Test whether a string is a valid absolute URL.
 *
 * @param string - Candidate URL string
 */
export function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert bytes to a human-readable size string.
 *
 * @param bytes - Byte count
 * @param decimals - Decimal places to show
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Number.parseFloat((bytes / k ** i).toFixed(dm)) + " " + sizes[i];
}

/**
 * Pause execution for a duration.
 *
 * @param ms - Sleep duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn - Function to retry
 * @param maxRetries - Maximum attempts
 * @param baseDelay - Initial delay in milliseconds
 * @throws The last error when all retries are exhausted
 */
export async function retry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = baseDelay * 2 ** (attempt - 1);
      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await Utils.sleep(delay);
    }
  }

  throw lastError!;
}

/** @see {@link sharedFetchWithRetry} from `@devintern/utils` */
export const fetchWithRetry = sharedFetchWithRetry;

/**
 * Parse a JIRA issue key into project prefix and numeric suffix.
 *
 * @param taskKey - Issue key (e.g. `PROJ-123`)
 * @throws When the key format is invalid
 */
export function parseTaskKey(taskKey: string): {
  project: string;
  number: number;
  key: string;
} {
  const match = taskKey.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid JIRA task key format: ${taskKey}`);
  }

  return {
    project: match[1],
    number: Number.parseInt(match[2], 10),
    key: taskKey,
  };
}

/**
 * Extract an optional target branch name from task description markdown.
 *
 * @param description - Task description text
 * @returns Branch name, or `null` when not specified
 */
export function extractTargetBranch(description: string | undefined): string | null {
  if (!description) {
    return null;
  }

  // Support multiple patterns with flexible markdown formatting:
  // - "Target branch: branch-name"
  // - "**Target branch**: branch-name"
  // - "*Target branch*: branch-name"
  // - "## Target branch: branch-name"
  // - "_Base branch_: branch-name"
  // - "***PR target***: branch-name"
  // The regex handles:
  // - Optional leading # characters (headings)
  // - Optional * or _ for bold/italic (0-3 occurrences before and after keyword)
  // - The keyword (target branch, base branch, pr target)
  // - REQUIRED colon (with optional table separator |)
  // - The branch name (capturing group) - allows -, _, /, ., alphanumeric
  // - Must end at whitespace, newline, or markdown formatting
  const patterns = [
    /#{0,6}\s*[*_]{0,3}target\s+branch[*_]{0,3}\s*:\s*\|?\s*[*_]{0,3}([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?=\s|[*_,]|\n|$)/i,
    /#{0,6}\s*[*_]{0,3}base\s+branch[*_]{0,3}\s*:\s*\|?\s*[*_]{0,3}([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?=\s|[*_,]|\n|$)/i,
    /#{0,6}\s*[*_]{0,3}pr\s+target[*_]{0,3}\s*:\s*\|?\s*[*_]{0,3}([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?=\s|[*_,]|\n|$)/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match && match[1]) {
      let branchName = match[1].trim();

      // Clean up any remaining markdown artifacts (but preserve underscores in branch name)
      // Only remove leading/trailing * and _ that are markdown formatting
      branchName = branchName.replace(/^[*_]+/, "").replace(/[*_]+$/, "");

      // Validate branch name (basic check)
      if (branchName && branchName.length > 0 && !branchName.includes(" ")) {
        return branchName;
      }
    }
  }

  return null;
}

/** Heading names that open an explicit execution-preference block. */
const EXECUTION_PREFERENCE_HEADINGS = new Set([
  "execution preferences",
  "agent execution preferences",
]);

/** Labels accepted for each execution preference field. */
const EXECUTION_PREFERENCE_LABELS: Readonly<Record<keyof ExecutionPreferences, readonly string[]>> =
  {
    harness: ["agent harness", "harness"],
    model: ["agent model", "model"],
    effort: ["reasoning effort", "agent effort", "effort"],
  };

/** Any recognized label followed by a single-token value on the same line. */
const PREFERENCE_LINE_PATTERN = new RegExp(
  `^[ \\t]*(?:[-*+>][ \\t]*)?#{0,6}[ \\t]*[*_]{0,3}(?:${Object.values(EXECUTION_PREFERENCE_LABELS)
    .flat()
    .map((label) => label.replace(/[ \t]+/g, "[ \\t]+"))
    .join("|")})[*_]{0,3}[ \\t]*:[ \\t]*\\|?[ \\t]*[*_]{0,3}\\S+[*_]{0,3}[ \\t]*$`,
  "i",
);

/**
 * Normalize a heading-like line to its plain text label: drop markdown
 * emphasis, collapse whitespace, trim a trailing colon, and lower-case it.
 *
 * @param text - Raw line or heading text
 * @returns Comparable label text
 */
function normalizePreferenceHeading(text: string): string {
  return text
    .replace(/[*_]/g, "")
    .trim()
    .replace(/[ \t]+/g, " ")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Normalize a markdown ATX heading line to its plain text, or `null` when the
 * line is not a heading. Used to find explicit preference sections and to stop
 * them at the next heading.
 *
 * @param line - One line of the task description
 * @returns Lower-cased heading text without markdown decoration, or `null`
 */
function headingText(line: string): string | null {
  const match = line.match(/^[ \t]*#{1,6}[ \t]*(.*)$/);
  if (!match) {
    return null;
  }
  return normalizePreferenceHeading(match[1] ?? "");
}

/**
 * Recognize the preference heading even when the tracker flattened the heading
 * markup to a bare line (Jira ADF text extraction, HTML-derived descriptions).
 *
 * @param line - One line of the task description
 * @returns Lower-cased heading label, or `null` when the line is not one
 */
function barePreferenceHeading(line: string): string | null {
  const text = normalizePreferenceHeading(line);
  return EXECUTION_PREFERENCE_HEADINGS.has(text) ? text : null;
}

/**
 * True when a line starts with a recognized preference label.
 *
 * A flattened (HTML-derived) block often has a blank line between the heading
 * and each field, so blank-line handling peeks at the next non-empty line: a
 * label keeps the block open, while prose ends it.
 *
 * @param line - One line of the task description
 * @returns Whether the line looks like `Harness:`, `Model:`, or `Effort:`
 */
function isPreferenceLine(line: string): boolean {
  return PREFERENCE_LINE_PATTERN.test(line);
}

/**
 * Find the next non-blank line at or after `start`.
 *
 * @param lines - Description lines
 * @param start - First index to inspect
 * @returns The next non-blank line, or `null` at end of input
 */
function nextNonBlankLine(lines: readonly string[], start: number): string | null {
  for (let index = start; index < lines.length; index++) {
    if (lines[index].trim() !== "") {
      return lines[index];
    }
  }
  return null;
}

/**
 * Remove code samples before collecting preference blocks: fenced markdown
 * blocks and HTML `<pre>` / `<code>` sections. The docs show a preference block
 * as an example; pasting that example into a ticket must stay prose instead of
 * launching the sample harness/model.
 *
 * @param description - Task description text
 * @returns Description with code sections blanked out line-for-line
 */
function stripCodeSections(description: string): string {
  const withoutHtml = description
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, "\n")
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, "\n");
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of withoutHtml.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^[ \t]*(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        fence = null;
      }
      lines.push("");
      continue;
    }
    const opening = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      lines.push("");
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Collect the only description regions that may contain execution preferences.
 *
 * Bare labels anywhere in a ticket description are too ambiguous: prose such as
 * "Model: gpt-4 returns a blank page" would otherwise become configuration.
 * Authors must opt in with either a dedicated heading section or a `devintern`
 * HTML comment:
 *
 * ```md
 * ## Execution preferences
 * Harness: codex
 * Model: gpt
 * ```
 *
 * Some trackers (Jira ADF, Azure DevOps HTML) flatten headings to plain text,
 * so a line containing only `Execution preferences` also opens a block; blank
 * lines and headings end it. Markdown headings keep the historical behavior of
 * running until the next heading. Code samples are ignored.
 *
 * ```md
 * <!-- devintern: Harness: codex -->
 * ```
 *
 * @param description - Task description text
 * @returns Preference-block contents, in description order
 */
function collectExecutionPreferenceBlocks(description: string): string[] {
  const blocks: string[] = [];
  const text = stripCodeSections(description);

  // HTML comment form. `devintern` may be followed by a colon, a
  // `preferences` / `execution-preferences` marker, or the first preference
  // line itself. Other `devintern:` markers (artifacts, summaries) are safe to
  // collect: they contain no preference labels.
  const commentPattern =
    /<!--[ \t]*devintern(?:[ \t]*:[ \t]*(?:execution-)?preferences)?[ \t]*:?[ \t]*([\s\S]*?)-->/gi;
  for (const match of text.matchAll(commentPattern)) {
    if (match[1]) {
      blocks.push(match[1]);
    }
  }

  // Heading form: everything after an `Execution preferences` heading until
  // the next heading. Multiple sections are all considered. A bare (flattened)
  // heading ends before later prose, but blank lines between the heading and a
  // field, or between fields, are tolerated: flattened HTML often emits
  // `<h2>Execution preferences</h2>\n\nHarness: codex`.
  let current: string[] | null = null;
  let bareSection = false;
  let bareSectionHasContent = false;
  const flush = () => {
    if (current) {
      blocks.push(current.join("\n"));
      current = null;
    }
    bareSection = false;
    bareSectionHasContent = false;
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = headingText(line);
    if (heading !== null) {
      flush();
      if (EXECUTION_PREFERENCE_HEADINGS.has(heading)) {
        current = [];
      }
      continue;
    }
    if (barePreferenceHeading(line) !== null) {
      flush();
      current = [];
      bareSection = true;
      continue;
    }
    if (current) {
      if (bareSection && line.trim() === "") {
        // Ignore blank lines before the first field, and keep the block open
        // when the next non-blank line is another preference label. Otherwise
        // a blank line ends the block so later prose is never treated as config.
        if (!bareSectionHasContent || isPreferenceLine(nextNonBlankLine(lines, index + 1) ?? "")) {
          current.push(line);
          continue;
        }
        flush();
        continue;
      }
      if (line.trim() !== "") {
        bareSectionHasContent = true;
      }
      current.push(line);
    }
  }
  flush();

  return blocks;
}

/**
 * Extract optional execution preferences (harness, model, effort) from a task
 * description.
 *
 * Preferences are read only from an explicit block — an `Execution preferences`
 * heading section or a `devintern` HTML comment (see
 * {@link collectExecutionPreferenceBlocks}). Ordinary ticket prose, including
 * colon-containing lines, is ignored. Inside a block, labels tolerate markdown
 * formatting:
 *
 * - `Harness: opencode` / `**Harness**: opencode` / `Agent harness: codex`
 * - `Model: sonnet` / `Agent model: claude-sonnet-4-6`
 * - `Effort: high` / `Reasoning effort: low`
 *
 * Each label and value must fit on one line, so a dangling `Model:` cannot
 * consume the next line. Repeated identical values collapse to one preference;
 * conflicting values for the same field are reported in `conflicts` so the
 * caller can fail with actionable feedback instead of guessing which one the
 * author meant.
 *
 * @param description - Task description text
 * @returns Parsed preferences plus any conflicts found
 */
export function extractExecutionPreferences(
  description: string | undefined,
): ExtractedExecutionPreferences {
  const preferences: ExecutionPreferences = {};
  const conflicts: ExecutionPreferenceConflict[] = [];
  if (!description) {
    return { preferences, conflicts };
  }

  const blocks = collectExecutionPreferenceBlocks(description);
  if (blocks.length === 0) {
    return { preferences, conflicts };
  }
  const text = blocks.join("\n").replace(/\r\n?/g, "\n");

  // Value grammars per field: harness ids are hyphenated names; model ids may
  // be native aliases or provider-qualified identifiers; effort is a word.
  const fields: ReadonlyArray<{
    field: keyof ExecutionPreferences;
    labels: string[];
    value: string;
  }> = [
    {
      field: "harness",
      labels: [...EXECUTION_PREFERENCE_LABELS.harness],
      value: "[A-Za-z0-9][A-Za-z0-9-]*",
    },
    {
      field: "model",
      labels: [...EXECUTION_PREFERENCE_LABELS.model],
      value: "[A-Za-z0-9][A-Za-z0-9._/:@#-]*",
    },
    {
      field: "effort",
      labels: [...EXECUTION_PREFERENCE_LABELS.effort],
      value: "[A-Za-z][A-Za-z-]*",
    },
  ];

  for (const { field, labels, value } of fields) {
    const labelPattern = labels.map((label) => label.replace(/[ \t]+/g, "[ \\t]+")).join("|");
    // `[ \t]` (not `\s`) keeps a dangling label from consuming the next line;
    // anchoring the value to the end of its line rejects trailing prose.
    const pattern = new RegExp(
      `^[ \\t]*(?:[-*+>][ \\t]*)?#{0,6}[ \\t]*[*_]{0,3}(?:${labelPattern})[*_]{0,3}[ \\t]*:[ \\t]*\\|?[ \\t]*[*_]{0,3}(${value})[*_]{0,3}[ \\t]*$`,
      "gim",
    );
    const values: string[] = [];
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        values.push(match[1]);
      }
    }
    if (values.length === 0) {
      continue;
    }
    // Harness and effort are case-insensitive; model values belong to the CLI.
    const uniqueByValue = new Map<string, string>();
    for (const value of values) {
      const key = field === "model" ? value : value.toLowerCase();
      if (!uniqueByValue.has(key)) {
        uniqueByValue.set(key, value);
      }
    }
    const unique = [...uniqueByValue.values()];
    preferences[field] = unique[0];
    if (unique.length > 1) {
      conflicts.push({ field, values: unique });
    }
  }

  return { preferences, conflicts };
}

/**
 * Generate a unique task output filename with timestamp.
 *
 * @param taskKey - JIRA issue key
 * @param extension - File extension without dot
 */
export function generateTaskFilename(taskKey: string, extension = "md"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitizedKey = Utils.sanitizeFilename(taskKey);
  return `task-${sanitizedKey}-${timestamp}.${extension}`;
}

/** Print a message only when verbose logging is enabled. */
export function logVerbose(verbose: boolean, message: string): void {
  if (verbose) {
    console.log(message);
  }
}

Object.assign(Utils, {
  ensureDirectoryExists,
  formatDate,
  sanitizeFilename,
  extractDomain,
  truncateText,
  isValidUrl,
  formatBytes,
  sleep,
  retry,
  fetchWithRetry,
  parseTaskKey,
  extractTargetBranch,
  extractExecutionPreferences,
  generateTaskFilename,
});
