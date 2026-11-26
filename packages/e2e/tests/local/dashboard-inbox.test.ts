/**
 * Inbox (notification center) API on the worker-embedded dashboard, fed by
 * real worker runs of ad-hoc tasks against the built CLI.
 *
 * Production behavior under test:
 * - `packages/code/src/lib/notifications/run-rules.ts` `notifyRunFinished`: a
 *   failed ad-hoc (`local`) run that nothing retries raises one high
 *   `retries_exhausted` row grouped per task; an escalated run raises an
 *   `escalated` row; `resolveOnSuccess` resolves the task's rows when a later
 *   run of the same task succeeds.
 * - `packages/code/src/lib/notifications/store.ts`: an emit into an open group
 *   folds (`count` + 1, `read_at` cleared); an emit for a muted group writes
 *   nothing.
 * - `packages/code/src/lib/observability/dashboard-notifications.ts`: the list,
 *   unread-count, mutes routes and the read / read-all / resolve / mute /
 *   unmute writes, behind the dashboard Host/Origin guard.
 *
 * The rows are written by the worker's CLI child processes and read by the
 * daemon's embedded dashboard over short-lived connections, so this crosses the
 * same process boundary production does. No `[notifications.*]` delivery
 * channel is configured.
 */

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardBaseUrl,
  dashboardWriteHeaders,
  listNotifications,
  notificationMutes,
  notificationUnreadCount,
  notificationWrite,
  readQueueRows,
  waitForDashboardHealth,
} from "../../helpers/dashboard";
import type { DashboardNotification, NotificationListQuery } from "../../helpers/dashboard";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerInjectedTask, WorkerRunRecord } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

/** Alphanumeric suffix: prompt markers must survive Markdown escaping. */
function markerSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").toUpperCase();
}

function diagnostics(worker: WorkerFixture, extra: string[] = []): string {
  return [
    ...extra,
    `runs: ${JSON.stringify(worker.runRecords())}`,
    `notifications: ${JSON.stringify(
      readQueueRows(
        worker.dbPath,
        "notifications",
        "SELECT id, kind, group_key, count, read_at, resolved_at, muted FROM notifications ORDER BY id",
      ),
    )}`,
    worker.tail(),
  ].join("\n");
}

/** Start the daemon and wait until its embedded dashboard answers. */
async function startWorker(worker: WorkerFixture, baseUrl: string): Promise<void> {
  worker.start();
  await worker.waitForReady();
  await waitForDashboardHealth(baseUrl, {
    assertAlive: () => {
      if (!worker.running) throw new Error(`worker exited\n${worker.tail()}`);
    },
    describe: () => worker.tail(),
  });
}

/** Wait until the task has `runs` settled runs and its queue row is settled again. */
async function waitForRuns(
  worker: WorkerFixture,
  task: WorkerInjectedTask,
  runs: number,
): Promise<WorkerRunRecord[]> {
  return await worker.waitFor(
    `${task.task_key} to settle with ${runs} run(s)`,
    () => {
      const row = worker.injectedTask(task.id);
      if (!row || (row.status !== "done" && row.status !== "failed")) return undefined;
      const records = worker.runRecords(task.task_key);
      if (records.length !== runs) return undefined;
      return records.every((run) => run.finished_at !== null) ? records : undefined;
    },
    90_000,
  );
}

/** Poll the list API until `probe` accepts a page (bounded, no fixed sleeps). */
async function waitForNotifications(
  worker: WorkerFixture,
  baseUrl: string,
  label: string,
  probe: (rows: DashboardNotification[]) => boolean,
  query: NotificationListQuery = { includeMuted: true },
): Promise<DashboardNotification[]> {
  const deadline = Date.now() + 30_000;
  let last: DashboardNotification[] = [];
  while (Date.now() < deadline) {
    last = (await listNotifications(baseUrl, query)).notifications;
    if (probe(last)) return last;
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${label}; last page ${JSON.stringify(last)}\n${diagnostics(worker)}`,
  );
}

/** Retry a failed ad-hoc run through the embedded dashboard (re-queues its row). */
async function retryRun(baseUrl: string, runId: number): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/retry`, {
    method: "POST",
    headers: dashboardWriteHeaders(baseUrl),
  });
  const body = await response.text();
  if (response.status !== 202)
    throw new Error(`retry of run ${runId} returned ${response.status}: ${body}`);
}

