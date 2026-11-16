/**
 * Unit coverage for the workspace-grant fixture guard.
 *
 * A workspace-grant test only proves the explicit policy when the fixture
 * workspace is outside every default grant: the CLI policy's temp/output
 * grants and the host temp roots nono's provider profile adds. These tests
 * exercise the guard directly, including its failing branch; no CLI, sandbox
 * provider, or network is involved.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  assertWorkspaceOutsideGrants,
  SandboxWorkspace,
  sandboxDefaultWritablePaths,
  sandboxProviderTempGrants,
} from "../../helpers/sandbox";

/**
 * Create a fixture root shaped like the real one.
 *
 * @returns Root with the `tmp/` directory `sandboxEnvironment` points TMPDIR at.
 */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-guard-"));
  mkdirSync(join(root, "tmp"), { recursive: true });
  return root;
}

test("the guard rejects the old in-root workspace layout but not the sibling layout", () => {
  const root = fixtureRoot();
  try {
    // Mirror sandboxEnvironment: TMPDIR lives under the fixture root, so the
    // macOS policy temp scope is the root and the Linux scope is root/tmp.
    const grants = sandboxDefaultWritablePaths(
      { TMPDIR: join(root, "tmp"), HOME: join(root, "home") },
      join(root, "repo"),
    );

    const oldLayout = join(root, "tmp", "workspace");
    expect(() => assertWorkspaceOutsideGrants(oldLayout, grants)).toThrow(/already covered/);

    const sibling = join(dirname(root), `${basename(root)}-workspace`);
    expect(() => assertWorkspaceOutsideGrants(sibling, grants)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a grant fixture with the default root base is rejected as host-temp covered", async () => {
  // The default rootBase is the OS temp dir. The CLI policy derives its temp
  // scope from the fixture's own TMPDIR, so only the provider temp grant check
  // can catch this workspace; dropping it would let prepare() succeed.
  const run = new SandboxWorkspace({ workspaceGrants: ["state"] });
  try {
    // The previous default-only guard returns clean here: the CLI policy's temp
    // scope is the fixture's own TMPDIR, not the host temp dir.
    expect(() =>
      assertWorkspaceOutsideGrants(run.workspaceDir, sandboxDefaultWritablePaths(run.env, run.cwd)),
    ).not.toThrow();
    await expect(run.prepare()).rejects.toThrow(/provider sandbox temp/);
  } finally {
    run.dispose();
  }
});

test("the provider temp grants include the real OS temp root", () => {
  const hostTemp = realpathSync(tmpdir());
  expect(sandboxProviderTempGrants()).toContain(hostTemp);
  expect(() =>
    assertWorkspaceOutsideGrants(
      join(hostTemp, "workspace"),
      sandboxProviderTempGrants(),
      "provider sandbox temp",
    ),
  ).toThrow(/provider sandbox temp/);
});
