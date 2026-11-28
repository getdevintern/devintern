/**
 * Per-channel notification filters (`kinds`, `exclude_kinds`, `min_severity`)
 * from `packages/code/src/lib/notifications/delivery/config.ts` and
 * `policy.ts`, driven through the real built `devintern worker`.
 *
 * Two notifications are raised offline: a failed ad-hoc task
 * (`retries_exhausted`, high severity) and a task whose agent delegates a
 * follow-up with `worker add` (`work_spawned`, normal severity). Slack excludes
 * `retries_exhausted` and keeps the default `min_severity = "high"`; the
 * webhook sets `min_severity = "normal"` and no kind filter. So the webhook
 * receives both, and Slack receives neither: the first for its kind, the
 * second for its severity.
 *
 * Delivery ticks every 30 s and a channel only delivers notifications created
 * after its first tick, so the tasks are enqueued once that tick has run.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readQueueRows } from "../../helpers/dashboard";
import { NotificationReceiverFixture } from "../../helpers/notification-receiver";
import {
  HOOK_PATH,
  NOTIFY_DASHBOARD_URL,
  containsSecret,
  deliveryRows,
  describeRequests,
  expectedSignature,
  lastDeliveryTickAt,
  notificationCredentials,
  notificationRows,
  notificationsToml,
  redactSecrets,
  writeNotificationEnv,
} from "../../helpers/notification-delivery";
import type { WebhookPayload } from "../../helpers/notification-delivery";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/** Alphanumeric so Markdown escaping cannot hide it from the fake agent. */
const FAIL_MARKER = "E2ENOTIFYFILTERFAIL";

cliTest(
  "an unknown notification kind is rejected at config load",
  async () => {
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-notify-kind-",
      workspaceTomlExtra: notificationsToml({
        slack: ['kinds = ["retries_exhausted", "pr_merged"]'],
        webhook: ['exclude_kinds = ["retries_exhaused"]'],
      }),
    });
    let proxy: RecordingProxy | undefined;
    try {
      proxy = await startRecordingProxy();
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      await worker.prepare();
      const doctor = await worker.runCli(["worker", "doctor"]);
      expect(doctor.exitCode, doctor.stdout).toBe(1);
      const known =
        "known kinds: escalated, retries_exhausted, automation_broke, work_spawned, pr_opened, pr_auto_merged, source_unhealthy, internal_error.";
      expect(doctor.stdout).toContain(
        `❌ Workspace config — [notifications.slack].kinds has unknown kind "pr_merged"; ${known}`,
      );
      expect(doctor.stdout).toContain(
        `❌ Workspace config — [notifications.webhook].exclude_kinds has unknown kind "retries_exhaused"; ${known}`,
      );
      expect(doctor.stdout).toContain("Setup: not_ready — 2 checks failed (Workspace config).");
      expect(proxy.requests()).toEqual([]);
    } finally {
      await worker.dispose();
      await proxy?.close();
    }
  },
  30_000,
);

