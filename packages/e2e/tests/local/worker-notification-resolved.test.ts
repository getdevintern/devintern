/**
 * `notify_resolved` resolve messages from the real built `devintern worker`
 * (`packages/code/src/lib/notifications/delivery/dispatcher.ts`,
 * `resolvedToAnnounce`).
 *
 * A one-shot failure (`E2E_FAIL_ONCE_FILE`) fails an ad-hoc task, which raises
 * a `retries_exhausted` notification delivered to Slack and the webhook. A
 * `worker add --resume` of the same task then succeeds, the run rules resolve
 * the notification, and only the webhook (`notify_resolved = true`) gets one
 * signed `event: "resolved"` message. Slack (no `notify_resolved`) gets none,
 * and a later tick does not resend.
 */

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

cliTest(
  "a resolved notification sends one resolve message on the notify_resolved channel only",
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
        rootPrefix: "devintern-e2e-notify-resolved-",
        workspaceTomlExtra: notificationsToml({ webhook: ["notify_resolved = true"] }),
      });
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      const w = worker;
      const r = receiver;
      // The sentinel fails the next agent invocation only; it is planted after
      // the warm-up, so only the task under test fails (once).
      const failOnce = join(w.root, "fail-once");
      w.env.E2E_FAIL_ONCE_FILE = failOnce;
      await w.prepare();
      writeNotificationEnv(w.workspaceDir, r, credentials);
      const slackRequests = () => r.requestsTo(slackPath);
      const hookRequests = () => r.requestsTo(HOOK_PATH);
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

      const warmup = await w.addTask({
        title: "Change the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      w.start();
      await w.waitForReady();
      await w.waitForOutput(/Notification delivery: slack, webhook/, 30_000, "delivery start");
      expect((await w.waitForSettled(warmup.id, 60_000)).task.status, diagnostics()).toBe("done");
      await w.waitFor("the first delivery tick", () => lastDeliveryTickAt(w.dbPath), 60_000);

      // --- A failed run raises a notification on both channels. -------------
      writeFileSync(failOnce, "1");
      const task = await w.addTask({
        title: "Fail once, then change the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      const failed = await w.waitForSettled(task.id, 60_000);
      expect(failed.task.status, diagnostics()).toBe("failed");
      expect(existsSync(failOnce), diagnostics()).toBe(false);
      const failedRun = failed.runs.at(-1)!;
      const row = await w.waitFor(
        "the retries_exhausted notification",
        () => notificationRows(w.dbPath).find((entry) => entry.run_id === failedRun.id),
        15_000,
      );
      expect(row).toMatchObject({ kind: "retries_exhausted", resolved_at: null });
      await w.waitFor(
        "created delivery on both channels",
        () => (hookRequests().length >= 1 && slackRequests().length >= 1 ? true : undefined),
        90_000,
      );
      expect((JSON.parse(hookRequests()[0]!.body) as WebhookPayload).event).toBe("created");

      // --- A later successful run of the same task resolves it. -------------
      const resumed = await w.runAdd(["--resume", task.task_key, "--json"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      await w.waitFor(
        "the resumed run to succeed",
        () => {
          const runs = w.runRecords(task.task_key);
          return runs.length >= 2 && runs.at(-1)!.status === "succeeded" ? true : undefined;
        },
        60_000,
      );
      const resolved = await w.waitFor(
        "the notification to resolve",
        () =>
          notificationRows(w.dbPath).find(
            (entry) => entry.id === row.id && entry.resolved_at !== null,
          ),
        15_000,
      );
      await w.waitFor(
        "the resolve message on the webhook",
        () => (hookRequests().length >= 2 ? true : undefined),
        90_000,
      );
      // Later ticks do not resend.
      const sentAt = hookRequests()[1]!.at;
      await w.waitFor(
        "a delivery tick after the resolve message",
        () => ((lastDeliveryTickAt(w.dbPath) ?? 0) > sentAt ? true : undefined),
        60_000,
      );
      await Bun.sleep(1_000);

      expect(hookRequests(), diagnostics()).toHaveLength(2);
      expect(slackRequests(), diagnostics()).toHaveLength(1);
      expect(r.requests, diagnostics()).toHaveLength(3);

      const hook = hookRequests()[1]!;
      expect(hook.method).toBe("POST");
      const payload = JSON.parse(hook.body) as WebhookPayload;
      expect(payload, diagnostics()).toMatchObject({
        source: "devintern",
        version: 1,
        type: "notification",
        event: "resolved",
        notification: {
          id: row.id,
          kind: "retries_exhausted",
          groupKey: row.group_key,
          title: row.title,
          count: 1,
        },
        dashboardUrl: `${NOTIFY_DASHBOARD_URL}/#/runs/${failedRun.id}`,
      });
      expect((payload.notification as { resolvedAt?: number }).resolvedAt, diagnostics()).toBe(
        resolved.resolved_at!,
      );
      expect(
        hook.headers["x-devintern-signature"] === expectedSignature(signingSecret, hook.body),
      ).toBe(true);

      const record = (channel: string) =>
        deliveryRows(w.dbPath).find(
          (entry) => entry.channel === channel && entry.notification_id === row.id,
        );
      expect(record("webhook"), diagnostics()).toMatchObject({ status: "sent", resolved_sent: 1 });
      expect(record("slack"), diagnostics()).toMatchObject({ status: "sent", resolved_sent: 0 });

      for (const request of r.requests) {
        expect(containsSecret(request.body, secrets)).toBe(false);
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
  // prepare + warm-up + first tick (≤30 s) + failed run + delivery tick
  // (≤30 s) + resumed run + resolve tick (≤30 s) + a confirming tick (≤30 s).
  270_000,
);