function byGroup(
  rows: DashboardNotification[],
  groupKey: string,
): DashboardNotification | undefined {
  return rows.find((row) => row.groupKey === groupKey);
}

function lastRun(runs: WorkerRunRecord[]): WorkerRunRecord {
  const run = runs.at(-1);
  if (!run) throw new Error("expected at least one run");
  return run;
}

test.skipIf(!builtCli)(
  "Inbox: worker runs create grouped notifications, and read/read-all/resolve/mute/unmute change the list and unread count",
  async () => {
    const port = await freePort();
    const failMarker = `E2EINBOXFAIL${markerSuffix()}`;
    const escalateMarker = `E2EINBOXESCALATE${markerSuffix()}`;
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-dashboard-inbox-",
      dashboard: { port, tailscaleAutodetect: false },
      env: {
        // Every prompt carrying the marker fails before editing, on every
        // attempt; the escalate marker exits 0 with failure language.
        E2E_FAIL_PROMPT_MARKER: failMarker,
        E2E_INCOMPLETE_PROMPT_MARKER: escalateMarker,
      },
    });
    const baseUrl = dashboardBaseUrl("127.0.0.1", port);
    const diag = (extra: string[] = []) => diagnostics(worker, extra);
    try {
      await worker.prepare();
      const taskA = await worker.addTask({
        title: "Inbox failing task A",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${failMarker}`,
      });
      await startWorker(worker, baseUrl);

      // --- first failure: one high, unread, unresolved row --------------------
      const firstRuns = await waitForRuns(worker, taskA, 1);
      const firstRun = lastRun(firstRuns);
      expect(firstRun.status, diag()).toBe("failed");
      const groupA = `retries_exhausted:task:${taskA.task_key}`;
      const [rowA] = await waitForNotifications(worker, baseUrl, "task A's row", (rows) =>
        rows.some((row) => row.groupKey === groupA),
      );
      expect(rowA, diag()).toMatchObject({
        kind: "retries_exhausted",
        severity: "high",
        groupKey: groupA,
        count: 1,
        runId: firstRun.id,
        subject: `task:${taskA.task_key}`,
        title: `${taskA.task_key} failed and will not be retried automatically`,
        muted: false,
      });
      expect(rowA?.readAt).toBeUndefined();
      expect(rowA?.resolvedAt).toBeUndefined();
      const idA = rowA!.id;
      expect(await listNotifications(baseUrl)).toMatchObject({ total: 1, limit: 50, offset: 0 });
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 1, unreadHigh: 1 });
      // The served row is the one the CLI child committed to the queue DB.
      expect(
        readQueueRows<{ id: number; group_key: string; count: number; run_id: number }>(
          worker.dbPath,
          "notifications",
          "SELECT id, group_key, count, run_id FROM notifications ORDER BY id",
        ),
      ).toEqual([{ id: idA, group_key: groupA, count: 1, run_id: firstRun.id }]);

      // --- mark read, then a repeat of the same cause folds and resurfaces ----
      const read = await notificationWrite(baseUrl, `${idA}/read`);
      expect(read.status).toBe(200);
      expect((read.body.notification as DashboardNotification).readAt).toEqual(expect.any(Number));
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 0, unreadHigh: 0 });
      // A read row stays listed.
      expect((await listNotifications(baseUrl)).notifications.map((row) => row.id)).toEqual([idA]);

      await retryRun(baseUrl, firstRun.id);
      const secondRun = lastRun(await waitForRuns(worker, taskA, 2));
      expect(secondRun.status, diag()).toBe("failed");
      const [folded] = await waitForNotifications(worker, baseUrl, "task A's row to fold", (rows) =>
        rows.some((row) => row.id === idA && row.count === 2),
      );
      expect(folded, diag()).toMatchObject({
        id: idA,
        groupKey: groupA,
        count: 2,
        runId: secondRun.id,
        severity: "high",
      });
      expect(folded?.readAt, diag()).toBeUndefined();
      expect(folded!.updatedAt).toBeGreaterThanOrEqual(rowA!.updatedAt);
      expect((await listNotifications(baseUrl)).total).toBe(1);
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 1, unreadHigh: 1 });

      // --- two more causes: an escalated run and another failing task --------
      const taskB = await worker.addTask({
        title: "Inbox escalating task B",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${escalateMarker}`,
      });
      const runB = lastRun(await waitForRuns(worker, taskB, 1));
      expect(runB.status, diag()).toBe("escalated");
      const groupB = `escalated:local:task:${taskB.task_key}`;
      await waitForNotifications(
        worker,
        baseUrl,
        "task B's row",
        (rows) => !!byGroup(rows, groupB),
      );

      const taskC = await worker.addTask({
        title: "Inbox failing task C",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${failMarker}`,
      });
      const runC = lastRun(await waitForRuns(worker, taskC, 1));
      expect(runC.status, diag()).toBe("failed");
      const groupC = `retries_exhausted:task:${taskC.task_key}`;
      const all = await waitForNotifications(
        worker,
        baseUrl,
        "task C's row",
        (rows) => !!byGroup(rows, groupC),
      );
      const rowB = byGroup(all, groupB)!;
      const rowC = byGroup(all, groupC)!;
      expect(rowB, diag()).toMatchObject({
        kind: "escalated",
        severity: "high",
        count: 1,
        runId: runB.id,
        subject: `task:${taskB.task_key}`,
      });
      expect(rowC, diag()).toMatchObject({
        kind: "retries_exhausted",
        severity: "high",
        count: 1,
        runId: runC.id,
      });
      // Most recently updated first: C, B, then the folded A.
      expect(
        all.map((row) => row.id),
        diag(),
      ).toEqual([rowC.id, rowB.id, idA]);
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 3, unreadHigh: 3 });

      // --- list filters -------------------------------------------------------
      const ids = async (query: NotificationListQuery) => {
        const page = await listNotifications(baseUrl, query);
        return { total: page.total, ids: page.notifications.map((row) => row.id) };
      };
      expect(await ids({ kind: "retries_exhausted" })).toEqual({ total: 2, ids: [rowC.id, idA] });
      expect(await ids({ kind: "escalated" })).toEqual({ total: 1, ids: [rowB.id] });
      expect(await ids({ kind: "automation_broke" })).toEqual({ total: 0, ids: [] });
      expect(await ids({ severity: "high" })).toEqual({ total: 3, ids: [rowC.id, rowB.id, idA] });
      expect(await ids({ severity: "normal" })).toEqual({ total: 0, ids: [] });
      expect(await ids({ unresolved: true })).toEqual({ total: 3, ids: [rowC.id, rowB.id, idA] });
      expect(await listNotifications(baseUrl, { limit: 1 })).toMatchObject({
        total: 3,
        limit: 1,
        offset: 0,
        notifications: [expect.objectContaining({ id: rowC.id })],
      });
      expect(await ids({ limit: 1, offset: 1 })).toEqual({ total: 3, ids: [rowB.id] });
      expect(await ids({ limit: 2, offset: 2 })).toEqual({ total: 3, ids: [idA] });
      expect(await ids({ kind: "retries_exhausted", limit: 1, offset: 1 })).toEqual({
        total: 2,
        ids: [idA],
      });
      for (const [search, error] of [
        ["severity=urgent", "severity must be high or normal"],
        ["kind=bogus", 'unknown kind "bogus"'],
        ["limit=0", "limit must be between 1 and 200"],
        ["unresolved=maybe", "unresolved must be true or false"],
      ] as const) {
        const response = await fetch(`${baseUrl}/api/notifications?${search}`);
        expect({ search, status: response.status, body: await response.json() }).toEqual({
          search,
          status: 400,
          body: { error },
        });
      }

      // --- Host/Origin guard: an unguarded write is refused and changes nothing
      const unguarded = await fetch(`${baseUrl}/api/notifications/read-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(unguarded.status).toBe(403);
      expect(await unguarded.json()).toEqual({ error: "forbidden: missing Origin header" });
      const crossOrigin = await fetch(`${baseUrl}/api/notifications/mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ groupKey: groupB }),
      });
      expect(crossOrigin.status).toBe(403);
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 3, unreadHigh: 3 });
      expect(await notificationMutes(baseUrl)).toEqual([]);

      // --- resolve one: drops out of unresolved and the unread count ---------
      const resolved = await notificationWrite(baseUrl, `${rowC.id}/resolve`);
      expect(resolved.status).toBe(200);
      expect(resolved.body.notification).toMatchObject({
        id: rowC.id,
        resolvedAt: expect.any(Number),
      });
      expect(await ids({ unresolved: true })).toEqual({ total: 2, ids: [rowB.id, idA] });
      expect((await ids({})).total).toBe(3);
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 2, unreadHigh: 2 });

      // --- read-all: every unread row (the resolved one too) is marked read --
      const readAll = await notificationWrite(baseUrl, "read-all");
      expect(readAll).toEqual({ status: 200, body: { updated: 3 } });
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 0, unreadHigh: 0 });
      const afterReadAll = (await listNotifications(baseUrl)).notifications;
      expect(
        afterReadAll.every((row) => typeof row.readAt === "number"),
        diag(),
      ).toBe(true);
      expect(await notificationWrite(baseUrl, "read-all")).toEqual({
        status: 200,
        body: { updated: 0 },
      });

      // --- unknown ids and bad mute bodies ------------------------------------
      expect(await notificationWrite(baseUrl, "999999/read")).toEqual({
        status: 404,
        body: { error: "notification not found" },
      });
      expect(await notificationWrite(baseUrl, "abc/resolve")).toEqual({
        status: 400,
        body: { error: "notification id must be a positive integer" },
      });
      expect(await notificationWrite(baseUrl, "mute", {})).toEqual({
        status: 400,
        body: { error: "groupKey must be a non-empty string" },
      });

      // --- mute A's group: hidden by default, listed in mutes ---------------
      expect(await notificationWrite(baseUrl, "mute", { groupKey: groupA })).toEqual({
        status: 200,
        body: { groupKey: groupA, muted: true },
      });
      expect(await ids({})).toEqual({ total: 2, ids: [rowC.id, rowB.id] });
      expect((await notificationMutes(baseUrl)).map((mute) => mute.groupKey)).toEqual([groupA]);
      const withMuted = (await listNotifications(baseUrl, { includeMuted: true })).notifications;
      expect(withMuted.map((row) => row.id)).toEqual([rowC.id, rowB.id, idA]);
      expect(withMuted.find((row) => row.id === idA)).toMatchObject({ muted: true, count: 2 });

      // A later repeat of the muted cause writes nothing and stays hidden.
      await retryRun(baseUrl, secondRun.id);
      const thirdRun = lastRun(await waitForRuns(worker, taskA, 3));
      expect(thirdRun.status, diag()).toBe("failed");
      const mutedRow = (
        await listNotifications(baseUrl, { includeMuted: true })
      ).notifications.find((row) => row.id === idA);
      expect(mutedRow, diag()).toMatchObject({ muted: true, count: 2, runId: secondRun.id });
      expect(mutedRow?.readAt, diag()).toEqual(expect.any(Number));
      expect(await ids({}), diag()).toEqual({ total: 2, ids: [rowC.id, rowB.id] });
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 0, unreadHigh: 0 });
      expect(
        readQueueRows<{ id: number }>(
          worker.dbPath,
          "notifications",
          `SELECT id FROM notifications WHERE group_key = '${groupA.replaceAll("'", "''")}'`,
        ),
        diag(),
      ).toEqual([{ id: idA }]);

      // --- unmute: visible again, as it was before the mute -----------------
      expect(await notificationWrite(baseUrl, "unmute", { groupKey: groupA })).toEqual({
        status: 200,
        body: { groupKey: groupA, muted: false },
      });
      expect(await notificationMutes(baseUrl)).toEqual([]);
      const unmuted = (await listNotifications(baseUrl)).notifications;
      expect(unmuted.map((row) => row.id)).toEqual([rowC.id, rowB.id, idA]);
      expect(unmuted.find((row) => row.id === idA)).toMatchObject({ muted: false, count: 2 });
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 0, unreadHigh: 0 });
      expect(worker.running, diag()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Readiness + five agent runs + daemon stop.
  300_000,
);

