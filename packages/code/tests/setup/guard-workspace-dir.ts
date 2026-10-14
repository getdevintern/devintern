/**
 * Test setup guard — preloaded before every test via `bunfig.toml`.
 *
 * Pins `DEVINTERN_WORKSPACE_DIR` to a unique mkdtemp directory for this
 * test-file process so default resolution of the workspace home
 * (`~/.devintern`) can never write into a developer's live tree.
 *
 * The clearest symptom was harness run transcripts piling up in
 * `~/.devintern/logs/harness/` whenever a test spawned the real CLI with a
 * stub agent (e.g. `markdown-file.test.ts` runs `/usr/bin/true` through the
 * real spawn path, which attaches the real harness-log sink). The same pin
 * keeps test-spawned CLI/worker processes from touching the live repos mirror,
 * worktrees, locks, and auth state too.
 *
 * Mirrors `guard-queue-db.ts`: the value is set unconditionally here (a value
 * inherited from the developer's shell must not win) and tests that manipulate
 * it save/restore, so restoring lands back on the pin. `tests/run-tests.ts`
 * also seeds the same pin into the child environment so CLI subprocesses
 * spawned WITHOUT an explicit env option inherit it.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Unique per-test-file temp workspace root; removed at process exit. */
const workspaceRoot = mkdtempSync(join(tmpdir(), "devintern-test-workspace-"));

process.env.DEVINTERN_WORKSPACE_DIR = workspaceRoot;

process.on("exit", () => {
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    // Best effort: leftover temp state under the OS tmpdir is harmless.
  }
});
