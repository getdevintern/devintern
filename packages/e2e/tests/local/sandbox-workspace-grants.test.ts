/**
 * End-to-end coverage for workspace sandbox grants.
 *
 * `devintern worker add` writes prompts under `<workspace>/injected/`, the
 * shared queue database under `<workspace>/state/`, and automation cursors
 * under `<workspace>/automations/`. Those paths sit outside the checkout, so a
 * sandboxed agent only reaches them because `agentSandboxPolicy()` grants the
 * directories that already exist.
 *
 * These tests drive the built CLI with the deterministic shell probe under a
 * real nono boundary. They prove an existing directory is writable, a
 * non-granted workspace sibling is denied, and an absent directory is neither
 * granted nor created implicitly. They exercise the filesystem grants directly:
 * `devintern worker add` and scheduled automations are not invoked here. No AI
 * account, tracker, network, or real repository is involved; only a local bare
 * remote and temporary directories.
 */

import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cliPath } from "../../helpers/fixture-workspace";
import { nonoPath, SandboxWorkspace, sandboxRootBaseOutsideTemp } from "../../helpers/sandbox";
import type { SandboxCheck, WorkspaceGrantName } from "../../helpers/sandbox";

const nono = nonoPath();
const rootBase = sandboxRootBaseOutsideTemp();
const missing: string[] = [];
if (!existsSync(cliPath)) missing.push("the built CLI (packages/code/dist/index.js)");
if (nono === undefined) missing.push("nono on PATH");
if (rootBase === undefined) missing.push("a fixture base outside the OS temp dir");
const skip = missing.length > 0;

if (skip) {
  console.warn(
    `Skipping workspace sandbox grant boundary tests: missing ${missing.join(" and ")}. ` +
      "Build with `bun run --filter @getdevintern/code build` and install nono " +
      "(https://nono.sh) to run them.",
  );
}

/** The three workspace directories a sandboxed agent may write. */
const GRANTED: readonly WorkspaceGrantName[] = ["injected", "state", "automations"];

/**
 * Create the fixture outside the OS temp dir so nono's built-in `/tmp` write
 * grant cannot make the workspace writes succeed on their own.
 *
 * @param workspaceGrants - Workspace directories to create before the run.
 * @returns A prepared-capable sandbox workspace.
 */
function grantFixture(workspaceGrants: readonly WorkspaceGrantName[]): SandboxWorkspace {
  if (!rootBase) {
    throw new Error("workspace grant tests require a fixture base outside the OS temp dir");
  }
  return new SandboxWorkspace({ rootBase, workspaceGrants });
}

/**
 * Assert the normal nono boundary still holds during a workspace-grant run.
 *
 * @param run - Workspace whose probe report to inspect.
 * @param checks - Parsed probe checks for that run.
 */
function expectStandardBoundary(run: SandboxWorkspace, checks: Record<string, SandboxCheck>): void {
  expect(checks["nono-marker"]?.ok).toBe(true);
  expect(checks["working-dir-write"]?.ok).toBe(true);
  expect(checks["temp-write"]?.ok).toBe(true);
  expect(checks["output-write"]?.ok).toBe(true);
  expect(checks["repo-edit"]?.ok).toBe(true);
  // The v1 policy keeps reads open but confines writes.
  expect(checks["home-read"]?.ok).toBe(true);
  expect(checks["home-write"]?.ok).toBe(false);

  if (!run.outside) {
    console.warn(
      "outside-write boundary not asserted: this host has no directory outside the OS temp dir",
    );
    expect(checks["outside-write"]).toBeUndefined();
    return;
  }
  expect(relative(realpathSync(tmpdir()), realpathSync(run.outside)).startsWith("..")).toBe(true);
  expect(checks["outside-write"]?.ok).toBe(false);
  expect(existsSync(join(run.outside, "sandbox-escape"))).toBe(false);
}

test.skipIf(skip)(
  "a nono-wrapped agent writes to existing injected/, state/, and automations/ workspace dirs",
  async () => {
    const run = await grantFixture(GRANTED).prepare();
    try {
      const result = await run.run();
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("🔒 Agent sandbox: nono (kernel sandbox)");

      const checks = run.checks();
      expectStandardBoundary(run, checks);

      for (const name of GRANTED) {
        const probe = join(run.workspaceGrantPaths[name], "sandbox-probe-write");
        expect(checks[`workspace-${name}-write`]?.ok).toBe(true);
        expect(checks[`workspace-${name}-write`]?.detail).toBe(probe);
        // The write must have landed on the host, not merely reported success.
        expect(existsSync(probe)).toBe(true);
      }

      // A sibling the policy never grants stays denied, so these grants do not
      // widen access to the whole workspace home.
      expect(checks["workspace-sibling-write"]?.ok).toBe(false);
      expect(existsSync(run.workspaceDeniedPath)).toBe(false);

      expect(await run.git("branch", "--show-current")).toBe(run.head);
      expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
    } finally {
      run.dispose();
    }
  },
  90_000,
);

/**
 * Workspace directories the CLI never creates during a task run, so an absent
 * one stays absent when the policy is built.
 *
 * `state/` is not in this list: the run recorder creates
 * `state/run-outputs/` before every agent spawn (agent-facing tools append to
 * `DEVINTERN_RUN_OUTPUTS` there with plain shell redirection), so `state/`
 * always exists by the time `agentSandboxPolicy()` runs and is granted by
 * design. Omitting it would test the run recorder, not the grant filter.
 */
const ABSENT_CANDIDATES: readonly WorkspaceGrantName[] = ["injected", "automations"];

for (const omitted of ABSENT_CANDIDATES) {
  test.skipIf(skip)(
    `a nono-wrapped agent cannot write an absent workspace grant directory (${omitted}/)`,
    async () => {
      const present = GRANTED.filter((name) => name !== omitted);
      const run = await grantFixture(present).prepare();
      try {
        // Fixture precondition: only the named directories exist before the run.
        expect(existsSync(run.workspaceGrantPaths[omitted])).toBe(false);

        const result = await run.run();
        const text = `${result.stdout}\n${result.stderr}`;
        expect(result.exitCode).toBe(0);
        expect(text).toContain("🔒 Agent sandbox: nono (kernel sandbox)");

        const checks = run.checks();
        expectStandardBoundary(run, checks);

        // The absent directory was not granted, and the CLI did not create it
        // implicitly or widen the grant to the whole workspace.
        expect(checks[`workspace-${omitted}-write`]?.ok).toBe(false);
        expect(existsSync(run.workspaceGrantPaths[omitted])).toBe(false);

        for (const name of present) {
          const probe = join(run.workspaceGrantPaths[name], "sandbox-probe-write");
          expect(checks[`workspace-${name}-write`]?.ok).toBe(true);
          expect(existsSync(probe)).toBe(true);
        }
        expect(checks["workspace-sibling-write"]?.ok).toBe(false);
        expect(existsSync(run.workspaceDeniedPath)).toBe(false);

        expect(await run.git("branch", "--show-current")).toBe(run.head);
        expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
      } finally {
        run.dispose();
      }
    },
    90_000,
  );
}