cliTest(
  "kind and severity filters decide per channel which notifications are delivered",
  async () => {
    const credentials = notificationCredentials();
    const { slackPath, signingSecret, secrets } = credentials;
    const cleanupErrors: string[] = [];
    let proxy: RecordingProxy | undefined;
    let receiver: NotificationReceiverFixture | undefined;
    let worker: WorkerFixture | undefined;
    try {
      proxy = await startRecordingProxy();
      receiver = NotificationReceiverFixture.start();
      worker = new WorkerFixture({
        rootPrefix: "devintern-e2e-notify-filters-",
        env: {
          E2E_FAIL_PROMPT_MARKER: FAIL_MARKER,
          E2E_DEVINTERN_CLI: cliPath,
          E2E_DELEGATE_REPO: "fixture",
        },
        workspaceTomlExtra: notificationsToml({
          slack: ['exclude_kinds = ["retries_exhausted"]'],
          webhook: ['min_severity = "normal"'],
        }),
      });
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      const w = worker;
      const r = receiver;
      await w.prepare();
      writeNotificationEnv(w.workspaceDir, r, credentials);
      const diagnostics = () =>
        redactSecrets(
          [
            `notifications: ${JSON.stringify(notificationRows(w.dbPath))}`,
            `deliveries: ${JSON.stringify(deliveryRows(w.dbPath))}`,
            `runs: ${JSON.stringify(w.runRecords())}`,
            `receiver: ${describeRequests(r.requests)}`,
            w.tail(),
          ].join("\n"),
          credentials,
        );

      // An injection-only worker needs queued work to start; this one succeeds.
      const warmup = await w.addTask({
        title: "Change the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      w.start();
      await w.waitForReady();
      await w.waitForOutput(/Notification delivery: slack, webhook/, 30_000, "delivery start");
      expect((await w.waitForSettled(warmup.id, 60_000)).task.status, diagnostics()).toBe("done");
      const firstTick = await w.waitFor(
        "the first delivery tick",
        () => lastDeliveryTickAt(w.dbPath),
        60_000,
      );

      // High severity, kind retries_exhausted.
      const failing = await w.addTask({
        title: "Break the greeting",
        body: `Change the greeting. ${FAIL_MARKER}`,
      });
      const failed = await w.waitForSettled(failing.id, 60_000);
      expect(failed.task.status, diagnostics()).toBe("failed");
      const failedRun = failed.runs.at(-1)!;

      // Normal severity, kind work_spawned: the agent delegates a follow-up.
      const delegating = await w.addTask({
        title: "Delegate a follow-up",
        body: "Change the greeting to Hello, world! and run bun test. E2EDELEGATEFOLLOWUP",
      });
      const delegated = await w.waitForSettled(delegating.id, 60_000);
      expect(delegated.task.status, diagnostics()).toBe("done");
      const parentRun = delegated.runs.at(-1)!;
      const child = await w.waitFor(
        "the delegated follow-up to settle",
        () =>
          readQueueRows<{ id: number; status: string }>(
            w.dbPath,
            "injected_tasks",
            `SELECT id, status FROM injected_tasks WHERE parent_run_id = ${parentRun.id}`,
          ).find((row) => row.status === "done" || row.status === "failed"),
        90_000,
      );
      expect(child.status, diagnostics()).toBe("done");

      const exhausted = await w.waitFor(
        "the retries_exhausted notification",
        () => notificationRows(w.dbPath).find((row) => row.run_id === failedRun.id),
        15_000,
      );
      expect(exhausted).toMatchObject({ kind: "retries_exhausted", severity: "high" });
      const spawned = await w.waitFor(
        "the work_spawned notification",
        () => notificationRows(w.dbPath).find((row) => row.kind === "work_spawned"),
        15_000,
      );
      expect(spawned, diagnostics()).toMatchObject({
        severity: "normal",
        run_id: parentRun.id,
        group_key: `work_spawned:run:${parentRun.id}`,
        count: 1,
      });
      expect(Math.min(exhausted.updated_at, spawned.updated_at)).toBeGreaterThan(firstTick);

      // Both channels have handled both rows once a tick has recorded them.
      await w.waitFor(
        "both channels to handle both notifications",
        () =>
          deliveryRows(w.dbPath).filter((row) =>
            [exhausted.id, spawned.id].includes(row.notification_id),
          ).length === 4
            ? true
            : undefined,
        90_000,
      );
      // A further tick sends nothing more.
      const handledAt = Date.now();
      await w.waitFor(
        "a delivery tick after both were handled",
        () => ((lastDeliveryTickAt(w.dbPath) ?? 0) > handledAt ? true : undefined),
        60_000,
      );
      await Bun.sleep(1_000);

      const status = (channel: string, id: number) =>
        deliveryRows(w.dbPath).find((row) => row.channel === channel && row.notification_id === id)
          ?.status;
      // Slack: retries_exhausted is excluded by kind; work_spawned is below
      // the default min_severity "high".
      expect(r.requestsTo(slackPath), diagnostics()).toHaveLength(0);
      expect(status("slack", exhausted.id), diagnostics()).toBe("skipped");
      expect(status("slack", spawned.id), diagnostics()).toBe("skipped");
      // Webhook: no kind filter, min_severity "normal": both, once each.
      const hooks = r.requestsTo(HOOK_PATH);
      expect(hooks, diagnostics()).toHaveLength(2);
      expect(r.requests, diagnostics()).toHaveLength(2);
      expect(status("webhook", exhausted.id), diagnostics()).toBe("sent");
      expect(status("webhook", spawned.id), diagnostics()).toBe("sent");
      const payloads = hooks.map((hook) => JSON.parse(hook.body) as WebhookPayload);
      const byKind = Object.fromEntries(
        payloads.map((payload) => [payload.notification.kind, payload]),
      );
      expect(byKind.retries_exhausted, diagnostics()).toMatchObject({
        source: "devintern",
        version: 1,
        type: "notification",
        event: "created",
        notification: { id: exhausted.id, severity: "high", groupKey: exhausted.group_key },
        dashboardUrl: `${NOTIFY_DASHBOARD_URL}/#/runs/${failedRun.id}`,
      });
      expect(byKind.work_spawned, diagnostics()).toMatchObject({
        source: "devintern",
        version: 1,
        type: "notification",
        event: "created",
        notification: { id: spawned.id, severity: "normal", groupKey: spawned.group_key },
        dashboardUrl: `${NOTIFY_DASHBOARD_URL}/#/runs/${parentRun.id}`,
      });
      for (const hook of hooks) {
        expect(
          hook.headers["x-devintern-signature"] === expectedSignature(signingSecret, hook.body),
        ).toBe(true);
        expect(containsSecret(hook.body, secrets)).toBe(false);
      }
      expect(containsSecret(w.logs, secrets)).toBe(false);
      expect(w.logs.includes(r.url)).toBe(false);
      expect(proxy.requests(), "no request may reach the proxy").toEqual([]);
    } finally {
      if (worker) {
        try {
          await worker.dispose();
        } catch (error) {
          cleanupErrors.push(`worker: ${(error as Error).message}`);
        }
      }
      try {
        receiver?.dispose();
      } catch (error) {
        cleanupErrors.push(`receiver: ${(error as Error).message}`);
      }
      try {
        await proxy?.close();
      } catch (error) {
        cleanupErrors.push(`proxy: ${(error as Error).message}`);
      }
      if (cleanupErrors.length > 0) console.warn(`cleanup incomplete: ${cleanupErrors.join("; ")}`);
    }
  },
  // prepare + warm-up + first tick (≤30 s) + three runs + delivery tick
  // (≤30 s) + a confirming tick (≤30 s).
  240_000,
);
