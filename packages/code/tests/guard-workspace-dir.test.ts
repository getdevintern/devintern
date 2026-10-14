import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";

import { resolveWorkspaceDir } from "../src/lib/workspace/paths";

/**
 * Regression guard for the harness-log / workspace-home leak: the
 * DEVINTERN_WORKSPACE_DIR pin from the bunfig preload
 * (tests/setup/guard-workspace-dir.ts) and the runner (tests/run-tests.ts) must
 * be active, otherwise a test that spawns the real CLI with a stub agent writes
 * harness run transcripts and other workspace state into the developer's live
 * ~/.devintern.
 */
describe("test workspace-dir pin", () => {
  test("DEVINTERN_WORKSPACE_DIR is pinned away from the real ~/.devintern", () => {
    const pinned = process.env.DEVINTERN_WORKSPACE_DIR;
    expect(pinned).toBeDefined();
    expect(resolveWorkspaceDir()).toBe(pinned!);
    expect(pinned).not.toBe(join(homedir(), ".devintern"));
  });
});
