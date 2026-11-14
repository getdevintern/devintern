import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardFixture, dashboardWriteHeaders } from "../../helpers/dashboard";
import { isolatedEnvironment } from "../../helpers/environment";
import { checkedCommand, command } from "../../helpers/process";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

interface RunsResponse {
  runs: Array<{
    id: number;
    status: string;
    origin: string;
    taskKey?: string;
    startedAt: number;
    finishedAt?: number;
    taskDescription?: string;
  }>;
  total: number;
}

interface RunDetailResponse {
  run: {
    id: number;
    status: string;
    origin: string;
    taskKey?: string;
    startedAt: number;
    finishedAt?: number;
    taskDescription?: string;
    branch?: string;
    attempt?: number;
    outcomeReason?: string;
  };
  stages: Array<{ runId: number; stage: string; status: string }>;
  retry: {
    eligible: boolean;
    kind?: string;
    reason?: string;
    audit: RetryAuditEntry[];
  };
  harnessLogs: unknown[];
  artifacts: unknown[];
}

interface RetryAuditEntry {
  runId: number;
  taskKey?: string;
  actor: string;
  action: string;
  message?: string;
  createdAt: number;
}

interface RetryScheduledBody {
  status: string;
  runId: number;
  taskKey: string;
  pid?: number;
  command?: string;
}

interface StatsResponse {
  window: string;
  stats: {
    totals: { runs: number; byStatus: Record<string, number> };
    byOrigin: Record<string, number>;
  };
}

interface WorkerResponse {
  worker: { status: string; pid?: number; lockFile?: string };
  queue: {
    pending: number;
    processing: number;
    failed: number;
    injected: { pending: number; running: number };
    retries: { pending: number; running: number };
  };
  dbMissing: boolean;
}

interface AutomationsResponse {
  automations: unknown[];
}

interface ErrorResponse {
  error: string;
}

async function readJson<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function workerStatus(baseUrl: string): Promise<WorkerResponse> {
  return await readJson<WorkerResponse>(await fetch(`${baseUrl}/api/worker`));
}

interface StoredRetryAudit {
  run_id: number;
  task_key: string | null;
  actor: string;
  action: string;
  message: string | null;
}

/** Read committed queue rows. A missing table is empty, not a failed open. */
function readQueueRows<T>(dbPath: string, table: string, sql: string): T[] {
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    throw new Error(`refusing to query unexpected table ${table}`);
  }
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const known = db
      .query("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { one: number } | null;
    if (!known) return [];
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

/**
 * Second POST while an ad-hoc retry is queued or starting.
 *
 * The handler rejects that overlap: the row is already pending/running, the
 * re-queue update lost the race, or the worker has already opened a run.
 *
 * Pending/running may omit the "not retriable:" prefix. Eligibility adds it
 * (`resolveRetryEligibility` → `conflict`), and a loser that already passed
 * that read gets the same sentence bare from `retryInjectedRun`. "Moved on"
 * and "in progress" stay exact.
 */
function isDuplicateRetryRejection(taskKey: string, error: string): boolean {
  const task = taskKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    error === `ad-hoc task ${taskKey} moved on; reload the run and try again` ||
    new RegExp(
      `^(?:not retriable: )?ad-hoc task ${task} is already (?:pending|running) \\(task #\\d+\\)$`,
    ).test(error) ||
    new RegExp(
      `^${task} already has a run in progress \\(run \\d+\\); wait for it to finish$`,
    ).test(error)
  );
}

