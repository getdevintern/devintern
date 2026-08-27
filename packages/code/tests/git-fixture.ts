/**
 * Isolated temporary git repositories for automation preset tests.
 *
 * Every repo is created under a unique mkdtemp directory with a local
 * identity and no hooks, so tests never touch an ambient repository
 * (tests/run-tests.ts additionally pins GIT_CEILING_DIRECTORIES).
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  dir: string;
  /** Run a git command, throwing on failure. */
  git: (args: string[]) => string;
  /** Write a file (creating parent dirs) and return its repo-relative path. */
  write: (path: string, content: string) => string;
  /** Commit everything, returning the new SHA. */
  commitAll: (message: string) => string;
  cleanup: () => void;
}

export function createTempRepo(name = "repo"): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), `devintern-${name}-`));
  const git = (args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: tmpdir(),
        GIT_AUTHOR_NAME: "Test Bot",
        GIT_AUTHOR_EMAIL: "bot@example.com",
        GIT_COMMITTER_NAME: "Test Bot",
        GIT_COMMITTER_EMAIL: "bot@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
      );
    }
    return result.stdout.toString().trim();
  };

  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "bot@example.com"]);
  git(["config", "user.name", "Test Bot"]);
  git(["config", "commit.gpgsign", "false"]);

  const write = (path: string, content: string): string => {
    const absolute = join(dir, path);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")) || dir, { recursive: true });
    writeFileSync(join(dir, path), content);
    return path;
  };
  const commitAll = (message: string): string => {
    git(["add", "-A"]);
    git(["commit", "--no-verify", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };

  return {
    dir,
    git,
    write,
    commitAll,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
