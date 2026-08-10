/**
 * Fetch + fast-forward-only update for a PM project checkout.
 *
 * Soft-dirty (dirty repo-root `.gitignore` from PM init) does not block pull.
 * Hard-dirty does. Ignored files are not dirtiness.
 * Never push, stash, reset, or merge (non-ff).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectGitSyncStatus } from "../shared/project-git-sync.ts";
import { classifyPmWorkingTree, type WorkingTreeDirtiness } from "./git-soft-dirty.ts";

export type { ProjectGitSyncStatus } from "../shared/project-git-sync.ts";

const execFileAsync = promisify(execFile);

/**
 * Cap hung remotes so project open / Update cannot block the UI indefinitely.
 * Applied per `git` process and as the end-to-end budget for {@link syncProjectFromRemote}.
 */
const GIT_EXEC_TIMEOUT_MS = 45_000;

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Optional per-invocation controls forwarded through auth / budget wrappers. */
export interface GitExecOptions {
  /** Kill the git process after this many ms (wall clock for this invocation). */
  timeoutMs?: number;
  /** Extra env vars (merged over `process.env` by {@link defaultGitExec}). */
  env?: NodeJS.ProcessEnv;
}

export type GitExec = (
  cwd: string,
  args: readonly string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      env: env ? { ...process.env, ...env } : undefined,
    });
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const err = error as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    if (err.killed || err.signal === "SIGTERM") {
      return {
        code: 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: `git ${args[0] ?? "command"} timed out after ${Math.ceil(timeoutMs / 1000)}s`,
      };
    }
    const code = typeof err.code === "number" ? err.code : 1;
    return {
      code,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message ?? "",
    };
  }
}

/** Default `git` runner for Electron main / Node. */
export const defaultGitExec: GitExec = async (cwd, args, options) =>
  runGit(cwd, args, options?.timeoutMs ?? GIT_EXEC_TIMEOUT_MS, options?.env);

/**
 * Wrap a git runner with a shared wall-clock deadline for the whole sync pipeline.
 * Each process timeout uses the remaining budget (works for nested runners such as
 * {@link import("./git-auth.ts").authenticatedGitExec}).
 *
 * @internal Also used by tests that assert budget forwarding through auth wrappers.
 */
export function withSyncBudget(inner: GitExec, budgetMs: number): GitExec {
  const deadline = Date.now() + budgetMs;
  return async (cwd, args, options) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        code: 1,
        stdout: "",
        stderr: `git sync timed out after ${budgetMs / 1000}s`,
      };
    }
    const timeoutMs =
      options?.timeoutMs !== undefined ? Math.min(options.timeoutMs, remaining) : remaining;
    return inner(cwd, args, { ...options, timeoutMs });
  };
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * Resolve the git working-tree root for `projectDir`, or null when not in a repo.
 */
