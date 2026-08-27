/**
 * Deterministic git access ports for the docs-drift-guard preset.
 *
 * The default implementation drives the ambient `git` binary through
 * `Utils.executeGitCommand` (the same path the rest of the CLI uses). Tests
 * inject fakes, and integration tests run against real temporary
 * repositories.
 */

import { Utils } from "../../utils";

export interface GitCommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface DocsDriftGitPort {
  /** Resolve the remote's default branch (falls back to origin/HEAD cache). */
  resolveDefaultBranch(cwd: string): Promise<string>;
  /** Best-effort `git fetch origin <branch>`; returns whether it succeeded. */
  fetchBranch(cwd: string, branch: string): Promise<boolean>;
  /** Full 40-char SHA for a ref, or `null` when it does not resolve. */
  revParse(cwd: string, ref: string): Promise<string | null>;
  /** True when the repository is a shallow clone. */
  isShallow(cwd: string): Promise<boolean>;
  /** True when `from` is an ancestor of `to` (rewritten-history guard). */
  isAncestor(cwd: string, from: string, to: string): Promise<boolean>;
  /** `status<TAB>path` lines for `from..to` with renames broken up. */
  changedFilesWithStatus(cwd: string, from: string, to: string): Promise<string[]>;
  /** `additions<TAB>deletions<TAB>path` lines; `-` marks binary. */
  numstat(cwd: string, from: string, to: string): Promise<string[]>;
  /** Commit records (`sha<US>subject<US>author`) for `from..to`. */
  commits(cwd: string, from: string, to: string): Promise<string[]>;
  /** Paths among the given ones that git ignores (check-ignore). */
  ignoredPaths(cwd: string, paths: string[]): Promise<string[]>;
  /** File content at a revision, capped at `maxBytes`; `null` when absent. */
  showFile(cwd: string, sha: string, path: string, maxBytes: number): Promise<string | null>;
  /** Working tree has no staged or unstaged changes. */
  isWorkingTreeClean(cwd: string): Promise<boolean>;
  /** Repo-relative paths with unstaged/staged changes (porcelain). */
  workingTreePaths(cwd: string): Promise<string[]>;
  /** Currently checked-out branch name, or `null` when detached. */
  currentBranch(cwd: string): Promise<string | null>;
  /** Check out an existing ref. */
  checkout(cwd: string, ref: string): Promise<void>;
  /** `origin` remote URL, or `null`. */
  remoteUrl(cwd: string): Promise<string | null>;
  /** Create (or reset) `branch` at `sha` and check it out. */
  checkoutBranchAt(cwd: string, branch: string, sha: string): Promise<void>;
  /** Stage exactly the given paths. */
  stagePaths(cwd: string, paths: string[]): Promise<void>;
  /** Commit staged changes; returns the new SHA. */
  commit(cwd: string, message: string): Promise<string>;
  /** Push `branch` to origin (forced when `force`). */
  pushBranch(cwd: string, branch: string, force: boolean): Promise<void>;
  /** `owner/repo` slug parsed from the origin URL, or `null`. */
  repositorySlug(cwd: string): Promise<string | null>;
}

const US = "\x1f";
const RS = "\x1e";
/** check-ignore batch size, keeping well below argv limits. */
const CHECK_IGNORE_BATCH = 100;