test.skipIf(!builtCli)(
  "Inbox: a later successful run of the same task auto-resolves its notification",
  async () => {
    const port = await freePort();
    const failMarker = `E2EINBOXFAIL${markerSuffix()}`;
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-dashboard-inbox-resolve-",
      dashboard: { port, tailscaleAutodetect: false },
      env: { E2E_FAIL_PROMPT_MARKER: failMarker },
    });
    // The sentinel fails the first agent invocation only (task D's first run).
    const failOnce = join(worker.root, "fail-once");
    worker.env.E2E_FAIL_ONCE_FILE = failOnce;
    const baseUrl = dashboardBaseUrl("127.0.0.1", port);
    const diag = (extra: string[] = []) => diagnostics(worker, extra);
    try {
      await worker.prepare();
      writeFileSync(failOnce, "1");
      const taskD = await worker.addTask({
        title: "Inbox task D fails once",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      await startWorker(worker, baseUrl);
      const failedD = lastRun(await waitForRuns(worker, taskD, 1));
      expect(failedD.status, diag()).toBe("failed");
      expect(existsSync(failOnce), diag()).toBe(false);
      const groupD = `retries_exhausted:task:${taskD.task_key}`;

      // An unrelated failure that must stay open after D recovers.
      const taskE = await worker.addTask({
        title: "Inbox task E keeps failing",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${failMarker}`,
      });
      expect(lastRun(await waitForRuns(worker, taskE, 1)).status, diag()).toBe("failed");
      const groupE = `retries_exhausted:task:${taskE.task_key}`;
      const open = await waitForNotifications(
        worker,
        baseUrl,
        "rows for D and E",
        (rows) => !!byGroup(rows, groupD) && !!byGroup(rows, groupE),
        { unresolved: true },
      );
      const rowD = byGroup(open, groupD)!;
      const rowE = byGroup(open, groupE)!;
      expect(rowD, diag()).toMatchObject({ severity: "high", count: 1, runId: failedD.id });
      expect(rowD.resolvedAt).toBeUndefined();
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 2, unreadHigh: 2 });

      // The retry implements (the sentinel is gone) and succeeds.
      await retryRun(baseUrl, failedD.id);
      const succeededD = lastRun(await waitForRuns(worker, taskD, 2));
      expect(succeededD.status, diag()).toBe("succeeded");

      const remaining = await waitForNotifications(
        worker,
        baseUrl,
        "D's row to drop out of unresolved",
        (rows) => !byGroup(rows, groupD),
        { unresolved: true },
      );
      expect(
        remaining.map((row) => row.id),
        diag(),
      ).toEqual([rowE.id]);
      const resolvedD = (await listNotifications(baseUrl)).notifications.find(
        (row) => row.id === rowD.id,
      );
      // Resolved by the run rules on their own: no write was sent for it, the
      // row keeps its count and failing run, and it stays listed (not unread).
      expect(resolvedD, diag()).toMatchObject({
        id: rowD.id,
        groupKey: groupD,
        count: 1,
        runId: failedD.id,
        resolvedAt: expect.any(Number),
      });
      expect(resolvedD?.readAt).toBeUndefined();
      expect(await notificationUnreadCount(baseUrl)).toEqual({ unread: 1, unreadHigh: 1 });
      expect(
        readQueueRows<{ id: number; resolved: number }>(
          worker.dbPath,
          "notifications",
          "SELECT id, resolved_at IS NOT NULL AS resolved FROM notifications ORDER BY id",
        ),
        diag(),
      ).toEqual([
        { id: rowD.id, resolved: 1 },
        { id: rowE.id, resolved: 0 },
      ]);
    } finally {
      await worker.dispose();
    }
  },
  // Readiness + three agent runs + daemon stop.
  240_000,
);
