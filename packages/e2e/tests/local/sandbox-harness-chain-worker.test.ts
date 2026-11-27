/**
 * An explicit sandbox provider in a worker `AGENT_HARNESS` failover chain.
 *
 * Drives the real built `devintern worker` daemon with
 * `AGENT_SANDBOX=native` and `AGENT_HARNESS=claude-code,opencode`. The native
 * provider can wrap claude-code but not opencode, and the docs promise that
 * "worker runs skip any fallback entry the provider can't wrap". The primary is
 * a usage-limited stub and the fallback is a stub that records every spawn, so
 * the test proves opencode never runs (neither unsandboxed nor under a provider
 * chosen for claude-code) when the primary hits its limit. No real agent CLI,
 * sandbox binary, account, model call, or network access is involved.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { configureFailover, invocationCount, stubDiagnostics } from "../../helpers/harness-stubs";
import { cliPath, WorkerFixture } from "../../helpers/worker";

test.skipIf(!existsSync(cliPath))(
  "an explicit native provider skips an opencode fallback it cannot wrap in a worker chain",
  async () => {
    const worker = new WorkerFixture({ env: { AGENT_SANDBOX: "native" } });
    try {
      await worker.prepare();
      const stubs = configureFailover(worker, { fallbackHarness: "opencode" });
      expect(worker.env.AGENT_HARNESS).toBe("claude-code,opencode");
      const task = await worker.addTask({
        title: "Explicit provider skips an unwrappable fallback",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      const diagnostics = stubDiagnostics(worker, stubs, () => [
        `injected row: ${JSON.stringify(worker.injectedTask(task.id))}`,
        `runs: ${JSON.stringify(worker.runRecords(task.task_key))}`,
      ]);

      await worker.waitFor(
        "the primary's usage-limit window to be persisted",
        () => ((worker.rateLimits()["claude-code"] ?? 0) > Date.now() ? true : undefined),
        45_000,
      );
      // The chain is exhausted after the primary: the row is requeued (not
      // run, not failed), exactly as a fully usage-limited chain defers it.
      const row = await worker.waitFor(`injected task #${task.id} to be requeued`, () => {
        const current = worker.injectedTask(task.id);
        return current?.status === "pending" && worker.runRecords(task.task_key).length > 0
          ? current
          : undefined;
      });
      expect(row.status, diagnostics()).toBe("pending");
      const runs = worker.runRecords(task.task_key);
      expect(
        runs.map((run) => run.status),
        diagnostics(),
      ).toEqual(["deferred"]);
      expect(runs[0]?.outcome_reason ?? "", diagnostics()).toContain("usage limit");
      expect(worker.rateLimits()["claude-code"]).toBeGreaterThan(Date.now());
      expect(worker.rateLimits().opencode, diagnostics()).toBeUndefined();

      // The fallback the provider cannot wrap was never spawned: not by the
      // startup preflight, not as a failover target, and the fixture agent it
      // delegates to never ran.
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBeGreaterThanOrEqual(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(0);
      expect(worker.agentInvocations(), diagnostics()).toEqual([]);
      expect(worker.activeHarness(), diagnostics()).not.toBe("opencode");

      // Nothing was pushed and the daemon survived the exhausted chain.
      expect(await worker.remoteBranches(), diagnostics()).toEqual([worker.baseBranch]);
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);
