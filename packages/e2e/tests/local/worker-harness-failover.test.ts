/**
 * Worker harness failover on a usage limit.
 *
 * Drives the real built `devintern worker` daemon with a two-entry
 * `AGENT_HARNESS` chain (`claude-code,codex`) whose harness CLIs are local
 * stubs under the fixture root. The primary stub prints a recognized
 * usage-limit line and exits non-zero; the fallback either delegates to the
 * deterministic fixture agent or also reports a limit. No real agent CLI,
 * account, model call, or network access is involved.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { configureFailover, invocationCount } from "../../helpers/harness-stubs";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/** Branch refs currently present on the local bare remote. */
async function remoteBranches(worker: WorkerFixture): Promise<string[]> {
  const output = await checkedCommand(
    ["git", "--git-dir", worker.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    worker.root,
    worker.env,
  );
  return output.split("\n").filter(Boolean);
}

cliTest(
  "worker fails over from a usage-limited primary harness and completes on the fallback",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker);
      const task = await worker.addTask({
        title: "Expand the greeting across harnesses",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      // Enqueue before startup so the injection-only workspace stays valid.
      worker.start();
      await worker.waitForReady();
      const { task: settled, runs } = await worker.waitForSettled(task.id);

      const diagnostics = () =>
        [
          `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
            settled.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(runs)}`,
          `primary invocations: ${invocationCount(stubs.primaryInvocations)}`,
          `fallback invocations: ${invocationCount(stubs.fallbackInvocations)}`,
          worker.tail(),
        ].join("\n");

      expect(settled.status, diagnostics()).toBe("done");
      const succeeded = runs.filter((run) => run.status === "succeeded");
      expect(succeeded, diagnostics()).toHaveLength(1);
      // The limited attempt is recorded as deferred (never failed), then the
      // retried attempt succeeds on the fallback.
      expect(
        runs.map((run) => run.status),
        diagnostics(),
      ).toEqual(["deferred", "succeeded"]);

      // Only the fallback reached the deterministic agent, and the primary was
      // spawned exactly once: no retry after its limit.
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);

      // The primary hit its limit after `prepare-branch` had already created
      // the unsuffixed feature ref (nothing was pushed), so the failover retry
      // is a fresh attempt and lands on the documented `-attempt-2` suffix.
      // Assert against the branch the successful run recorded, which is the
      // ref the daemon actually pushed.
      const expectedBranch = `feature/${task.task_key}`;
      const branch = succeeded[0]?.branch ?? "";
      expect(branch, diagnostics()).toBe(`${expectedBranch}-attempt-2`);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      const changed = await checkedCommand(
        ["git", "--git-dir", worker.remote, "diff", "--name-only", worker.baseBranch, branch],
        worker.root,
        worker.env,
      );
      expect(changed.split("\n").filter(Boolean)).toEqual(["src/greeting.ts"]);

      // The worker names the failover instead of reporting a generic failure.
      expect(worker.logs).toContain("claude-code hit a usage limit");
      expect(worker.logs).toContain("failing over to codex");
      expect(worker.logs).not.toContain("task pipeline did not complete cleanly");
      expect(worker.logs).not.toContain("keeping worktree for debugging");

      // The queue persists the primary's future window and the fallback as the
      // active harness, so a restart does not retry the limited entry.
      const limits = await worker.waitFor("the primary's usage-limit window to be persisted", () =>
        (worker.rateLimits()["claude-code"] ?? 0) > Date.now() ? worker.rateLimits() : undefined,
      );
      expect(limits["claude-code"]).toBeGreaterThan(Date.now());
      expect(worker.activeHarness()).toBe("codex");
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Must exceed the helper's worst case: 20s readiness + 45s settle + 30s wait
  // + 25s SIGTERM + 5s SIGKILL, plus prepare() and daemon work.
  180_000,
);

cliTest(
  "worker defers the task and stays alive when every harness is usage-limited",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker, { fallback: "limit" });
      const task = await worker.addTask({
        title: "Every harness is limited",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(/All harnesses in the chain are usage-limited/);
      await worker.waitForOutput(/deferred \(1\/\d+\); next attempt after /);

      const limits = await worker.waitFor("both harnesses to be persisted as usage-limited", () => {
        const windows = worker.rateLimits();
        return (windows["claude-code"] ?? 0) > Date.now() && (windows.codex ?? 0) > Date.now()
          ? windows
          : undefined;
      });
      expect(limits["claude-code"]).toBeGreaterThan(Date.now());
      expect(limits.codex).toBeGreaterThan(Date.now());
      expect(worker.activeHarness()).toBe("codex");

      // The exhausted chain defers the row instead of settling it.
      const row = await worker.waitFor(`injected task #${task.id} to be requeued`, () => {
        const current = worker.injectedTask(task.id);
        return current?.status === "pending" ? current : undefined;
      });
      expect(row.status).toBe("pending");
      const runs = worker.runRecords(task.task_key);
      expect(runs.map((run) => run.status)).toEqual(["deferred", "deferred"]);
      expect(invocationCount(stubs.primaryInvocations)).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations)).toBe(1);

      // No branch was pushed and the daemon survived the exhausted chain.
      expect(await remoteBranches(worker)).toEqual([worker.baseBranch]);
      expect(worker.running).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);
