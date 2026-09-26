import { fetchWithRetry as sharedFetchWithRetry } from "@devintern/utils";
import { existsSync, mkdirSync } from "fs";
import { Utils } from "./registry";

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
  generateTaskFilename,
});
