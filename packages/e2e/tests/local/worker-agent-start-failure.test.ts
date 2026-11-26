/**
 * An agent CLI that exits 1 before producing any output (bad API key, missing
 * login) must not loop forever behind a healthy-looking worker.
 *
 * Drives the real built `devintern worker` daemon with a shell stub in place
 * of the agent: it prints a login error to stderr and exits 1, which the
 * worker classifies as a harness that could not start. With a two-attempt
 * budget the task is deferred once (visible in `worker queue` and
 * `worker status` with the error and a fix hint), then settled failed. No
 * real agent CLI, account, or network access is involved.
 */

import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/** Error the stub prints; it carries a credential-shaped value that must be redacted. */
const STUB_ERROR = "Invalid API key · Please run /login";
const STUB_SECRET = "sk-ant-api03-e2eNotARealKeyAbcdefghijklmnopqrstuvwx";

interface StartFailure {
  taskKey: string;
  state: "retrying" | "failed";
  attempts: number;
  error: string;
  hint: string;
}

/** Write an agent stub that fails every run before printing anything to stdout. */
function writeBrokenAgent(worker: WorkerFixture): { path: string; invocations: string } {
  const path = join(worker.root, "broken-agent.sh");
  const invocations = join(worker.root, "broken-agent-invocations.log");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      // Version probes are not task runs; answer them like a real CLI would.
      'if [ "$1" = "--version" ]; then echo "1.0.0 (stub)"; exit 0; fi',
      `echo run >> "${invocations}"`,
      `echo "${STUB_ERROR} (ANTHROPIC_API_KEY=${STUB_SECRET})" >&2`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { path, invocations };
}

function invocationCount(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

cliTest(
  "an agent CLI that exits 1 at once is retried with backoff, then failed, and shown in queue and status",
  async () => {
    const worker = new WorkerFixture({
      env: { DEVINTERN_AGENT_START_MAX_ATTEMPTS: "2" },
    });
    try {
      await worker.prepare();
      const stub = writeBrokenAgent(worker);
      worker.env.AGENT_CLI_PATH = stub.path;
      const diagnostics = () =>
        `${worker.tail()}\nruns: ${JSON.stringify(worker.runRecords(), null, 2)}`;

      const task = await worker.addTask({
        title: "Change the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();

      // First attempt: deferred with the stderr tail, not failed.
      const deferred = await worker.waitFor(
        "the first start failure to be deferred",
        () => {
          const runs = worker.runRecords(task.task_key);
          return runs.length === 1 &&
            runs[0]!.status === "deferred" &&
            worker.injectedTask(task.id)?.status === "pending"
            ? runs[0]
            : undefined;
        },
        45_000,
      );
      expect(deferred.outcome_reason, diagnostics()).toStartWith("agent_start: ");
      expect(deferred.outcome_reason, diagnostics()).toContain(STUB_ERROR);
      expect(deferred.outcome_reason, diagnostics()).not.toContain(STUB_SECRET);
      expect(invocationCount(stub.invocations), diagnostics()).toBe(1);

      // `worker queue` lists the waiting task and why, even though it has no PR or run in flight.
      const queue = await worker.runCli(["worker", "queue"]);
      expect(queue.exitCode, queue.stderr).toBe(0);
      expect(queue.stdout, queue.stdout).toContain("the agent CLI is failing to start");
      expect(queue.stdout).toContain(
        `${task.task_key} (${worker.repoName}): retrying with backoff`,
      );
      expect(queue.stdout).toContain(STUB_ERROR);
      expect(queue.stdout).toContain("run `claude` once in a terminal to log in");
      expect(queue.stdout).not.toContain(STUB_SECRET);

      const statusJson = await worker.runCli(["worker", "status", "--json"]);
      expect(statusJson.exitCode, statusJson.stderr).toBe(0);
      const status = JSON.parse(statusJson.stdout) as { agentStartFailures?: StartFailure[] };
      expect(
        status.agentStartFailures?.map(({ taskKey, state, attempts }) => ({
          taskKey,
          state,
          attempts,
        })),
      ).toEqual([{ taskKey: task.task_key, state: "retrying", attempts: 1 }]);
      expect(status.agentStartFailures?.[0]?.hint).toContain("ANTHROPIC_API_KEY");

      // Second attempt (after the one-minute backoff) spends the budget: the
      // run is failed and the task leaves the queue instead of looping.
      const settled = await worker.waitForSettled(task.id, 150_000);
      expect(settled.task.status, diagnostics()).toBe("failed");
      expect(
        settled.runs.map((run) => run.status),
        diagnostics(),
      ).toEqual(["deferred", "failed"]);
      expect(settled.runs[1]!.outcome_reason, diagnostics()).toStartWith("agent_start: ");
      expect(settled.runs[1]!.outcome_reason).toContain(STUB_ERROR);
      expect(invocationCount(stub.invocations), diagnostics()).toBe(2);

      const status2 = await worker.runCli(["worker", "status"]);
      expect(status2.exitCode, status2.stderr).toBe(0);
      expect(status2.stdout).toContain(
        `${task.task_key} (${worker.repoName}): gave up after 2 attempt(s)`,
      );
      expect(status2.stdout).toContain(STUB_ERROR);
      expect(status2.stdout).toContain("Fix:");

      const queue2 = await worker.runCli(["worker", "queue", "--json"]);
      const queueBody = JSON.parse(queue2.stdout) as {
        items: unknown[];
        agentStartFailures?: StartFailure[];
      };
      expect(queueBody.items, queue2.stdout).toEqual([]);
      expect(queueBody.agentStartFailures?.[0]?.state).toBe("failed");

      // Debug worktrees stay bounded however many attempts failed.
      const debugWorktrees = worker.taskWorktrees().filter((entry) => entry !== "pr-jobs");
      expect(debugWorktrees.length, diagnostics()).toBeLessThanOrEqual(2);

      // No further attempts: the worker does not keep relaunching the agent.
      await Bun.sleep(3_000);
      expect(invocationCount(stub.invocations), diagnostics()).toBe(2);
      expect(worker.runRecords(task.task_key), diagnostics()).toHaveLength(2);
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // prepare + readiness + first attempt + 60s backoff + second attempt + checks.
  240_000,
);
