/**
 * Project config-directory resolution.
 *
 * Durable runtime state (the task lock, auth session, and license cache) lives
 * in a project's `.devintern-code/` directory, resolved relative to the
 * working tree. Fleet task runs happen inside a throwaway worktree under the
 * workspace home, so a run that relies on the default resolution would write
 * `.pid.lock` / `license-cache.json` into the checked-out repository — and
 * `git add -A` would sweep them into the PR.
 *
 * `DEVINTERN_CONFIG_DIR` pins that resolution to one directory. The workspace
 * worker sets it to `<workspace>/.devintern-code` for every task, review, and
 * automation subprocess, so fleet state lands in the workspace home and never
 * in a repo checkout. Unset (single-repo / interactive use) keeps the existing
 * behavior unchanged.
 */

import { resolve } from "path";
import { resolveConfigDir } from "@devintern/utils";

/** Absolute config directory that durable state must use when set. */
export const CONFIG_DIR_ENV = "DEVINTERN_CONFIG_DIR";

/** Name of the per-project config directory. */
export const CONFIG_DIR_NAME = ".devintern-code";

/**
 * Marks a subprocess spawned by the workspace worker/scheduler.
 *
 * `buildRepoEnv` sets it for every task, review, and automation subprocess, so
 * process-level guards can distinguish a supervised fleet run from an operator
 * who merely exported `DEVINTERN_CONFIG_DIR` in their shell.
 */
export const WORKER_SUBPROCESS_ENV = "DEVINTERN_WORKER_SUBPROCESS";

/** Whether this process is a supervised worker/scheduler subprocess. */
export function isWorkerSubprocess(): boolean {
  return process.env[WORKER_SUBPROCESS_ENV] === "1";
}

/**
 * The `DEVINTERN_CONFIG_DIR` override, resolved to an absolute path, or
 * `undefined` when unset/blank.
 */
export function configDirOverride(): string | undefined {
  const raw = process.env[CONFIG_DIR_ENV];
  const trimmed = raw?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

/**
 * Resolve the project config directory.
 *
 * The override wins when set; otherwise the nearest existing
 * `.devintern-code` is found by walking up from `startDir` (same traversal as
 * `.env` resolution), falling back to `<startDir>/.devintern-code`.
 *
 * @param startDir - Directory to search from (defaults to `process.cwd()`).
 */
export function resolveProjectConfigDir(startDir: string = process.cwd()): string {
  return configDirOverride() ?? resolveConfigDir({ configDirName: CONFIG_DIR_NAME, startDir });
}
