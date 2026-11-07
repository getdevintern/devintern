/**
 * Guard preload files, in load order.
 *
 * Single source of truth shared by:
 * - `tests/run-tests.ts`, which passes them as explicit `--preload` flags
 *   because Bun only reads bunfig.toml from the process cwd (`tests/`).
 * - `tests/guard-sentry.test.ts`, which asserts both packages/code/bunfig.toml
 *   and the repo-root bunfig.toml preload exactly this set of files.
 *
 * Adding a guard means adding it here and to both bunfig.toml files.
 */
export const GUARD_FILES = [
  "guard-git-state.ts",
  "guard-queue-db.ts",
  "guard-workspace-dir.ts",
  "guard-sentry.ts",
  "guard-worker-env.ts",
] as const;
