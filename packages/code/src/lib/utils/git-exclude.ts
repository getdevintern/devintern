import { spawnSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Keep a path out of git without touching the project's committed
 * `.gitignore`, using the per-clone `.git/info/exclude`.
 *
 * `--git-common-dir` is used so every linked worktree of a repository shares
 * one exclude file (the bare clone's in fleet mode), and the pattern applies
 * relative to each worktree root. Already-ignored targets and non-git
 * directories are no-ops.
 *
 * Best-effort by design: any failure (not a repo, read-only `.git`) is
 * swallowed. This is a safety net against tool state leaking into commits
 * (e.g. a `.devintern-code/` directory written into a worktree before the
 * primary relocation takes effect), never a hard requirement.
 *
 * @param cwd - Directory inside the target working tree
 * @param target - Path that must end up ignored (checked with `git check-ignore`)
 * @param pattern - Exclude pattern appended when `target` is not yet ignored
 */
export function ensureGitInfoExcluded(cwd: string, target: string, pattern: string): void {
  try {
    // 0 = already ignored, 128 = not a repository. Only 1 (visible) proceeds.
    const check = spawnSync("git", ["check-ignore", "-q", target], { cwd });
    if (check.status !== 1) {
      return;
    }

    const gitDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
    });
    if (gitDir.status !== 0) {
      return;
    }

    const excludeFile = join(resolve(cwd, gitDir.stdout.trim()), "info", "exclude");
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (existing.split("\n").some((line) => line.trim() === pattern)) {
      return;
    }

    mkdirSync(dirname(excludeFile), { recursive: true });
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludeFile, `${separator}${pattern}\n`);
  } catch {
    // Excluding tool state is a safety net, never a requirement.
  }
}
