/**
 * Deterministic half of auto-merge: classify a pull request's changed paths
 * against the workspace's safe/deny globs.
 *
 * Decision order (deny always wins, nothing here can widen it):
 * 1. Any changed path (old or new side of a rename) matches a deny glob, or
 *    the built-in deny list → `denied`. Never merged, not even after review.
 * 2. Every changed path matches a safe glob → `safe`. Merged without spending
 *    agent tokens.
 * 3. Otherwise → `needs-review`. Merged only if the agent review says so.
 *
 * Fails closed: an empty file list, a truncated file list, or a path that is
 * not a normalized repo-relative path is never classified `safe`.
 */

/** GitHub merge strategies accepted by `PUT /pulls/{n}/merge`. */
export type AutoMergeMethod = "merge" | "squash" | "rebase";

export const AUTO_MERGE_METHODS: readonly AutoMergeMethod[] = ["merge", "squash", "rebase"];

/**
 * Paths that are never auto-merged, regardless of configuration: CI
 * workflows can exfiltrate secrets or weaken checks, CODEOWNERS controls who
 * must review, and `.devintern-code/` holds the agent's own settings and
 * prompt overrides.
 */
export const BUILTIN_DENY_PATHS: readonly string[] = [
  ".github/**",
  "**/CODEOWNERS",
  ".devintern-code/**",
];

/** Resolved auto-merge path policy for one repository. */
export interface MergePathPolicy {
  /** Globs whose changes are safe to merge without review. */
  safePaths: string[];
  /** Globs that block auto-merge entirely (in addition to the built-ins). */
  denyPaths: string[];
}

/** One changed file as reported by the code host. */
export interface ChangedFile {
  /** Repo-relative path after the change. */
  path: string;
  /** Repo-relative path before a rename or copy. */
  previousPath?: string;
}

export type PathClassification =
  | { kind: "safe" }
  | { kind: "denied"; path: string; pattern: string }
  | { kind: "needs-review"; outside: string[] }
  | { kind: "invalid"; reason: string };

/**
 * Normalize a user-supplied glob: a trailing `/` means "everything below"
 * (`docs/` → `docs/**`), and a leading `./` is dropped.
 */
export function normalizeGlob(pattern: string): string {
  let value = pattern.trim();
  while (value.startsWith("./")) value = value.slice(2);
  if (value.endsWith("/")) value = `${value}**`;
  return value;
}

/** Whether `path` is a normalized repo-relative path safe to glob-match. */
function isNormalizedRepoPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function firstMatch(globs: Array<{ pattern: string; glob: Bun.Glob }>, path: string) {
  return globs.find((entry) => entry.glob.match(path))?.pattern;
}

function compile(patterns: readonly string[]): Array<{ pattern: string; glob: Bun.Glob }> {
  return patterns
    .map(normalizeGlob)
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => ({ pattern, glob: new Bun.Glob(pattern) }));
}

/**
 * Classify a PR's changed files against the path policy.
 *
 * @param files - Every changed file of the PR (must be complete)
 * @param policy - Safe and deny globs for the PR's repository
 */
export function classifyChangedPaths(
  files: readonly ChangedFile[],
  policy: MergePathPolicy,
): PathClassification {
  if (files.length === 0) {
    return { kind: "invalid", reason: "the pull request reports no changed files" };
  }
  const deny = compile([...BUILTIN_DENY_PATHS, ...policy.denyPaths]);
  const safe = compile(policy.safePaths);

  const paths: string[] = [];
  for (const file of files) {
    for (const path of [file.path, file.previousPath]) {
      if (path === undefined) continue;
      if (!isNormalizedRepoPath(path)) {
        return { kind: "invalid", reason: `unexpected changed path "${path}"` };
      }
      paths.push(path);
    }
  }

  for (const path of paths) {
    const pattern = firstMatch(deny, path);
    if (pattern) return { kind: "denied", path, pattern };
  }

  const outside = [...new Set(paths.filter((path) => !firstMatch(safe, path)))];
  return outside.length === 0 ? { kind: "safe" } : { kind: "needs-review", outside };
}

/** The agent's merge-safety verdict. */
export interface MergeSafetyVerdict {
  safe: boolean;
  reason: string;
}

/**
 * Extract the agent's verdict: the LAST JSON object in the output carrying a
 * boolean `safe`. Anything else (no JSON, `safe` not a boolean) is `null`,
 * which callers treat as "not safe" — the agent can only ever veto by
 * omission, never approve by accident.
 */
export function parseMergeSafetyVerdict(output: string): MergeSafetyVerdict | null {
  const candidates = output.match(/\{[^{}]*"safe"[^{}]*\}/g) ?? [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[index] as string);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.safe !== "boolean") continue;
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    return { safe: record.safe, reason: reason || "(no reason given)" };
  }
  return null;
}