/** Whether this host can bind IPv6 loopback, so the `::1` case is not flaky. */
function hasIpv6Loopback(): boolean {
  try {
    const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!builtCli)(
  "the standalone dashboard serves real worker run history and degrades without the daemon",
  async () => {
    const worker = new WorkerFixture();
    // The deterministic agent only edits when this marker reaches its prompt,
    // so the dashboard assertions below are tied to the injected run, not to
    // whatever task file happens to exist in the fixture repository.
    const marker = `E2E_DASHBOARD_MARKER_${crypto.randomUUID()}`;
    worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
    let dashboard: DashboardFixture | undefined;
    try {
      await worker.prepare();
      const task = await worker.addTask({
        title: "Expose the dashboard run",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });
      worker.start();
      await worker.waitForReady();

      const { task: settled, runs } = await worker.waitForSettled(task.id);
      const diagnostics = () =>
        [
          `injected task #${task.id} (${task.task_key}) settled as "${settled.status}": ${
            settled.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(runs)}`,
          worker.tail(),
        ].join("\n");

      expect(settled.status, diagnostics()).toBe("done");
      expect(runs, diagnostics()).toHaveLength(1);
      const run = runs[0];
      expect(run?.status, diagnostics()).toBe("succeeded");
      const taskKey = run?.task_key;
      if (!run || !taskKey) throw new Error(`fixture run has no id/task key\n${diagnostics()}`);

      dashboard = await DashboardFixture.start(worker);
      const baseUrl = dashboard.baseUrl;

      // --- health -----------------------------------------------------------
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: "ok" });

      // --- run list ---------------------------------------------------------
      const list = await readJson<RunsResponse>(await fetch(`${baseUrl}/api/runs`));
      expect(list.total).toBe(runs.length);
      expect(list.runs).toHaveLength(runs.length);
      expect(list.runs[0]).toMatchObject({
        id: run.id,
        status: "succeeded",
        origin: "local",
        taskKey,
      });
      expect(list.runs[0]?.startedAt).toBeTypeOf("number");
      expect(list.runs[0]?.finishedAt).toBeTypeOf("number");
      // The polled list strips the ticket description; run detail serves it.
      expect(list.runs[0]?.taskDescription).toBeUndefined();

      const limited = await readJson<RunsResponse>(await fetch(`${baseUrl}/api/runs?limit=1`));
      expect(limited.runs).toHaveLength(1);
      expect(limited.total).toBe(runs.length);

      const invalidLimit = await fetch(`${baseUrl}/api/runs?limit=0`);
      expect(invalidLimit.status).toBe(400);
      expect(((await invalidLimit.json()) as ErrorResponse).error).toContain("limit must be");

      // --- run detail -------------------------------------------------------
      const detail = await readJson<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${run.id}`),
      );
      expect(detail.run).toMatchObject({
        id: run.id,
        status: "succeeded",
        origin: "local",
        taskKey,
      });
      expect(detail.run.startedAt).toBeTypeOf("number");
      expect(detail.run.finishedAt).toBeTypeOf("number");
      expect(detail.run.taskDescription).toBeTypeOf("string");
      expect(detail.stages.length).toBeGreaterThan(0);
      expect(detail.stages.every((stage) => stage.runId === run.id)).toBe(true);
      expect(detail.stages.map((stage) => stage.stage)).toContain("implementation");
      // A succeeded run has no retry write path to trigger.
      expect(detail.retry.eligible).toBe(false);
      expect(detail.harnessLogs).toBeArray();
      expect(detail.artifacts).toBeArray();

      const harnessLogs = await readJson<{ harnessLogs: unknown[] }>(
        await fetch(`${baseUrl}/api/runs/${run.id}/harness-logs`),
      );
      expect(harnessLogs.harnessLogs).toBeArray();

      const artifactList = await readJson<{ artifacts: unknown[] }>(
        await fetch(`${baseUrl}/api/runs/${run.id}/artifacts`),
      );
      expect(artifactList.artifacts).toEqual(detail.artifacts);

      const activity = await readJson<{ runs: RunsResponse["runs"]; recentLimit: number }>(
        await fetch(`${baseUrl}/api/task-activity`),
      );
      expect(activity.recentLimit).toBe(100);
      expect(activity.runs.some((candidate) => candidate.id === run.id)).toBe(true);

      const agentPrs = await readJson<{ prs: unknown[] }>(await fetch(`${baseUrl}/api/agent-prs`));
      // The fixture pushes to a local bare remote, so no code-host PR exists.
      expect(agentPrs.prs).toEqual([]);

      const logs = await readJson<{ available: boolean; entries: Array<{ message: string }> }>(
        await fetch(`${baseUrl}/api/logs`),
      );
      expect(logs.available).toBe(true);
      expect(logs.entries.length).toBeGreaterThan(0);
      // The daemon tees its startup banner into worker.stdout.log before the
      // first task runs, so an empty or never-tailed response fails here.
      expect(logs.entries.map((entry) => entry.message)).toContainEqual(
        expect.stringContaining("Starting devintern worker"),
      );

      const missingId = 2_147_483_647;
      const missing = await fetch(`${baseUrl}/api/runs/${missingId}`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as ErrorResponse).error).toBe(`run ${missingId} not found`);

      // --- stats ------------------------------------------------------------
      const stats = await readJson<StatsResponse>(await fetch(`${baseUrl}/api/stats?window=all`));
      expect(stats.window).toBe("all");
      expect(stats.stats.totals.runs).toBeGreaterThanOrEqual(runs.length);
      expect(stats.stats.totals.byStatus.succeeded).toBeGreaterThanOrEqual(1);
      expect(stats.stats.byOrigin.local).toBeGreaterThanOrEqual(runs.length);

      // --- worker, automations, and method guard ----------------------------
      const liveWorker = await workerStatus(baseUrl);
      expect(liveWorker.worker.status).toBe("running");
      expect(liveWorker.worker.pid).toBeTypeOf("number");
      expect(liveWorker.worker.lockFile).toBeTypeOf("string");
      expect(liveWorker.dbMissing).toBe(false);
      expect(liveWorker.queue).toMatchObject({
        pending: expect.any(Number),
        processing: expect.any(Number),
        failed: expect.any(Number),
      });

      const automations = await readJson<AutomationsResponse>(
        await fetch(`${baseUrl}/api/automations`),
      );
      expect(automations.automations).toEqual([]);

      // --- write-route refusals (no work is spawned) -------------------------
      // A bare POST (no Origin, no JSON content type) never reaches a route:
      // the CSRF guard rejects it first.
      const bareRetry = await fetch(`${baseUrl}/api/runs/${run.id}/retry`, { method: "POST" });
      expect(bareRetry.status).toBe(403);

      // The fixture run succeeded, so the retry handler refuses before it can
      // spawn detached CLI work (run-retry.ts:95-96).
      const retrySettled = await fetch(`${baseUrl}/api/runs/${run.id}/retry`, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
      });
      expect(retrySettled.status).toBe(409);
      expect(await retrySettled.json()).toEqual({
        error: "not retriable: this run already succeeded",
      });

      const retryMalformed = await fetch(`${baseUrl}/api/runs/not-an-int/retry`, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
      });
      expect(retryMalformed.status).toBe(400);
      expect(await retryMalformed.json()).toEqual({ error: "run id must be an integer" });

      const missingAutomationRun = await fetch(`${baseUrl}/api/automations/nope/run`, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
      });
      expect(missingAutomationRun.status).toBe(404);
      expect(await missingAutomationRun.json()).toEqual({
        error: 'automation "nope" not found',
      });

      // A POST that matches no write route still falls through to the guard.
      const post = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
      });
      expect(post.status).toBe(405);
      expect(await post.json()).toEqual({ error: "method not allowed" });

      // --- standalone degradation after the daemon stops --------------------
      await worker.stop();
      let liveness: string | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        liveness = (await workerStatus(baseUrl)).worker.status;
        if (liveness === "stopped" || liveness === "unknown") break;
        await Bun.sleep(50);
      }
      // A stopped daemon is either observed through its stale lock ("stopped")
      // or absent after lock cleanup ("unknown"); neither may stay "running".
      expect(liveness === "stopped" || liveness === "unknown").toBe(true);

      const exitCode = await dashboard.stop();
      expect(exitCode).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  // Exceeds the helper's worst case: 20s readiness + 45s settle + dashboard
  // health polling/stop plus prepare() and daemon work.
  240_000,
);

test.skipIf(!builtCli || !hasIpv6Loopback())(
  "the dashboard fixture polls the host it binds, including IPv6 loopback",
  async () => {
    const worker = new WorkerFixture();
    let dashboard: DashboardFixture | undefined;
    try {
      // The CLI resolves its agent harness before dispatching any subcommand,
      // so prepare() supplies the deterministic AGENT_CLI_PATH the fixture
      // needs instead of depending on an ambient agent installation.
      await worker.prepare();
      dashboard = await DashboardFixture.start(worker, { host: "::1" });
      // Bracketed IPv6 authority; an unbracketed host would poll the default
      // 127.0.0.1 and time out even though the server is listening on ::1.
      expect(dashboard.baseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);

      const health = await fetch(`${dashboard.baseUrl}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const status = await workerStatus(dashboard.baseUrl);
      expect(status.dbMissing).toBe(true);

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  45_000,
);

test.skipIf(!builtCli)(
  "devintern dashboard refuses a non-loopback host before it listens",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-dashboard-guard-"));
    try {
      const env = isolatedEnvironment(root);
      const port = await freePort();
      const result = await command(
        [process.execPath, cliPath, "dashboard", "--host", "0.0.0.0", "--port", String(port)],
        root,
        env,
        30_000,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("is not loopback");
      expect(result.stdout).not.toContain("Dashboard running");

      // The refused process must not have left a listener on the chosen port.
      const probe = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response("ok"),
      });
      probe.stop(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);

test.skipIf(!builtCli)(
  "POST /api/runs/:id/retry re-queues one failed ad-hoc run and the worker completes it",
  async () => {
    const worker = new WorkerFixture();
    // The same daemon serves both attempts, so the agent cannot switch mode
    // through the environment. The sentinel fails the first invocation before
    // it edits; the retry then implements because the file is gone.
    const failOnce = join(worker.root, "fail-once");
    const marker = `E2E_DASHBOARD_RETRY_${crypto.randomUUID()}`;
    worker.env.E2E_FAIL_ONCE_FILE = failOnce;
    worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
    const fixtureGreeting = join(import.meta.dir, "../../fixtures/simple-project/src/greeting.ts");
    const seededGreeting = 'export const greeting = "Hello";\n';
    let dashboard: DashboardFixture | undefined;
    try {
      await worker.prepare();
      writeFileSync(failOnce, "1");
      const task = await worker.addTask({
        title: "Retry the dashboard run",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });
      worker.start();
      await worker.waitForReady();

      const failed = await worker.waitForSettled(task.id);
      const failedDiagnostics = () =>
        [
          `injected task #${task.id} (${task.task_key}) settled as "${failed.task.status}": ${
            failed.task.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(failed.runs)}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          worker.tail(),
        ].join("\n");
      expect(failed.task.status, failedDiagnostics()).toBe("failed");
      expect(failed.runs, failedDiagnostics()).toHaveLength(1);
      const failedRun = failed.runs[0];
      if (!failedRun) throw new Error(`fixture run was not recorded\n${failedDiagnostics()}`);
      expect(failedRun.status, failedDiagnostics()).toBe("failed");
      expect(failedRun.origin, failedDiagnostics()).toBe("local");
      expect(failedRun.attempt, failedDiagnostics()).toBe(1);
      expect(failedRun.outcome_reason ?? "", failedDiagnostics()).toContain("code 18");
      const failedBranch = `feature/${task.task_key}`;
      expect(failedRun.branch, failedDiagnostics()).toBe(failedBranch);
      // The one-shot exit happens before the edit, so the shared fixture and
      // the published base stay at the seed greeting.
      expect(existsSync(failOnce), failedDiagnostics()).toBe(false);
      expect(worker.agentInvocations(), failedDiagnostics()).toEqual([{ mode: "implement" }]);
      expect(readFileSync(fixtureGreeting, "utf8")).toBe(seededGreeting);
      expect(await worker.branchFile(worker.baseBranch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello";',
      );
      expect(await worker.remoteBranches(), failedDiagnostics()).not.toContain(failedBranch);

      dashboard = await DashboardFixture.start(worker);
      const baseUrl = dashboard.baseUrl;
      const before = await readJson<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${failedRun.id}`),
      );
      expect(before.run.status).toBe("failed");
      expect(before.retry).toMatchObject({ eligible: true, kind: "injected", audit: [] });

      const retryResponses = await Promise.all([
        fetch(`${baseUrl}/api/runs/${failedRun.id}/retry`, {
          method: "POST",
          headers: dashboardWriteHeaders(baseUrl),
        }),
        fetch(`${baseUrl}/api/runs/${failedRun.id}/retry`, {
          method: "POST",
          headers: dashboardWriteHeaders(baseUrl),
        }),
      ]);
      const retryBodies = await Promise.all(
        retryResponses.map(async (response) => ({
          status: response.status,
          body: (await response.json()) as RetryScheduledBody | ErrorResponse,
        })),
      );
      const accepted = retryBodies.filter((result) => result.status === 202);
      const rejected = retryBodies.filter((result) => result.status === 409);
      const retryDiagnostics = () =>
        [
          `retry responses: ${JSON.stringify(retryBodies)}`,
          `injected: ${JSON.stringify(worker.injectedTask(task.id))}`,
          worker.tail(),
          dashboard?.stderr ?? "",
        ].join("\n");
      expect(accepted, retryDiagnostics()).toHaveLength(1);
      expect(rejected, retryDiagnostics()).toHaveLength(1);
      expect(accepted[0]?.body, retryDiagnostics()).toEqual({
        status: "scheduled",
        runId: failedRun.id,
        taskKey: task.task_key,
      });
      const rejection = rejected[0]?.body as ErrorResponse;
      expect(isDuplicateRetryRejection(task.task_key, rejection.error), retryDiagnostics()).toBe(
        true,
      );

      const requeued = worker.injectedTask(task.id);
      expect(
        requeued?.status === "pending" || requeued?.status === "running",
        retryDiagnostics(),
      ).toBe(true);
      const storedAudit = readQueueRows<StoredRetryAudit>(
        worker.dbPath,
        "run_retry_audit",
        "SELECT run_id, task_key, actor, action, message FROM run_retry_audit ORDER BY id",
      );
      expect(storedAudit, retryDiagnostics()).toEqual([
        {
          run_id: failedRun.id,
          task_key: task.task_key,
          actor: "local-dashboard",
          action: "scheduled",
          message: "re-queued the interrupted ad-hoc task (resumes its branch)",
        },
      ]);
      expect(
        readQueueRows<{ id: number }>(
          worker.dbPath,
          "scheduled_retries",
          "SELECT id FROM scheduled_retries",
        ),
        retryDiagnostics(),
      ).toEqual([]);
      const queued = await workerStatus(baseUrl);
      expect(queued.queue.retries, retryDiagnostics()).toEqual({ pending: 0, running: 0 });
      expect(
        queued.queue.injected.pending + queued.queue.injected.running,
        retryDiagnostics(),
      ).toBe(1);

      const auditing = await readJson<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${failedRun.id}`),
      );
      expect(auditing.retry.audit, retryDiagnostics()).toEqual([
        expect.objectContaining({
          runId: failedRun.id,
          taskKey: task.task_key,
          actor: "local-dashboard",
          action: "scheduled",
          message: "re-queued the interrupted ad-hoc task (resumes its branch)",
        }),
      ]);
      expect(auditing.retry.audit[0]?.createdAt, retryDiagnostics()).toBeTypeOf("number");

      const settled = await worker.waitForSettled(task.id, 90_000);
      const settledDiagnostics = () =>
        [
          `injected task #${task.id} settled as "${settled.task.status}": ${
            settled.task.message ?? "no message"
          }`,
          `runs: ${JSON.stringify(settled.runs)}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          worker.tail(),
        ].join("\n");
      expect(settled.task.status, settledDiagnostics()).toBe("done");
      expect(settled.runs, settledDiagnostics()).toHaveLength(2);
      expect(settled.runs[0]?.id, settledDiagnostics()).toBe(failedRun.id);
      expect(settled.runs[0]?.status, settledDiagnostics()).toBe("failed");
      const successRun = settled.runs[1];
      if (!successRun?.branch) {
        throw new Error(`retried run recorded no branch\n${settledDiagnostics()}`);
      }
      // Nothing was committed on the failed attempt, so pickup starts a fresh
      // attempt branch instead of resuming the empty one.
      const successBranch = `${failedBranch}-attempt-2`;
      expect(successRun.status, settledDiagnostics()).toBe("succeeded");
      expect(successRun.attempt, settledDiagnostics()).toBe(2);
      expect(successRun.branch, settledDiagnostics()).toBe(successBranch);
      expect(successRun.pr_url, settledDiagnostics()).toBeNull();
      expect(worker.agentInvocations(), settledDiagnostics()).toEqual([
        { mode: "implement" },
        { mode: "implement" },
      ]);
      expect(worker.running, settledDiagnostics()).toBe(true);

      const list = await readJson<RunsResponse>(
        await fetch(`${baseUrl}/api/runs?taskKey=${encodeURIComponent(task.task_key)}`),
      );
      expect(list.total).toBe(2);
      expect(list.runs.map((run) => run.id)).toEqual([successRun.id, failedRun.id]);
      const successDetail = await readJson<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${successRun.id}`),
      );
      expect(successDetail.run).toMatchObject({
        id: successRun.id,
        status: "succeeded",
        origin: "local",
        taskKey: task.task_key,
        branch: successBranch,
        attempt: 2,
      });
      expect(successDetail.retry).toMatchObject({
        eligible: false,
        reason: "this run already succeeded",
        audit: [],
      });
      const failedDetail = await readJson<RunDetailResponse>(
        await fetch(`${baseUrl}/api/runs/${failedRun.id}`),
      );
      expect(failedDetail.run.status).toBe("failed");
      expect(failedDetail.retry.audit).toHaveLength(1);
      expect(failedDetail.retry.audit[0]?.action).toBe("scheduled");

      const stats = await readJson<StatsResponse>(await fetch(`${baseUrl}/api/stats?window=all`));
      expect(stats.stats.totals.byStatus.failed).toBeGreaterThanOrEqual(1);
      expect(stats.stats.totals.byStatus.succeeded).toBeGreaterThanOrEqual(1);

      const remoteBranches = await worker.remoteBranches();
      expect(remoteBranches, settledDiagnostics()).toContain(successBranch);
      expect(remoteBranches, settledDiagnostics()).not.toContain(failedBranch);
      expect(await worker.branchFile(successBranch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await worker.branchFile(worker.baseBranch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello";',
      );
      const changedFiles = await checkedCommand(
        [
          "git",
          "--git-dir",
          worker.remote,
          "diff",
          "--name-only",
          worker.baseBranch,
          successBranch,
        ],
        worker.root,
        worker.env,
      );
      expect(changedFiles.split("\n").filter(Boolean)).toEqual(["src/greeting.ts"]);
      expect(readFileSync(fixtureGreeting, "utf8")).toBe(seededGreeting);
      expect(readFileSync(join(worker.seed, "src/greeting.ts"), "utf8")).toBe(seededGreeting);

      await worker.waitFor("the successful attempt's worktree to be removed", () =>
        worker.taskWorktrees().length <= 1 ? true : undefined,
      );
      // The failed attempt keeps its worktree for debugging; the success does not.
      expect(worker.taskWorktrees(), settledDiagnostics()).toHaveLength(1);
      expect(
        readQueueRows<StoredRetryAudit>(
          worker.dbPath,
          "run_retry_audit",
          "SELECT run_id, task_key, actor, action, message FROM run_retry_audit ORDER BY id",
        ),
      ).toHaveLength(1);

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
      expect(worker.running, settledDiagnostics()).toBe(true);
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  // Two pipeline attempts: 20s readiness + 45s failure + dashboard health +
  // 90s successful retry + worktree cleanup, plus prepare and daemon stop.
  300_000,
);
