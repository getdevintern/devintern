/**
 * Retry a failed ad-hoc run through the dashboard embedded in a running worker
 * (retryMode `schedule`), against the built CLI.
 *
 * Production behavior under test:
 * - `packages/code/src/dashboard-server.ts` `checkDashboardRequest`: the retry
 *   write needs a loopback Host and a matching `Origin` (403 otherwise).
 * - `packages/code/src/lib/observability/dashboard-api.ts` `handleRetryRun` →
 *   `retryInjectedRun`: an ad-hoc run re-queues its durable `injected_tasks`
 *   row (202 `{ status: "scheduled", runId, taskKey }`, audit action
 *   `scheduled`), with no detached CLI (`pid`/`command`) and no
 *   `scheduled_retries` row; the worker's own injected-task acquirer drains it.
 *   A concurrent second POST is refused with 409.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  concurrentDashboardWrites,
  dashboardBaseUrl,
  isDuplicateRetryRejection,
  readQueueRows,
  readRetryAudit,
  waitForDashboardHealth,
} from "../../helpers/dashboard";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const builtCli = existsSync(cliPath);
const EVIL_ORIGIN = "https://evil.example";
const SCHEDULED_MESSAGE = "re-queued the interrupted ad-hoc task (resumes its branch)";

interface RunDetailResponse {
  run: { id: number; status: string; origin: string; taskKey?: string; attempt?: number };
  retry: {
    eligible: boolean;
    kind?: string;
    reason?: string;
    audit: Array<{
      runId: number;
      taskKey?: string;
      actor: string;
      action: string;
      message?: string;
      command?: string;
      pid?: number;
      createdAt: number;
    }>;
  };
}

interface WorkerResponse {
  worker: { status: string; pid?: number };
  queue: {
    injected: { pending: number; running: number };
    retries: { pending: number; running: number };
  };
}

async function jsonOf<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

test.skipIf(!builtCli)(
  "POST /api/runs/:id/retry on the worker-embedded dashboard re-queues a failed ad-hoc run through the worker",
  async () => {
    const port = await freePort();
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-dashboard-embedded-retry-",
      dashboard: { port, tailscaleAutodetect: false },
    });
    // The same daemon serves both attempts: the sentinel fails the first agent
    // invocation before it edits, and the retry implements once it is gone.
    const failOnce = join(worker.root, "fail-once");
    const marker = `E2E_EMBEDDED_RETRY_${crypto.randomUUID()}`;
    worker.env.E2E_FAIL_ONCE_FILE = failOnce;
    worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
    const baseUrl = dashboardBaseUrl("127.0.0.1", port);
    try {
      await worker.prepare();
      writeFileSync(failOnce, "1");
      const task = await worker.addTask({
        title: "Retry through the embedded dashboard",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });
      worker.start();
      await worker.waitForReady();
      await waitForDashboardHealth(baseUrl, {
        assertAlive: () => {
          if (!worker.running) throw new Error(`worker exited\n${worker.tail()}`);
        },
        describe: () => worker.tail(),
      });

      const failed = await worker.waitForSettled(task.id);
      const failedDiagnostics = () =>
        [
          `injected task #${task.id} settled as "${failed.task.status}": ${failed.task.message ?? ""}`,
          `runs: ${JSON.stringify(failed.runs)}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          worker.tail(),
        ].join("\n");
      expect(failed.task.status, failedDiagnostics()).toBe("failed");
      expect(failed.runs, failedDiagnostics()).toHaveLength(1);
      const failedRun = failed.runs[0];
      if (!failedRun) throw new Error(`fixture run was not recorded\n${failedDiagnostics()}`);
      expect(failedRun.status, failedDiagnostics()).toBe("failed");
      expect(failedRun.attempt, failedDiagnostics()).toBe(1);
      const failedBranch = `feature/${task.task_key}`;
      expect(existsSync(failOnce), failedDiagnostics()).toBe(false);
      expect(worker.agentInvocations(), failedDiagnostics()).toEqual([{ mode: "implement" }]);

      // The embedded server is the worker's own process.
      const status = await jsonOf<WorkerResponse>(await fetch(`${baseUrl}/api/worker`));
      expect(status.worker.status).toBe("running");
      expect(status.worker.pid).toBe(worker.daemonPid() as number);

      const before = await jsonOf<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${failedRun.id}`),
      );
      expect(before.run.status).toBe("failed");
      expect(before.retry).toMatchObject({ eligible: true, kind: "injected", audit: [] });

      // --- Host/Origin guard: refused writes re-queue nothing ----------------
      const retryUrl = `${baseUrl}/api/runs/${failedRun.id}/retry`;
      const guardedHeaders: Array<Record<string, string>> = [
        { "Content-Type": "application/json" },
        { "Content-Type": "application/json", Origin: EVIL_ORIGIN },
        {
          "Content-Type": "application/json",
          Host: `attacker.example:${port}`,
          Origin: `http://attacker.example:${port}`,
        },
        { "Content-Type": "text/plain", Origin: new URL(baseUrl).origin },
      ];
      const guarded = await Promise.all(
        guardedHeaders.map(async (headers) => {
          const response = await fetch(retryUrl, { method: "POST", headers, redirect: "manual" });
          return { status: response.status, ...((await response.json()) as { error?: string }) };
        }),
      );
      expect(guarded).toEqual([
        { status: 403, error: "forbidden: missing Origin header" },
        { status: 403, error: "forbidden: cross-origin request" },
        {
          status: 403,
          error:
            "forbidden host; open the dashboard via http://localhost:<port> or http://127.0.0.1:<port>, " +
            "or add its origin to [dashboard].allowed_origins",
        },
        { status: 415, error: "unsupported media type: expected application/json" },
      ]);
      expect(worker.injectedTask(task.id)?.status).toBe("failed");
      expect(readRetryAudit(worker.dbPath)).toEqual([]);

      // --- concurrent retry: one accepted, one refused ----------------------
      const race = await concurrentDashboardWrites<Record<string, unknown>>(
        baseUrl,
        `/api/runs/${failedRun.id}/retry`,
      );
      const raceDiagnostics = () =>
        [
          `race: ${JSON.stringify(race)}`,
          `injected: ${JSON.stringify(worker.injectedTask(task.id))}`,
          worker.tail(),
        ].join("\n");
      const accepted = race.filter((result) => result.status === 202);
      const refused = race.filter((result) => result.status === 409);
      // Schedule mode never spawns: the body carries no pid or command.
      expect(accepted, raceDiagnostics()).toEqual([
        {
          status: 202,
          body: { status: "scheduled", runId: failedRun.id, taskKey: task.task_key },
        },
      ]);
      expect(refused, raceDiagnostics()).toHaveLength(1);
      expect(
        isDuplicateRetryRejection(task.task_key, String(refused[0]?.body.error)),
        raceDiagnostics(),
      ).toBe(true);

      // One audit row, and the re-queue used the durable injected row rather
      // than a `scheduled_retries` row or a detached CLI.
      expect(readRetryAudit(worker.dbPath), raceDiagnostics()).toEqual([
        {
          run_id: failedRun.id,
          task_key: task.task_key,
          actor: "local-dashboard",
          action: "scheduled",
          message: SCHEDULED_MESSAGE,
        },
      ]);
      expect(
        readQueueRows<{ id: number }>(
          worker.dbPath,
          "scheduled_retries",
          "SELECT id FROM scheduled_retries",
        ),
        raceDiagnostics(),
      ).toEqual([]);
      const auditing = await jsonOf<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${failedRun.id}`),
      );
      expect(auditing.retry.audit, raceDiagnostics()).toEqual([
        expect.objectContaining({
          runId: failedRun.id,
          taskKey: task.task_key,
          actor: "local-dashboard",
          action: "scheduled",
          message: SCHEDULED_MESSAGE,
        }),
      ]);
      expect(auditing.retry.audit[0]?.pid).toBeUndefined();
      expect(auditing.retry.audit[0]?.command).toBeUndefined();
      // While the row is queued or running, the run is no longer retriable.
      if (worker.injectedTask(task.id)?.status !== "done") {
        expect(auditing.retry.eligible, raceDiagnostics()).toBe(false);
      }

      // --- the worker drains it and completes ------------------------------
      const settled = await worker.waitForSettled(task.id, 90_000);
      const settledDiagnostics = () =>
        [
          `injected task #${task.id} settled as "${settled.task.status}": ${settled.task.message ?? ""}`,
          `runs: ${JSON.stringify(settled.runs)}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          worker.tail(),
        ].join("\n");
      expect(settled.task.status, settledDiagnostics()).toBe("done");
      expect(settled.runs, settledDiagnostics()).toHaveLength(2);
      expect(settled.runs[0]?.id).toBe(failedRun.id);
      const successRun = settled.runs[1];
      if (!successRun) throw new Error(`retried run was not recorded\n${settledDiagnostics()}`);
      const successBranch = `${failedBranch}-attempt-2`;
      expect(successRun.status, settledDiagnostics()).toBe("succeeded");
      expect(successRun.attempt, settledDiagnostics()).toBe(2);
      expect(successRun.branch, settledDiagnostics()).toBe(successBranch);
      expect(worker.agentInvocations(), settledDiagnostics()).toEqual([
        { mode: "implement" },
        { mode: "implement" },
      ]);
      expect(worker.running, settledDiagnostics()).toBe(true);

      // Git state: only the retried attempt reached the remote, with the edit.
      const remoteBranches = await worker.remoteBranches();
      expect(remoteBranches, settledDiagnostics()).toContain(successBranch);
      expect(remoteBranches, settledDiagnostics()).not.toContain(failedBranch);
      expect(await worker.branchFile(successBranch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await worker.branchFile(worker.baseBranch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello";',
      );
      expect(readFileSync(join(worker.seed, "src/greeting.ts"), "utf8")).toBe(
        'export const greeting = "Hello";\n',
      );

      // Eligibility and audit after the retry, as the embedded dashboard reports.
      const successDetail = await jsonOf<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${successRun.id}`),
      );
      expect(successDetail.run).toMatchObject({
        id: successRun.id,
        status: "succeeded",
        origin: "local",
        taskKey: task.task_key,
        attempt: 2,
      });
      expect(successDetail.retry).toMatchObject({
        eligible: false,
        reason: "this run already succeeded",
        audit: [],
      });
      const failedDetail = await jsonOf<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${failedRun.id}`),
      );
      expect(failedDetail.retry.audit.map((entry) => entry.action)).toEqual(["scheduled"]);
      const queue = await jsonOf<WorkerResponse>(await fetch(`${baseUrl}/api/worker`));
      expect(queue.queue.retries).toEqual({ pending: 0, running: 0 });
      expect(queue.queue.injected).toEqual({ pending: 0, running: 0 });
      expect(readRetryAudit(worker.dbPath)).toHaveLength(1);
    } finally {
      await worker.dispose();
    }
  },
  // 20s readiness + failing attempt + 90s successful retry + daemon stop.
  300_000,
);
