/**
 * "Do not delete" marker for a task worktree that holds work the run could
 * not push. The task subprocess writes it; the fleet executor checks it before
 * removing the worktree after a clean exit (an escalated run exits 0), and the
 * stale-worktree sweep (`RepoManager.sweepStaleWorktrees`) never removes a
 * marked worktree.
 *
 * The marker lives in the worktree's own git directory (`git rev-parse
 * --git-path`), so it never shows up as an untracked file and disappears with
 * the worktree once someone removes it.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import { executeGitCommand } from "./git-exec";

const MARKER = "devintern-keep-worktree";

async function markerPath(worktree: string): Promise<string | undefined> {
  const result = await executeGitCommand(["rev-parse", "--git-path", MARKER], {
    cwd: worktree,
  });
  const path = result.output.trim();
  if (!result.success || !path) return undefined;
  return isAbsolute(path) ? path : join(worktree, path);
}

/** Ask the worker to keep `worktree`; `reason` is logged when it does. */
export async function markWorktreeKept(worktree: string, reason: string): Promise<boolean> {
  const path = await markerPath(worktree);
  if (!path) return false;
  try {
    writeFileSync(path, `${reason}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The reason `worktree` must be kept, or `undefined` when it may be removed. */
export async function worktreeKeepReason(worktree: string): Promise<string | undefined> {
  if (!existsSync(worktree)) return undefined;
  const path = await markerPath(worktree);
  if (!path || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || "unsaved work";
  } catch {
    return "unsaved work";
  }
}
