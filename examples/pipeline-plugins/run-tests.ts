#!/usr/bin/env bun
/**
 * Runner for the pipeline-plugin example suite.
 *
 * Matches the environment hygiene of `packages/code/tests/run-tests.ts`: it
 * gives every child a safe temporary queue database and workspace directory,
 * disables production error reporting, and pins `GIT_CEILING_DIRECTORIES` so a
 * fixture `git init` can never discover (and rewrite) the real repository.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "pipeline-plugin-examples-"));
process.on("exit", () => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const gitCeilingDirectories = [resolve(tmpdir()), process.env.GIT_CEILING_DIRECTORIES]
  .filter((value): value is string => Boolean(value))
  .join(delimiter);

// Discover only the example suites. Fixture projects under `fixtures/` include
// deliberately failing tests (for the run-tests example) and must not be picked
// up by the top-level run.
const explicit = process.argv.slice(2);
const discovered =
  explicit.length > 0
    ? explicit
    : [...new Bun.Glob("**/tests/*.test.ts").scanSync({ cwd: import.meta.dir })];

const child = Bun.spawn(["bun", "test", "--timeout=30000", ...discovered], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories,
    WEBHOOK_QUEUE_DB: join(tempDir, "queue.db"),
    DEVINTERN_WORKSPACE_DIR: join(tempDir, "workspace"),
    SENTRY_DISABLED: "1",
    BUN_TMPDIR: process.env.BUN_TMPDIR ?? tempDir,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
