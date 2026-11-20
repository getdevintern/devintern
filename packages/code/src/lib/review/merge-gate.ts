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
 *    The verdict is read only from the agent's stdout, and only from its
 *    last non-empty line or a single fenced block that ends the output
 *    (see `parseMergeSafetyVerdict`).
 *
 * Fails closed: an empty file list, a truncated file list, or a path that is
 * not a normalized repo-relative path is never classified `safe`.
 */

/** GitHub merge strategies accepted by `PUT /pulls/{n}/merge`. */
export type AutoMergeMethod = "merge" | "squash" | "rebase";

export const AUTO_MERGE_METHODS: readonly AutoMergeMethod[] = ["merge", "squash", "rebase"];

/** Default label for PRs auto-merge leaves open (`auto_merge_review_label`). */
export const DEFAULT_AUTO_MERGE_REVIEW_LABEL = "needs-human-review";

/**
 * Paths that are never auto-merged, regardless of configuration: CI
 * workflows can exfiltrate secrets or weaken checks, and CODEOWNERS controls
 * who must review.
 */
export const BUILTIN_DENY_PATHS: readonly string[] = [".github/**", "**/CODEOWNERS"];

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

/** ANSI escape sequences: CSI (colors, cursor control) and OSC (titles, links). */
// oxlint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const ANSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

/** An opening Markdown fence line: ``` or ```json (case-insensitive). */
const OPENING_FENCE = /^```(?:json)?$/i;
const CLOSING_FENCE = "```";

/**
 * Extract the agent's verdict from its **stdout** only (never stderr, which
 * carries transcripts that echo the prompt and PR diff). After stripping ANSI
 * codes and trailing whitespace, the LAST non-empty line must be a JSON object
 * with a boolean `safe`. The one other accepted shape is a single fenced block
 * that ends the output: an opening ``` or ```json line, exactly one non-empty
 * line holding the JSON object, then a closing ``` line. Anything else (prose
 * last, prose after the fence, JSON only earlier in the output, multi-line
 * JSON, malformed JSON, `safe` not a boolean) is `null`, which callers treat
 * as "not safe" — the agent can only ever veto by omission, never approve by
 * accident. No trailing text is skipped, so a harness that prints anything
 * after the final answer fails closed.
 */
export function parseMergeSafetyVerdict(stdout: string): MergeSafetyVerdict | null {
  const lines = stdout
    .replace(ANSI_PATTERN, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let candidate = lines.at(-1);
  if (candidate === CLOSING_FENCE) {
    // Blank lines are dropped above, so the fence must be exactly these three.
    const opening = lines.at(-3);
    candidate = opening !== undefined && OPENING_FENCE.test(opening) ? lines.at(-2) : undefined;
  }
  if (!candidate?.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.safe !== "boolean") return null;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return { safe: record.safe, reason: reason || "(no reason given)" };
}
