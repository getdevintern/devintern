import { spawnSync } from "child_process";
import { lstatSync } from "fs";
import { join } from "path";

/**
 * Worktree-root paths the agent sandbox mounts over (bwrap / nono bind
 * `/dev/null` onto them to keep the agent from reading or writing the user's
 * shell, editor, and git config). Inside the sandbox they are character
 * devices; once the sandbox exits, a mount point it had to create can remain
 * as an empty regular file. Neither is project content.
 */
const SANDBOX_PLACEHOLDER_PATHS = new Set([
  ".bash_profile",
  ".bashrc",
  ".profile",
  ".zprofile",
  ".zshrc",
  ".gitconfig",
  ".gitmodules",
  ".mcp.json",
  ".ripgreprc",
  ".idea",
  ".vscode",
]);

/** Whether an untracked worktree entry is sandbox debris rather than real work. */
function isSandboxPlaceholder(cwd: string, path: string): boolean {
  let stats;
  try {
    stats = lstatSync(join(cwd, path));
  } catch {
    return true; // Vanished between listing and staging: nothing to stage.
  }
  // Devices, FIFOs, and sockets are never project content (git cannot stage them).
  if (!stats.isFile() && !stats.isSymbolicLink()) return true;
  if (!stats.isFile() || stats.size !== 0) return false;
  return SANDBOX_PLACEHOLDER_PATHS.has(path) || path.startsWith(".claude/");
}

type GitFailure = { success: false; error?: string };

/** Worktree top level plus its untracked, non-ignored, non-placeholder files. */
function listRealUntracked(
  dir: string,
): GitFailure | { success: true; cwd: string; untracked: string[] } {
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (toplevel.status !== 0) {
    return { success: false, error: toplevel.stderr || toplevel.error?.message };
  }
  const cwd = toplevel.stdout.trim();

  const listed = spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    return { success: false, error: listed.stderr || listed.error?.message };
  }
  const untracked = listed.stdout
    .split("\0")
    .filter((path) => path !== "" && !isSandboxPlaceholder(cwd, path));
  return { success: true, cwd, untracked };
}

/**
 * Stage real work in a worktree an agent just edited: every change to tracked
 * files (`git add -u`, which also marks resolved merge conflicts and records
 * deletions) plus new untracked files that are not ignored and are not
 * sandbox placeholders.
 *
 * Replaces `git add -A`, which fails fatally on the sandbox's `/dev/null`
 * mounts and, when they are left behind as empty files, would commit them.
 * A legitimately new non-empty `.mcp.json` or `.claude/` file is still staged.
 *
 * Runs from the worktree top level even when `dir` is a subdirectory:
 * `git add -u` always covers the whole tree, but `git ls-files --others`
 * only lists (cwd-relative) paths under the cwd, which would leave new files
 * elsewhere out of the commit and mis-match the root-relative placeholders.
 *
 * @param dir - Any directory inside the worktree
 * @returns `success: false` with the git error when a staging command fails
 */
export function stageWorkTreeChanges(dir: string): { success: boolean; error?: string } {
  const listing = listRealUntracked(dir);
  if (!listing.success) return listing;
  const { cwd, untracked } = listing;

  const tracked = spawnSync("git", ["add", "-u"], { cwd, encoding: "utf8" });
  if (tracked.status !== 0) {
    return { success: false, error: tracked.stderr || tracked.error?.message };
  }

  if (untracked.length === 0) return { success: true };

  // `--literal-pathspecs`: these are file names, not pathspecs. Without it an
  // untracked file named `:!src` would act as an exclude for the whole batch.
  const added = spawnSync(
    "git",
    ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
    {
      cwd,
      encoding: "utf8",
      input: `${untracked.join("\0")}\0`,
    },
  );
  if (added.status !== 0) {
    return { success: false, error: added.stderr || added.error?.message };
  }
  return { success: true };
}

/**
 * Whether the index differs from `HEAD`, i.e. `git commit` has something to
 * record. Use this after {@link stageWorkTreeChanges} instead of
 * `git status --porcelain`, which also lists the untracked sandbox
 * placeholders that staging deliberately skips.
 *
 * @param cwd - Worktree root
 * @returns `success: false` with the git error when the check itself fails
 */
export function hasStagedChanges(cwd: string): {
  success: boolean;
  staged: boolean;
  error?: string;
} {
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd, encoding: "utf8" });
  if (diff.status === 0) return { success: true, staged: false };
  if (diff.status === 1) return { success: true, staged: true };
  return { success: false, staged: false, error: diff.stderr || diff.error?.message };
}

/**
 * Whether the worktree holds real uncommitted work: staged or unstaged
 * changes to tracked files (including unresolved conflicts), or new files
 * {@link stageWorkTreeChanges} would stage. Unlike `git status --porcelain`,
 * the untracked sandbox placeholders do not count. Does not touch the index.
 *
 * @param dir - Any directory inside the worktree
 * @returns `success: false` with the git error when a check fails
 */
export function hasUncommittedWork(dir: string): {
  success: boolean;
  dirty: boolean;
  error?: string;
} {
  const listing = listRealUntracked(dir);
  if (!listing.success) return { success: false, dirty: false, error: listing.error };
  if (listing.untracked.length > 0) return { success: true, dirty: true };

  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: listing.cwd,
    encoding: "utf8",
  });
  if (status.status !== 0) {
    return { success: false, dirty: false, error: status.stderr || status.error?.message };
  }
  return { success: true, dirty: status.stdout.trim() !== "" };
}
