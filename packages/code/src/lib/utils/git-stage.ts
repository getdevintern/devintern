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
 * @param cwd - Worktree root
 * @returns `success: false` with the git error when a staging command fails
 */
export function stageWorkTreeChanges(cwd: string): { success: boolean; error?: string } {
  const tracked = spawnSync("git", ["add", "-u"], { cwd, encoding: "utf8" });
  if (tracked.status !== 0) {
    return { success: false, error: tracked.stderr || tracked.error?.message };
  }

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
  if (untracked.length === 0) return { success: true };

  const added = spawnSync("git", ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd,
    encoding: "utf8",
    input: `${untracked.join("\0")}\0`,
  });
  if (added.status !== 0) {
    return { success: false, error: added.stderr || added.error?.message };
  }
  return { success: true };
}