async function git(
  args: string[],
  cwd: string,
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<GitCommandResult> {
  const result = await Utils.executeGitCommand(args, {
    cwd,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (!result.success && !options.allowFailure) {
    throw new Error(`git ${args[0]} failed: ${(result.error || result.output || "").trim()}`);
  }
  return result;
}

/** Default git port on top of `Utils.executeGitCommand`. */
export const defaultGitPort: DocsDriftGitPort = {
  async resolveDefaultBranch(cwd) {
    return Utils.getMainBranchName({ cwd });
  },

  async fetchBranch(cwd, branch) {
    const result = await git(["fetch", "origin", branch], cwd, {
      allowFailure: true,
      timeoutMs: 60_000,
    });
    return result.success;
  },

  async revParse(cwd, ref) {
    const result = await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd, {
      allowFailure: true,
    });
    return result.success ? result.output.trim() : null;
  },

  async isShallow(cwd) {
    const result = await git(["rev-parse", "--is-shallow-repository"], cwd, { allowFailure: true });
    return result.success && result.output.trim() === "true";
  },

  async isAncestor(cwd, from, to) {
    const result = await git(["merge-base", "--is-ancestor", from, to], cwd, {
      allowFailure: true,
    });
    return result.success;
  },

  async changedFilesWithStatus(cwd, from, to) {
    const result = await git(["diff", "--name-status", "--no-renames", `${from}..${to}`], cwd);
    return result.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  },

  async numstat(cwd, from, to) {
    const result = await git(["diff", "--numstat", "--no-renames", `${from}..${to}`], cwd);
    return result.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  },

  async commits(cwd, from, to) {
    const result = await git(
      ["log", `--pretty=format:%H${US}%s${US}%an${RS}`, `${from}..${to}`],
      cwd,
    );
    return result.output.split(RS).filter(Boolean);
  },

  async ignoredPaths(cwd, paths) {
    const ignored: string[] = [];
    for (let index = 0; index < paths.length; index += CHECK_IGNORE_BATCH) {
      const batch = paths.slice(index, index + CHECK_IGNORE_BATCH);
      // check-ignore exits non-zero when *no* paths match; output still lists
      // the matching subset, so treat non-empty output as the result.
      const result = await git(["check-ignore", ...batch], cwd, { allowFailure: true });
      for (const line of result.output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) ignored.push(trimmed);
      }
    }
    return ignored;
  },

  async showFile(cwd, sha, path, maxBytes) {
    const result = await git(["show", `${sha}:${path}`], cwd, { allowFailure: true });
    if (!result.success) return null;
    const content = result.output;
    return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n…[truncated]` : content;
  },

  async isWorkingTreeClean(cwd) {
    const result = await git(["status", "--porcelain"], cwd);
    return result.output.trim().length === 0;
  },

  async workingTreePaths(cwd) {
    // Plain-path plumbing only: `status --porcelain` rows start with a
    // two-char status column that executeGitCommand's whole-output trim
    // corrupts on the first line, so stage detection uses path-only
    // commands instead.
    const tracked = await git(["diff", "--name-only", "HEAD"], cwd, { allowFailure: true });
    const untracked = await git(["ls-files", "--others", "--exclude-standard"], cwd);
    const paths = new Set<string>();
    for (const line of [...tracked.output.split("\n"), ...untracked.output.split("\n")]) {
      const trimmed = line.trim().replace(/^"|"$/g, "");
      if (trimmed) paths.add(trimmed);
    }
    return [...paths];
  },

  async currentBranch(cwd) {
    const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, { allowFailure: true });
    const branch = result.output.trim();
    return result.success && branch && branch !== "HEAD" ? branch : null;
  },

  async checkout(cwd, ref) {
    await git(["checkout", ref], cwd);
  },

  async remoteUrl(cwd) {
    const result = await git(["remote", "get-url", "origin"], cwd, { allowFailure: true });
    return result.success ? result.output.trim() || null : null;
  },

  async checkoutBranchAt(cwd, branch, sha) {
    const exists = await git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd, {
      allowFailure: true,
    });
    if (exists.success) {
      await git(["update-ref", `refs/heads/${branch}`, sha], cwd);
    } else {
      await git(["branch", branch, sha], cwd);
    }
    await git(["checkout", branch], cwd);
  },

  async stagePaths(cwd, paths) {
    await git(["add", "--", ...paths], cwd);
  },

  async commit(cwd, message) {
    await git(["commit", "-m", message, "--no-verify"], cwd);
    const head = await git(["rev-parse", "HEAD"], cwd);
    return head.output.trim();
  },

  async pushBranch(cwd, branch, force) {
    await git(["push", ...(force ? ["--force"] : []), "origin", branch], cwd, {
      timeoutMs: 120_000,
    });
  },

  async repositorySlug(cwd) {
    const url = await this.remoteUrl(cwd);
    return url ? parseGitHostSlug(url) : null;
  },
};

/** Extract `owner/repo` from an https or ssh git remote URL. */
export function parseGitHostSlug(url: string): string | null {
  const https = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/i);
  if (https) return https[1];
  const ssh = url.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  return null;
}
