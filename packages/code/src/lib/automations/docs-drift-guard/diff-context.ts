/**
 * Build bounded analysis context from the checkpoint..head commit range.
 *
 * Deterministic pre-filtering keeps cheap runs cheap: documentation paths
 * (per pattern overrides) and git-ignored files are excluded from the
 * behavior-changing set, so documentation-only merges or ignored generated
 * churn complete without invoking the agent. Every truncation (file size,
 * file count, commit count) is recorded on the context so run diagnostics
 * can surface it instead of silently producing a clean result.
 */

import type { DocsDriftGitPort } from "./git-port";
import { isDocumentationPath } from "./paths";

export interface DiffCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface DiffFile {
  path: string;
  /** `git diff --name-status` letter: A, M, D, T, .... */
  status: string;
  /** Matches the documentation pattern list (analysis targets, not drift evidence). */
  docRelated: boolean;
  /** Ignored by git (generated/local churn). */
  ignored: boolean;
  /** Binary per `--numstat`. */
  binary: boolean;
  /** Content preview for behavior files, bounded by `maxFileBytes`. */
  content?: string;
  truncated: boolean;
}

export interface DiffContext {
  fromSha: string;
  toSha: string;
  commits: DiffCommit[];
  /** Files behavior-changing enough to warrant analysis (non-doc, non-ignored). */
  behaviorFiles: DiffFile[];
  /** Every changed file in the range, including docs and ignored files. */
  files: DiffFile[];
  truncated: boolean;
}

export interface DiffContextLimits {
  /** Cap on files read into context (excess files are listed, not read). */
  maxFiles?: number;
  /** Cap on per-file content bytes. */
  maxFileBytes?: number;
  /** Cap on commits retained as evidence. */
  maxCommits?: number;
}

const DEFAULT_LIMITS: Required<DiffContextLimits> = {
  maxFiles: 40,
  maxFileBytes: 24_000,
  maxCommits: 500,
};

interface StatusEntry {
  status: string;
  path: string;
}

function parseStatusLines(lines: string[]): StatusEntry[] {
  return lines
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      if (tabIndex === -1) return null;
      const status = line.slice(0, tabIndex).trim();
      const path = line.slice(tabIndex + 1).trim();
      if (!status || !path) return null;
      return { status, path };
    })
    .filter((entry): entry is StatusEntry => entry !== null);
}

/**
 * Collect the deterministic diff context for `fromSha..toSha`.
 *
 * @throws When git plumbing fails; callers must treat that as a failed run.
 */
export async function collectDiffContext(
  git: DocsDriftGitPort,
  options: {
    cwd: string;
    fromSha: string;
    toSha: string;
    docPatterns: readonly string[];
    limits?: DiffContextLimits;
  },
): Promise<DiffContext> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const { cwd, fromSha, toSha, docPatterns } = options;

  const [statusLines, numstatLines, commitRecords] = await Promise.all([
    git.changedFilesWithStatus(cwd, fromSha, toSha),
    git.numstat(cwd, fromSha, toSha),
    git.commits(cwd, fromSha, toSha),
  ]);

  const statusEntries = parseStatusLines(statusLines);
  const binaryPaths = new Set(
    numstatLines.filter((line) => line.startsWith("-\t-")).map((line) => line.split("\t")[2] ?? ""),
  );

  let truncated = false;
  if (commitRecords.length > limits.maxCommits) {
    truncated = true;
  }
  const commits: DiffCommit[] = commitRecords.slice(0, limits.maxCommits).map((record) => {
    const [sha, subject, author] = record.split("\x1f");
    return {
      sha: (sha ?? "").trim(),
      subject: (subject ?? "").trim(),
      author: (author ?? "").trim(),
    };
  });

  const paths = statusEntries.map((entry) => entry.path);
  const ignored = new Set(await git.ignoredPaths(cwd, paths));

  const files: DiffFile[] = [];
  const behaviorFiles: DiffFile[] = [];

  for (const entry of statusEntries) {
    const docRelated = isDocumentationPath(entry.path, docPatterns);
    const isIgnored = ignored.has(entry.path);
    const binary = binaryPaths.has(entry.path);
    const file: DiffFile = {
      path: entry.path,
      status: entry.status,
      docRelated,
      ignored: isIgnored,
      binary,
      truncated: false,
    };

    // Read content only for behavior files (docs are the analysis targets;
    // their current text arrives via the documentation summaries below).
    // Deleted and binary files stay in the behavior set — they are behavior
    // evidence — but carry no content preview.
    if (!docRelated && !isIgnored) {
      if (!binary && entry.status !== "D" && behaviorFiles.length < limits.maxFiles) {
        const content = await git.showFile(cwd, toSha, entry.path, limits.maxFileBytes);
        if (content !== null) {
          file.content = content;
          file.truncated = content.length >= limits.maxFileBytes;
          if (file.truncated) truncated = true;
        }
      } else if (behaviorFiles.length >= limits.maxFiles) {
        file.truncated = true;
        truncated = true;
      }
      behaviorFiles.push(file);
    }
    files.push(file);
  }

  return { fromSha, toSha, commits, behaviorFiles, files, truncated };
}

/** True when deterministic filtering proves there is nothing to analyze. */
export function hasNoBehaviorChanges(context: DiffContext): boolean {
  return context.behaviorFiles.length === 0;
}
