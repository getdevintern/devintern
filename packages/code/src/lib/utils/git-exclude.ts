import { spawnSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Keep a path out of git without touching the project's committed
 * `.gitignore`, using the per-clone `.git/info/exclude`.
 *
 * `--git-common-dir` is used so every linked worktree of a repository shares
 * one exclude file (the bare clone's in fleet mode), and the pattern applies
 * relative to each worktree root. Non-git directories are no-ops, and a
 * second call with the same pattern adds nothing: the written line is the
 * idempotency check.
 *
 * When `target` is given, a `git check-ignore` probe short-circuits the write
 * for a path the project's own ignore rules already cover. The probe is only
 * reliable for file paths: a directory-only pattern is not recognized for a
 * path that does not exist yet, so directory callers omit `target` and rely on
 * the written-line check.
 *
 * Best-effort by design: any failure (not a repo, read-only `.git`) is
 * swallowed. This is a safety net against tool state leaking into commits
 * (e.g. a `.devintern-code/` directory written into a worktree before the
 * primary relocation takes effect), never a hard requirement.
 *
 * @param cwd - Directory inside the target working tree
 * @param pattern - Exclude pattern appended when not already present
 * @param target - Optional path probed with `git check-ignore` before writing
 */
export function ensureGitInfoExcluded(cwd: string, pattern: string, target?: string): void {
  try {
    if (target !== undefined) {
      // 0 = already ignored, 128 = not a repository. Only 1 (visible) proceeds.
      const check = spawnSync("git", ["check-ignore", "-q", target], { cwd });
      if (check.status !== 1) {
        return;
      }
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
