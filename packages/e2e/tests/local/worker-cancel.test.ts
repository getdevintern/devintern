/**
 * `devintern worker cancel`: withdraw a pending ad-hoc task.
 *
 * State is read through `worker queue --json` and `worker runs … --json`
 * only. The workspace omits `--create-pr`, since the local bare remote cannot
 * host a PR.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CleanupFailure } from "../../helpers/cleanup";
import { throwCleanupFailures } from "../../helpers/cleanup";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAddResult } from "../../helpers/worker";
import {
  cliQueue,
  cliRuns,
  pollCli,
  singleJson,
  waitForSettledRun,
} from "../../helpers/worker-cli-state";

const cliTest = test.skipIf(!existsSync(cliPath));

interface AddJson {
  id: number;
  taskKey: string;
  status: string;
  dependsOn?: string[];
  dependencyState?: string;
  dependencyReason?: string;
}

interface CancelJson {
  taskKey: string;
  outcome: string;
  message: string;
}

async function add(worker: WorkerFixture, args: string[]): Promise<AddJson> {
  const result = await worker.runAdd([...args, "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return singleJson<AddJson>(result);
}

function cancel(worker: WorkerFixture, args: string[]): Promise<WorkerAddResult> {
  return worker.runCli(["worker", "cancel", ...args, "--json"]);
}

async function pendingKeys(worker: WorkerFixture): Promise<string[]> {
  return (await cliQueue(worker)).items.flatMap((item) => (item.taskKey ? [item.taskKey] : []));
}

cliTest(
  "worker cancel withdraws pending tasks, wakes --wait, and refuses running ones",
  async () => {
    const worker = new WorkerFixture({ workerTaskArgs: "--skip-clarity-check --skip-comments" });
    let waiter: ReturnType<WorkerFixture["spawnCli"]> | undefined;
    try {
      await worker.prepare();

      // No worker running: cancel a pending task directly.
      const queued = await add(worker, ["--title", "Withdrawn before any worker"]);
      const first = await cancel(worker, [queued.taskKey, "--reason", "wrong repo"]);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(singleJson<CancelJson>(first)).toMatchObject({
        taskKey: queued.taskKey,
        outcome: "cancelled",
      });
      const afterCancel = await cliQueue(worker);
      expect(afterCancel.items.map((item) => item.taskKey)).not.toContain(queued.taskKey);
      expect(afterCancel.cancelled).toContainEqual(
        expect.objectContaining({
          taskKey: queued.taskKey,
          cancelledBy: "cli",
          cancelReason: "wrong repo",
        }),
      );

      const again = await cancel(worker, [queued.taskKey]);
      expect(again.exitCode, again.stderr).toBe(0);
      expect(singleJson<CancelJson>(again).outcome).toBe("already_cancelled");
      // The first cancel's reason is kept.
      expect(
        (await cliQueue(worker)).cancelled.find((item) => item.taskKey === queued.taskKey)
          ?.cancelReason,
      ).toBe("wrong repo");

      const unknown = await cancel(worker, ["local-no-such-task"]);
      expect(unknown.exitCode).toBe(1);
      expect(singleJson<CancelJson>(unknown).outcome).toBe("not_found");

      // A dependent of a cancelled task is blocked.
      const dependent = await add(worker, [
        "--title",
        "After the withdrawn task",
        "--after",
        queued.taskKey,
      ]);
      expect(dependent.dependsOn).toEqual([queued.taskKey]);
      expect(dependent.dependencyState).toBe("blocked");
      expect(dependent.dependencyReason).toContain(queued.taskKey);

      // A slow task holds the only slot so the next one stays pending.
      worker.env.E2E_AGENT_DELAY_MS = "15000";
      const slow = await add(worker, [
        "--title",
        "Slow running task",
        "--body",
        "Change the greeting to Hello, world!",
      ]);
      worker.start();
      await worker.waitForReady();
      await pollCli(worker, `${slow.taskKey} to start`, async () =>
        (await cliRuns(worker, slow.taskKey)).some((run) => run.status === "in_progress")
          ? true
          : undefined,
      );
      // A running task cannot be cancelled and completes normally.
      const running = await cancel(worker, [slow.taskKey]);
      expect(running.exitCode).toBe(1);
      expect(singleJson<CancelJson>(running).outcome).toBe("already_started");

      waiter = worker.spawnCli([
        "worker",
        "add",
        "--title",
        "Cancelled while waiting",
        "--body",
        "Make the greeting friendlier.",
        "--wait",
        "--json",
      ]);
      const waitedKey = await pollCli(worker, "the --wait task to be queued", async () =>
        (await pendingKeys(worker)).find((key) => key.includes("cancelled-while-waiting")),
      );

      const cancelledAt = Date.now();
      const waitedCancel = await cancel(worker, [waitedKey, "--reason", "duplicate"]);
      expect(waitedCancel.exitCode, waitedCancel.stderr).toBe(0);
      expect(singleJson<CancelJson>(waitedCancel).outcome).toBe("cancelled");

      const waited = await waiter.result;
      expect(Date.now() - cancelledAt).toBeLessThan(10_000);
      expect(waited.exitCode, waited.stderr).toBe(3);
      expect(singleJson(waited)).toMatchObject({ taskKey: waitedKey, status: "cancelled" });
      const queueAfterWait = await cliQueue(worker);
      expect(queueAfterWait.items.map((item) => item.taskKey)).not.toContain(waitedKey);
      expect(queueAfterWait.cancelled.map((item) => item.taskKey)).toContain(waitedKey);

      // The running task was left alone and completes normally.
      const [slowRun] = await waitForSettledRun(worker, slow.taskKey);
      expect(slowRun!.status).toBe("succeeded");

      // A later task runs to completion, so the drain had every chance to
      // start the cancelled tasks or the blocked dependent.
      const sentinel = await add(worker, ["--title", "Sentinel after cancels"]);
      const [sentinelRun] = await waitForSettledRun(worker, sentinel.taskKey);
      expect(sentinelRun!.status).toBe("succeeded");
      expect(await cliRuns(worker, queued.taskKey)).toHaveLength(0);
      expect(await cliRuns(worker, waitedKey)).toHaveLength(0);
      expect(await cliRuns(worker, dependent.taskKey)).toHaveLength(0);
      const finalQueue = await cliQueue(worker);
      const blocked = finalQueue.items.find((item) => item.taskKey === dependent.taskKey);
      expect(blocked?.dependencyState).toBe("blocked");
      expect(blocked?.dependencyReason).toContain(queued.taskKey);
    } finally {
      const failures: CleanupFailure[] = [];
      for (const [resource, step] of [
        ["background --wait process", () => waiter?.kill()],
        ["worker fixture", () => worker.dispose()],
      ] as Array<[string, () => Promise<void> | void]>) {
        try {
          await step();
        } catch (error) {
          failures.push({ resource, error });
        }
      }
      throwCleanupFailures("worker cancel test cleanup failed", failures);
    }
  },
  240_000,
);
