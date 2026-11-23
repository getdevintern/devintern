/**
 * Worker restart while every harness of the failover chain is still inside
 * its persisted usage-limit window (start paused).
 *
 * Drives the real built `devintern worker` daemon with a two-entry
 * `AGENT_HARNESS=claude-code,codex` chain of local shell stubs
 * (`helpers/harness-stubs.ts`). No real agent CLI, account, model call, or
 * network access is involved.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  configureFailover,
  invocationCount,
  settleInjectedTask as settle,
  stubDiagnostics,
} from "../../helpers/harness-stubs";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/**
 * Window for the start-paused restart: long enough to outlive a stop, an
 * enqueue, and a restart (a few seconds even under a parallel suite), short
 * enough that the test then waits for it instead of faking the clock.
 */
const PAUSE_RESET = "resets in 15 seconds";

cliTest(
  "a worker restarted while every harness is still usage-limited starts paused and resumes on the primary",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      // Both entries limit on their first spawn; the primary's window is short
      // and its stub delegates afterwards, the fallback's window is an hour.
      const stubs = configureFailover(worker, {
        primary: "limit-once",
        primaryResetHint: PAUSE_RESET,
        fallback: "limit",
      });
      const diagnostics = stubDiagnostics(worker, stubs);
      const first = await worker.addTask({
        title: "Exhaust the chain before the restart",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(/All harnesses in the chain are usage-limited/);
      const windows = await worker.waitFor("both windows and the deferred row", () => {
        const limits = worker.rateLimits();
        return (limits["claude-code"] ?? 0) > Date.now() &&
          (limits.codex ?? 0) > Date.now() &&
          worker.injectedTask(first.id)?.status === "pending"
          ? limits
          : undefined;
      });
      const primaryUntil = windows["claude-code"]!;
      expect(windows.codex, diagnostics()).toBeGreaterThan(primaryUntil);
      const firstRuns = worker.runRecords(first.task_key).map((run) => run.status);
      expect(firstRuns, diagnostics()).toEqual(["deferred", "deferred"]);
      const firstDeferral = worker.injectedDeferral(first.id);
      expect(firstDeferral?.defer_count, diagnostics()).toBe(1);
      await worker.stop();

      // Enqueue while the worker is down: `worker add --json` reports the
      // pause from the persisted windows (the earliest one ends it).
      const added = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "Run once the paused chain resumes",
        "--body",
        "Change the greeting to Hello, world! and run bun test.",
        "--json",
      ]);
      expect(added.exitCode, added.stderr).toBe(0);
      const parsed = JSON.parse(added.stdout.trim()) as { id: number; harnessPausedUntil?: string };
      const pausedUntil = new Date(primaryUntil).toISOString();
      expect(parsed.harnessPausedUntil, added.stdout).toBe(pausedUntil);
      expect(added.stderr).toContain(`is usage-limited until ${pausedUntil}`);
      const second = worker.injectedTask(parsed.id);
      expect(second?.status).toBe("pending");

      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /no fallback harness is available\. Deferring new agent work until /,
        20_000,
        "the start-paused log line",
      );
      expect(worker.logs, diagnostics()).toContain(`Deferring new agent work until ${pausedUntil}`);
      expect(Date.now(), "the restart must finish inside the primary's window").toBeLessThan(
        primaryUntil,
      );

      // While paused nothing is spawned, claimed, recorded, or charged to the
      // deferral budget. Poll until just before the window ends.
      while (Date.now() < primaryUntil - 500) {
        expect(worker.running, diagnostics()).toBe(true);
        expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
        expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
        expect(worker.injectedTask(first.id)?.status, diagnostics()).toBe("pending");
        expect(worker.injectedTask(parsed.id)?.status, diagnostics()).toBe("pending");
        expect(worker.injectedDeferral(first.id), diagnostics()).toEqual(firstDeferral);
        expect(worker.injectedDeferral(parsed.id)?.defer_count, diagnostics()).toBe(0);
        expect(worker.runRecords(), diagnostics()).toHaveLength(2);
        await Bun.sleep(250);
      }
      // The restart recorded no fresh limit: it paused on the restored windows.
      expect(worker.logs, diagnostics()).not.toContain(
        "All harnesses in the chain are usage-limited",
      );
      expect(worker.logs, diagnostics()).not.toContain("Agent usage limit reached");
      expect(worker.rateLimits(), diagnostics()).toEqual(windows);

      // The worker's own timer ends the pause; the new task runs once on the
      // highest-priority harness.
      await worker.waitForOutput(
        /Usage-limit windows elapsed — resuming agent work/,
        20_000,
        "the resume log line",
      );
      expect(await settle(worker, second!, diagnostics), diagnostics()).toEqual(["succeeded"]);
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(2);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);
      expect(worker.rateLimits(), diagnostics()).toEqual({ codex: windows.codex });

      // The task deferred before the restart keeps its own backoff and budget.
      expect(Date.now(), "first task's backoff must still be open").toBeLessThan(
        firstDeferral?.not_before ?? 0,
      );
      expect(worker.injectedTask(first.id)?.status, diagnostics()).toBe("pending");
      expect(worker.injectedDeferral(first.id), diagnostics()).toEqual(firstDeferral);
      expect(
        worker.runRecords(first.task_key).map((run) => run.status),
        diagnostics(),
      ).toEqual(firstRuns);
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // prepare + two (20s readiness + 30s stop) + 15s window + 20s resume + 45s settle.
  220_000,
);
