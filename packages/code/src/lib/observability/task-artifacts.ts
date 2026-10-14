/**
 * Task artifact reader.
 *
 * Reads the write-only per-task artifacts under the task output directory
 * (`DEVINTERN_OUTPUT_DIR`, default `/tmp/devintern-tasks/<task-key>/`): the
 * built-in `verify` prompt/feedback files, auto-review `iteration-N/`
 * directories, implementation summaries, and the `pr-explainer-*` plugin
 * artifacts. The dashboard surfaces them alongside harness logs so reviewers
 * can see what a run produced without shelling into the task host.
 *
 * This mirrors `harness-logs.ts` hardening: discovery is a bounded recursive
 * walk that skips symlinks, reads are path-traversal guarded, and content is
 * ANSI-stripped and secret-redacted before it leaves the process. Artifacts
 * are advisory; a missing directory or file returns an empty list / `null`
 * rather than throwing.
 */

import { closeSync, lstatSync, openSync, readSync, readdirSync, statSync } from "fs";
import { join, resolve, sep } from "path";

import { taskOutputDir } from "../config/output-dir";
import { redactSecrets, stripAnsi } from "./worker-logs";

/** Tail window when the dashboard reads an artifact; older bytes stay on disk. */
export const TASK_ARTIFACT_READ_BYTES = 512 * 1024;

/** Default cap on artifacts listed for one task (oldest-by-name beyond this drop). */
export const TASK_ARTIFACT_MAX_FILES = 200;

/** Recursion cap; auto-review `iteration-N/` is depth 1, so 3 is generous. */
const TASK_ARTIFACT_MAX_DEPTH = 3;

/** One file under a task's output directory. */
export interface TaskArtifactFile {
  /** POSIX-relative path within the task output directory. */
  name: string;
  size: number;
  modifiedAt: number;
}

/** An artifact's tail content, stripped of ANSI codes and redacted. */
export interface TaskArtifactContent {
  name: string;
  content: string;
  truncated: boolean;
  totalBytes: number;
}

/** Whether a relative artifact name is a safe path under the task directory. */
function isSafeArtifactName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Recursively collect regular files (symlinks skipped), bounded in depth and count. */
function walkArtifacts(
  dir: string,
  prefix: string,
  depth: number,
  out: TaskArtifactFile[],
  limit: number,
): void {
  if (depth > TASK_ARTIFACT_MAX_DEPTH || out.length >= limit) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkArtifacts(abs, rel, depth + 1, out, limit);
    } else if (stat.isFile()) {
      out.push({ name: rel, size: stat.size, modifiedAt: stat.mtimeMs });
    }
  }
}

/**
 * List a task's artifacts, sorted by relative path. Returns `[]` when the task
 * output directory does not exist or cannot be read.
 *
 * @param taskKey - Task key (lowercased for the directory name)
 * @param options - Directory override (tests) and listing cap
 */
export function listTaskArtifacts(
  taskKey: string,
  options: { dir?: string; limit?: number } = {},
): TaskArtifactFile[] {
  const dir = resolve(options.dir ?? taskOutputDir(taskKey));
  const limit = Math.max(1, options.limit ?? TASK_ARTIFACT_MAX_FILES);
  const files: TaskArtifactFile[] = [];
  walkArtifacts(dir, "", 0, files, limit);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/**
 * Read the tail of a task artifact, stripped of ANSI codes and redacted.
 * Returns `null` for an unsafe name, a missing file, or an unreadable path.
 *
 * @param taskKey - Task key (lowercased for the directory name)
 * @param name - POSIX-relative artifact path (path components are validated)
 * @param options - Directory and read-window overrides
 */
export function readTaskArtifact(
  taskKey: string,
  name: string,
  options: { dir?: string; maxBytes?: number } = {},
): TaskArtifactContent | null {
  if (!isSafeArtifactName(name)) return null;
  const dir = resolve(options.dir ?? taskOutputDir(taskKey));
  const path = resolve(join(dir, ...name.split("/")));
  if (!path.startsWith(dir + sep)) return null;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const maxBytes = options.maxBytes ?? TASK_ARTIFACT_READ_BYTES;
  const start = Math.max(0, size - maxBytes);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const length = size - start;
    const buffer = Buffer.alloc(Math.max(0, length));
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (read <= 0) {
        break;
      }
      filled += read;
    }
    const raw = buffer.subarray(0, filled).toString("utf8");
    // Redact over the whole tail so multi-line secrets (PEM blocks) match.
    const content = redactSecrets(stripAnsi(raw));
    return { name, content, truncated: start > 0, totalBytes: size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a partially-opened file must not mask the read result.
      }
    }
  }
}
