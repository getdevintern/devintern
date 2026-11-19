/**
 * Worker harness failback after the reset window, and restart-time restore of
 * the persisted failover chain.
 *
 * Drives the real built `devintern worker` daemon with a two-entry
 * `AGENT_HARNESS=claude-code,codex` chain whose harness CLIs are local shell
 * stubs (`helpers/harness-stubs.ts`). The primary stub prints a recognized
 * usage-limit pair; the fallback delegates to the deterministic fixture agent.
 * No real agent CLI, account, model call, or network access is involved.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configureFailover,
  createDelegateStub,
  invocationCount,
} from "../../helpers/harness-stubs";
import type { FailoverStubs } from "../../helpers/harness-stubs";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerInjectedTask } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/**
 * Short real window: `resetHintToMs` accepts a seconds duration with no
 * minimum clamp, so the worker's own failback timer fires a few seconds after
 * the limit instead of an hour later.
 */
const SHORT_RESET = "resets in 4 seconds";

/** Run one injected task to settlement and return its run statuses. */
async function settle(
  worker: WorkerFixture,
  task: WorkerInjectedTask,
  diagnostics: () => string,
): Promise<string[]> {
  const { task: settled, runs } = await worker.waitForSettled(task.id);
  const detail = () =>
    [
      `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
        settled.message ?? "no message"
      }`,
      `runs: ${JSON.stringify(runs)}`,
      diagnostics(),
    ].join("\n");
  expect(settled.status, detail()).toBe("done");
  return runs.map((run) => run.status);
}

/** Stub invocation counts plus the daemon tail, for assertion messages. */
function stubDiagnostics(
  worker: WorkerFixture,
  stubs: FailoverStubs,
  extra: () => string[] = () => [],
) {
  return () =>
    [
      `primary invocations: ${invocationCount(stubs.primaryInvocations)}`,
      `fallback invocations: ${invocationCount(stubs.fallbackInvocations)}`,
      ...extra(),
      `rate limits: ${JSON.stringify(worker.rateLimits())}`,
      `active harness: ${worker.activeHarness() ?? "unset"}`,
      worker.tail(),
    ].join("\n");
}

cliTest(
  "worker fails back to the primary harness once its usage-limit window elapses",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker, {
        primary: "limit-once",
        primaryResetHint: SHORT_RESET,
      });
      const diagnostics = stubDiagnostics(worker, stubs);
      const first = await worker.addTask({
        title: "Fail over before the window elapses",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      expect(await settle(worker, first, diagnostics), diagnostics()).toEqual([
        "deferred",
        "succeeded",
      ]);
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
      expect(worker.logs).toContain("failing over to codex");

      // The worker's own timer clears the elapsed window and switches back.
      await worker.waitForOutput(
        /usage-limit window elapsed — failing back to primary harness claude-code \(from codex\)/,
        20_000,
        "the failback log line",
      );
      await worker.waitFor("the primary to be persisted as active again", () =>
        worker.activeHarness() === "claude-code" && worker.rateLimits()["claude-code"] === undefined
          ? true
          : undefined,
      );

      // The next task runs on the primary: its stub is spawned again (and now
      // delegates), while the fallback is not.
      const second = await worker.addTask({
        title: "Run on the primary after failback",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      expect(await settle(worker, second, diagnostics), diagnostics()).toEqual(["succeeded"]);
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(2);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([
        { mode: "implement" },
        { mode: "implement" },
      ]);
      expect(worker.activeHarness(), diagnostics()).toBe("claude-code");
      expect(worker.rateLimits(), diagnostics()).toEqual({});
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // prepare + 20s readiness + two 45s settles + 20s failback wait + 30s stop.
  180_000,
);

cliTest(
  "a restarted worker keeps the persisted fallback and never retries the limited primary",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker);
      const diagnostics = stubDiagnostics(worker, stubs);
      const first = await worker.addTask({
        title: "Fail over before the restart",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      expect(await settle(worker, first, diagnostics), diagnostics()).toEqual([
        "deferred",
        "succeeded",
      ]);
      const persisted = await worker.waitFor("the primary's window to be persisted", () =>
        (worker.rateLimits()["claude-code"] ?? 0) > Date.now()
          ? worker.rateLimits()["claude-code"]
          : undefined,
      );
      expect(worker.activeHarness(), diagnostics()).toBe("codex");
      await worker.stop();

      // Restart on the same workspace and queue DB while the hour-long window
      // is still open. Enqueue first so the injection-only workspace stays up.
      const second = await worker.addTask({
        title: "Run on the restored fallback",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();
      expect(await settle(worker, second, diagnostics), diagnostics()).toEqual(["succeeded"]);

      // The limited primary was not spawned again; the fallback ran directly.
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(2);
      expect(worker.logs, diagnostics()).not.toContain("hit a usage limit");
      expect(worker.rateLimits(), diagnostics()).toEqual({ "claude-code": persisted });
      expect(worker.activeHarness(), diagnostics()).toBe("codex");
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // prepare + two (20s readiness + 45s settle) + two 30s stops.
  200_000,
);

cliTest(
  "a restart after the chain is edited drops the removed active harness and reselects by priority",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker);
      const antigravityInvocations = join(stubs.dir, "antigravity-invocations.txt");
      const diagnostics = stubDiagnostics(worker, stubs, () => [
        `antigravity invocations: ${invocationCount(antigravityInvocations)}`,
      ]);
      const first = await worker.addTask({
        title: "Fail over before the chain edit",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      expect(await settle(worker, first, diagnostics), diagnostics()).toEqual([
        "deferred",
        "succeeded",
      ]);
      const persisted = await worker.waitFor("the primary's window to be persisted", () =>
        (worker.rateLimits()["claude-code"] ?? 0) > Date.now()
          ? worker.rateLimits()["claude-code"]
          : undefined,
      );
      expect(worker.activeHarness(), diagnostics()).toBe("codex");
      await worker.stop();

      // Replace codex with antigravity: the persisted active name has left the chain.
      worker.env.AGENT_HARNESS = "claude-code,antigravity";
      worker.env.ANTIGRAVITY_CLI_PATH = createDelegateStub(
        stubs.dir,
        "antigravity-delegate.sh",
        antigravityInvocations,
        join(worker.root, "agent.ts"),
      );
      const second = await worker.addTask({
        title: "Run after the chain edit",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();
      expect(worker.logs, diagnostics()).toContain(
        'Persisted active harness "codex" is not in the current AGENT_HARNESS chain',
      );
      expect(await settle(worker, second, diagnostics), diagnostics()).toEqual(["succeeded"]);

      // Normal selection: the primary's window is still open, so the best
      // available entry is antigravity, and that is written back as active.
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
      expect(invocationCount(antigravityInvocations), diagnostics()).toBe(1);
      expect(worker.activeHarness(), diagnostics()).toBe("antigravity");
      expect(worker.rateLimits(), diagnostics()).toEqual({ "claude-code": persisted });
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  200_000,
);