export async function resolveGitRoot(
  projectDir: string,
  gitExec: GitExec = defaultGitExec,
): Promise<string | null> {
  const result = await gitExec(projectDir, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
}

/**
 * Classify the working tree at `gitRoot`.
 *
 * Uses plain `status --porcelain` (no `--ignored`). Soft-dirty is only a
 * dirty repo-root `.gitignore`. Paths under `.devintern-pm/` (including
 * untracked markdown tasks) are skipped and do not affect gating.
 */
export async function inspectWorkingTreeDirtiness(
  gitRoot: string,
  gitExec: GitExec = defaultGitExec,
): Promise<WorkingTreeDirtiness> {
  const result = await gitExec(gitRoot, ["status", "--porcelain"]);
  if (result.code !== 0) {
    // Fail closed: treat as hard-dirty so we never pull blindly.
    return "hard-dirty";
  }
  return classifyPmWorkingTree(splitLines(result.stdout));
}

/**
 * Current checkout label for the project bar.
 * Prefer the branch name; when detached, fall back to a short commit id.
 */
export async function resolveCurrentBranch(
  gitRoot: string,
  gitExec: GitExec = defaultGitExec,
): Promise<string | undefined> {
  const abbrev = await gitExec(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (abbrev.code === 0) {
    const name = abbrev.stdout.trim();
    if (name.length > 0 && name !== "HEAD") {
      return name;
    }
  }
  const short = await gitExec(gitRoot, ["rev-parse", "--short", "HEAD"]);
  if (short.code === 0) {
    const sha = short.stdout.trim();
    if (sha.length > 0) return sha;
  }
  return undefined;
}

async function resolveUpstreamRef(gitRoot: string, gitExec: GitExec): Promise<string | null> {
  const symbolic = await gitExec(gitRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (symbolic.code === 0) {
    const ref = symbolic.stdout.trim();
    if (ref.length > 0) return ref;
  }
  return null;
}

async function countAheadBehind(
  gitRoot: string,
  upstream: string,
  gitExec: GitExec,
): Promise<{ ahead: number; behind: number } | null> {
  const result = await gitExec(gitRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${upstream}`,
  ]);
  if (result.code !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

/** True when git refused checkout/merge because local changes would be overwritten. */
export function isWouldOverwriteMergeFailure(detail: string): boolean {
  return (
    /would be overwritten by merge/i.test(detail) ||
    /would be overwritten by checkout/i.test(detail) ||
    /Your local changes to the following files would be overwritten/i.test(detail) ||
    /Merge is not possible because you have unmerged files/i.test(detail) ||
    /Updating .+ would lose uncommitted changes/i.test(detail)
  );
}

/** User-facing copy when soft-dirty files block a git update or branch switch. */
export function softDirtyOverwriteMessage(action: "update" | "branch-switch"): string {
  return action === "update"
    ? "Can't get updates: a setup file change would be overwritten. Ask someone on your team to save or fix that change, then try again."
    : "Can't switch branches: a setup file change would be overwritten. Ask someone on your team to save or fix that change, then try again.";
}

/**
 * Fetch from the configured upstream and optionally fast-forward when the tree
 * is clean or PM soft-dirty. Soft-dirty never blocks the update for gating —
 * but git may still refuse ff-only when local soft-dirty files would be
 * overwritten by the incoming tip (e.g. both sides changed `.gitignore`).
 *
 * Project open and Update both use `{ pull: true }`. Pass `{ pull: false }` for
 * fetch/status only (e.g. tests asserting the behind + Update UI state).
 * Open path passes `{ fetchHardDirty: false }` so WIP checkouts skip the
 * remote fetch (behind counts are populated only on explicit Update).
 *
 * Fast-forward uses `git merge --ff-only <upstream>` (not `git pull --ff-only`)
 * so `pull.rebase=true` does not refuse soft-dirty `.gitignore` changes.
 */
export async function syncProjectFromRemote(
  projectDir: string,
  gitExec: GitExec = defaultGitExec,
  options: { pull?: boolean; fetchHardDirty?: boolean } = {},
): Promise<ProjectGitSyncStatus> {
  const shouldPull = options.pull !== false;
  // Update (default) still fetches hard-dirty trees to populate behind counts;
  // open path sets fetchHardDirty: false to avoid blocking on hung remotes.
  const fetchHardDirty = options.fetchHardDirty !== false;
  const git = withSyncBudget(gitExec, GIT_EXEC_TIMEOUT_MS);
  const gitRoot = await resolveGitRoot(projectDir, git);
  if (!gitRoot) {
    return {
      kind: "error",
      softDirty: false,
      message: "This folder isn't a project repository.",
    };
  }

  const branch = await resolveCurrentBranch(gitRoot, git);
  const dirtiness = await inspectWorkingTreeDirtiness(gitRoot, git);
  const softDirty = dirtiness === "soft-dirty";

  const upstreamBeforeFetch = await resolveUpstreamRef(gitRoot, git);
  if (!upstreamBeforeFetch) {
    return {
      kind: "no_remote",
      softDirty,
      branch,
      message: "This project isn't linked to an online repository yet.",
    };
  }

  // Open path: hard-dirty → skip fetch (behind counts are Update-only).
  if (dirtiness === "hard-dirty" && !fetchHardDirty) {
    return {
      kind: "skipped_dirty",
      softDirty: false,
      branch,
      message:
        "You have unsaved local edits, so getting updates was skipped. Save or discard them first, then try again.",
    };
  }

  // Fetch the remote that owns the upstream tracking ref (e.g. origin/main → origin).
  const remoteName = upstreamBeforeFetch.split("/")[0] ?? "origin";
  const fetch = await git(gitRoot, ["fetch", remoteName]);
  if (fetch.code !== 0) {
    const detail = (fetch.stderr || fetch.stdout).trim();
    return {
      kind: "error",
      softDirty,
      branch,
      message: detail
        ? `Couldn't download updates. ${detail}`
        : "Couldn't download updates from the online repository.",
    };
  }

  const upstream = (await resolveUpstreamRef(gitRoot, git)) ?? upstreamBeforeFetch;
  const counts = await countAheadBehind(gitRoot, upstream, git);
  if (!counts) {
    return {
      kind: "error",
      softDirty,
      branch,
      fetched: true,
      message:
        "Couldn't check for updates. Try again, or make sure this project is linked to an online repository.",
    };
  }
  const { ahead, behind } = counts;

  if (dirtiness === "hard-dirty") {
    const behindPart =
      behind > 0
        ? ` There ${behind === 1 ? "is also" : "are also"} ${behind} update${behind === 1 ? "" : "s"} available.`
        : "";
    return {
      kind: "skipped_dirty",
      softDirty: false,
      branch,
      ahead,
      behind,
      fetched: true,
      message: `You have unsaved local edits, so getting updates was skipped.${behindPart} Save or discard them first, then try again.`,
    };
  }

  if (behind === 0) {
    return {
      kind: "ok",
      softDirty,
      branch,
      ahead,
      behind: 0,
      updated: false,
      fetched: true,
      message:
        ahead > 0
          ? `You're up to date (${ahead} of your change${ahead === 1 ? "" : "s"} not shared online yet).`
          : "You're up to date.",
    };
  }

  // Behind, clean or soft-dirty.
  if (!shouldPull) {
    return {
      kind: "behind",
      softDirty,
      branch,
      ahead,
      behind,
      fetched: true,
      message: `${behind} update${behind === 1 ? "" : "s"} available.`,
    };
  }

  // Open / Update: ff-only merge onto the fetched upstream tip.
  // Avoid `git pull --ff-only` — with pull.rebase=true it refuses unstaged
  // soft-dirty .gitignore changes ("cannot pull with rebase").
  const merge = await git(gitRoot, ["merge", "--ff-only", upstream]);
  if (merge.code !== 0) {
    const detail = (merge.stderr || merge.stdout).trim();
    const nonFf =
      /not possible to fast-forward|diverged|refusing to merge|Need to specify/i.test(detail) ||
      /Cannot fast-forward/i.test(detail);
    if (isWouldOverwriteMergeFailure(detail)) {
      return {
        kind: "error",
        softDirty,
        branch,
        ahead,
        behind,
        fetched: true,
        message: softDirty
          ? softDirtyOverwriteMessage("update")
          : detail
            ? `Couldn't get updates. ${detail}`
            : "Couldn't get updates — your local edits would be overwritten.",
      };
    }
    return {
      kind: nonFf ? "diverged" : "error",
      softDirty,
      branch,
      ahead,
      behind,
      fetched: true,
      message: nonFf
        ? `Can't get updates yet (${behind} waiting). Ask someone on your team to help merge the branches, then try again.`
        : detail
          ? `Couldn't get updates. ${detail}`
          : "Couldn't get updates.",
    };
  }

  return {
    kind: "ok",
    softDirty,
    branch,
    ahead: 0,
    behind: 0,
    updated: true,
    fetched: true,
    message: `Got latest changes (${behind} change${behind === 1 ? "" : "s"}).`,
  };
}
