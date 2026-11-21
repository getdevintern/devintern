/**
 * `devintern worker cancel` and the dashboard's `POST /api/tasks/:id/cancel`:
 * withdraw a pending ad-hoc task, and refuse `worker add --resume` on it.
 *
 * State is read through `worker queue --json` and `worker runs … --json`
 * only. The CLI test's workspace omits `--create-pr`, since the local bare
 * remote cannot host a PR; the dashboard test keeps the default task args so
 * runs push branches the test can check on the bare remote.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CleanupFailure } from "../../helpers/cleanup";
import { throwCleanupFailures } from "../../helpers/cleanup";
import { DashboardFixture, dashboardWriteHeaders } from "../../helpers/dashboard";
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

interface DashboardCancel {
  status: number;
  body: Partial<CancelJson> & { error?: string };
}

/** `POST /api/tasks/<id>/cancel`; `headers: false` omits the CSRF guard headers. */
async function dashboardCancel(
  dashboard: DashboardFixture,
  id: string | number,
  body: unknown,
  options: { headers?: boolean } = {},
): Promise<DashboardCancel> {
  const response = await fetch(
    `${dashboard.baseUrl}/api/tasks/${encodeURIComponent(String(id))}/cancel`,
    {
      method: "POST",
      headers: options.headers === false ? {} : dashboardWriteHeaders(dashboard.baseUrl),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: response.status, body: (await response.json()) as DashboardCancel["body"] };
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

cliTest(
  "dashboard Cancel task withdraws pending tasks, validates input, and --resume refuses them",
  async () => {
    // Default task args (`--create-pr`) so a run pushes its branch to the bare
    // remote, which makes "no branch for a cancelled task" meaningful.
    const worker = new WorkerFixture();
    let dashboard: DashboardFixture | undefined;
    let waiter: ReturnType<WorkerFixture["spawnCli"]> | undefined;
    try {
      await worker.prepare();
      dashboard = await DashboardFixture.start(worker, { args: ["--no-tailscale-autodetect"] });

      // Validation: none of these touches the row.
      const byId = await add(worker, ["--title", "Cancelled by row id"]);
      const unguarded = await dashboardCancel(dashboard, byId.taskKey, undefined, {
        headers: false,
      });
      expect(unguarded.status).toBe(403);
      const numericReason = await dashboardCancel(dashboard, byId.taskKey, { reason: 42 });
      expect(numericReason).toEqual({ status: 400, body: { error: "reason must be a string" } });
      const longReason = await dashboardCancel(dashboard, byId.taskKey, {
        reason: "x".repeat(501),
      });
      expect(longReason.status).toBe(400);
      expect(longReason.body.error).toContain("too long");
      const afterRejected = await cliQueue(worker);
      expect(afterRejected.items.map((item) => item.taskKey)).toContain(byId.taskKey);
      expect(afterRejected.cancelled.map((item) => item.taskKey)).not.toContain(byId.taskKey);

      // Cancel by numeric row id reports the task key.
      const viaId = await dashboardCancel(dashboard, byId.id, undefined);
      expect(viaId.status).toBe(200);
      expect(viaId.body).toMatchObject({ taskKey: byId.taskKey, outcome: "cancelled" });

      // A slow task holds the only slot so later tasks stay pending; the
      // dashboard refuses to cancel the running one.
      worker.env.E2E_AGENT_DELAY_MS = "15000";
      const slow = await add(worker, [
        "--title",
        "Slow dashboard task",
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
      const running = await dashboardCancel(dashboard, slow.taskKey, { reason: "too late" });
      expect(running.status).toBe(409);
      expect(running.body).toMatchObject({ taskKey: slow.taskKey, outcome: "already_started" });

      // Cancel by task key wakes a `worker add --wait` waiter (which needs a
      // running worker).
      waiter = worker.spawnCli([
        "worker",
        "add",
        "--title",
        "Cancelled from the dashboard",
        "--body",
        "Make the greeting friendlier.",
        "--wait",
        "--json",
      ]);
      const waitedKey = await pollCli(worker, "the --wait task to be queued", async () =>
        (await pendingKeys(worker)).find((key) => key.includes("cancelled-from-the-dashboard")),
      );
      const cancelledAt = Date.now();
      const viaKey = await dashboardCancel(dashboard, waitedKey, { reason: "e2e" });
      expect(viaKey.status, JSON.stringify(viaKey.body)).toBe(200);
      expect(viaKey.body).toMatchObject({ taskKey: waitedKey, outcome: "cancelled" });
      expect(typeof viaKey.body.message).toBe("string");
      const waited = await waiter.result;
      expect(Date.now() - cancelledAt).toBeLessThan(10_000);
      expect(waited.exitCode, waited.stderr).toBe(3);
      expect(singleJson(waited)).toMatchObject({ taskKey: waitedKey, status: "cancelled" });

      const afterCancel = await cliQueue(worker);
      expect(afterCancel.items.map((item) => item.taskKey)).not.toContain(waitedKey);
      expect(afterCancel.items.map((item) => item.taskKey)).not.toContain(byId.taskKey);
      expect(afterCancel.cancelled).toContainEqual(
        expect.objectContaining({
          taskKey: waitedKey,
          cancelledBy: "dashboard",
          cancelReason: "e2e",
        }),
      );
      expect(afterCancel.cancelled).toContainEqual(
        expect.objectContaining({ taskKey: byId.taskKey, cancelledBy: "dashboard" }),
      );

      const again = await dashboardCancel(dashboard, waitedKey, { reason: "second" });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ taskKey: waitedKey, outcome: "already_cancelled" });
      const unknown = await dashboardCancel(dashboard, "local-no-such-task", undefined);
      expect(unknown.status).toBe(404);
      expect(unknown.body.outcome).toBe("not_found");

      // `--resume` refuses a cancelled task and enqueues nothing.
      for (const key of [waitedKey, byId.taskKey]) {
        const resumed = await worker.runAdd(["--resume", key, "--json"]);
        expect(resumed.exitCode).not.toBe(0);
        expect(resumed.stderr).toContain(`${key} was cancelled`);
        expect(resumed.stderr).toContain("a cancelled task cannot be resumed");
        expect(resumed.stdout.trim()).toBe("");
      }
      const afterResume = await cliQueue(worker);
      expect(afterResume.items.map((item) => item.taskKey)).not.toContain(waitedKey);
      expect(afterResume.items.map((item) => item.taskKey)).not.toContain(byId.taskKey);
      expect(afterResume.cancelled).toContainEqual(
        expect.objectContaining({
          taskKey: waitedKey,
          cancelledBy: "dashboard",
          cancelReason: "e2e",
        }),
      );
      expect(afterResume.cancelled.map((item) => item.taskKey)).toContain(byId.taskKey);

      // The refused cancel left the running task alone.
      const [slowRun] = await waitForSettledRun(worker, slow.taskKey);
      expect(slowRun!.status).toBe("succeeded");
      expect((await cliQueue(worker)).cancelled.map((item) => item.taskKey)).not.toContain(
        slow.taskKey,
      );

      const finished = await dashboardCancel(dashboard, slow.taskKey, undefined);
      expect(finished.status).toBe(409);
      expect(finished.body).toMatchObject({ taskKey: slow.taskKey, outcome: "already_finished" });

      // A later task completes, so the drain had every chance to start the
      // cancelled ones: they have no run and no branch on the bare remote.
      const sentinel = await add(worker, ["--title", "Sentinel after dashboard cancels"]);
      const [sentinelRun] = await waitForSettledRun(worker, sentinel.taskKey);
      expect(sentinelRun!.status).toBe("succeeded");
      expect(await cliRuns(worker, waitedKey)).toHaveLength(0);
      expect(await cliRuns(worker, byId.taskKey)).toHaveLength(0);
      const branches = await worker.remoteBranches();
      expect(
        branches.some((branch) => branch.includes(slow.taskKey)),
        branches.join(", "),
      ).toBe(true);
      for (const key of [waitedKey, byId.taskKey]) {
        expect(
          branches.some((branch) => branch.includes(key)),
          branches.join(", "),
        ).toBe(false);
      }
    } finally {
      const failures: CleanupFailure[] = [];
      for (const [resource, step] of [
        ["background --wait process", () => waiter?.kill()],
        ["dashboard", () => dashboard?.stop()],
        ["worker fixture", () => worker.dispose()],
      ] as Array<[string, () => Promise<unknown> | void]>) {
        try {
          await step();
        } catch (error) {
          failures.push({ resource, error });
        }
      }
      throwCleanupFailures("dashboard cancel test cleanup failed", failures);
    }
  },
  240_000,
);
