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
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configureFailover,
  createDelegateStub,
  invocationCount,
  settleInjectedTask as settle,
  stubDiagnostics,
} from "../../helpers/harness-stubs";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/**
 * Short real window: `resetHintToMs` accepts a seconds duration with no
 * minimum clamp, so the worker's own failback timer fires a few seconds after
 * the limit instead of an hour later.
 */
const SHORT_RESET = "resets in 4 seconds";

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

cliTest(
  "a failback while a task runs on the fallback lets that run finish there and moves the next task to the primary",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const stubs = configureFailover(worker, {
        primary: "limit-once",
        primaryResetHint: SHORT_RESET,
        fallback: "gated",
      });
      const diagnostics = stubDiagnostics(worker, stubs);
      const first = await worker.addTask({
        title: "Stay on the fallback through a failback",
        body: "Change the greeting to Hello, world! and run bun test.",
      });

      worker.start();
      await worker.waitForReady();
      // The primary limits once; the retry spawns codex, which blocks on the gate.
      await worker.waitFor("the fallback run to start", () =>
        invocationCount(stubs.fallbackInvocations) === 1 ? true : undefined,
      );

      // The primary's short window elapses while the codex run is still held.
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

      // Failback only changed the selection for future spawns: the task is
      // still running on codex and nothing was spawned on the primary.
      expect(worker.injectedTask(first.id)?.status, diagnostics()).toBe("running");
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);

      writeFileSync(stubs.fallbackGate, "");
      expect(await settle(worker, first, diagnostics), diagnostics()).toEqual([
        "deferred",
        "succeeded",
      ]);
      // The in-flight run finished where it started: one codex spawn, no
      // second primary spawn for this task, one agent run, one success record.
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(1);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);
      // The daemon switched harness once (the failover), never mid-run.
      expect(worker.logs.split("failing over to").length - 1, diagnostics()).toBe(1);
      expect(worker.activeHarness(), diagnostics()).toBe("claude-code");

      // The next task runs on the primary in one attempt.
      const second = await worker.addTask({
        title: "Run on the primary after a mid-run failback",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      expect(await settle(worker, second, diagnostics), diagnostics()).toEqual(["succeeded"]);
      expect(invocationCount(stubs.primaryInvocations), diagnostics()).toBe(2);
      expect(invocationCount(stubs.fallbackInvocations), diagnostics()).toBe(1);
      expect(worker.activeHarness(), diagnostics()).toBe("claude-code");
      expect(worker.rateLimits(), diagnostics()).toEqual({});
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // prepare + 20s readiness + 30s start wait + 20s failback wait + two 45s settles + 30s stop.
  200_000,
);
