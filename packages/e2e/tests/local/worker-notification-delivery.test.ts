/**
 * Worker notification delivery to Slack and a signed generic webhook.
 *
 * Drives the real built `devintern worker` daemon with `[notifications.slack]`
 * and `[notifications.webhook]` pointing at a loopback receiver. Both endpoint
 * URLs and the signing secret live only in the workspace `.env`, so the test
 * also proves the worker reads them from there. A task whose prompt carries a
 * fail marker makes the deterministic agent exit non-zero, which settles the
 * ad-hoc task failed and raises a high-severity notification.
 *
 * Delivery ticks every 30 s and a channel only delivers notifications created
 * after its first tick, so the failing task is enqueued once that tick has
 * run. Ticks are read from the queue DB, never only slept on.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  HOOK_PATH,
  NOTIFY_DASHBOARD_URL as DASHBOARD_URL,
  deliveryRows,
  describeRequests,
  expectedSignature,
  lastDeliveryTickAt,
  leakForms,
  notificationCredentials,
  notificationRows,
  notificationsToml,
  redactSecrets,
  writeNotificationEnv,
} from "../../helpers/notification-delivery";
import type { WebhookPayload } from "../../helpers/notification-delivery";
import { NotificationReceiverFixture } from "../../helpers/notification-receiver";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/** Alphanumeric so Markdown escaping cannot hide it from the fake agent. */
const FAIL_MARKER = "E2ENOTIFYFAILMARKER";
/** Sends per message when every attempt fails: one try plus two retries. */
const ATTEMPTS_PER_FAILED_SEND = 3;

const notifications = (worker: WorkerFixture) => notificationRows(worker.dbPath);
const deliveries = (worker: WorkerFixture) => deliveryRows(worker.dbPath);
const lastTickAt = (worker: WorkerFixture) => lastDeliveryTickAt(worker.dbPath);

cliTest(
  "the worker delivers a failed run to Slack and a signed webhook, rate-limits a repeat, and isolates a failing endpoint",
  async () => {
    // Generated dummies: never a real Slack token or signing secret.
    const credentials = notificationCredentials();
    const { slackPath, signingSecret, secrets } = credentials;

    const receiver = NotificationReceiverFixture.start();
    let worker: WorkerFixture | undefined;
    const cleanupErrors: string[] = [];
    try {
      worker = new WorkerFixture({
        env: { E2E_FAIL_PROMPT_MARKER: FAIL_MARKER },
        workspaceTomlExtra: notificationsToml(),
      });
      const w = worker;
      await w.prepare();
      // Endpoints and secret only in the workspace .env, never in the process env.
      writeNotificationEnv(w.workspaceDir, receiver, credentials);

      const slackRequests = () => receiver.requestsTo(slackPath);
      const hookRequests = () => receiver.requestsTo(HOOK_PATH);
      const diagnostics = () =>
        redactSecrets(
          [
            `notifications: ${JSON.stringify(notifications(w))}`,
            `deliveries: ${JSON.stringify(deliveries(w))}`,
            `runs: ${JSON.stringify(w.runRecords())}`,
            `receiver: ${describeRequests(receiver.requests)}`,
            w.tail(),
          ].join("\n"),
          credentials,
        );

      // An injection-only worker needs queued work to start. This task
      // succeeds; its run settles before delivery's first tick.
      const warmup = await w.addTask({
        title: "Change the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      w.start();
      await w.waitForReady();
      await w.waitForOutput(/Notification delivery: slack, webhook/, 30_000, "delivery start");
      const warm = await w.waitForSettled(warmup.id, 60_000);
      expect(warm.task.status, diagnostics()).toBe("done");

      // A channel only delivers notifications newer than its first tick.
      const firstTick = await w.waitFor("the first delivery tick", () => lastTickAt(w), 60_000);

      // --- Phase 1: one failed run reaches both channels. -----------------
      const failing = await w.addTask({
        title: "Break the greeting",
        body: `Change the greeting. ${FAIL_MARKER}`,
      });
      const failed = await w.waitForSettled(failing.id, 60_000);
      expect(failed.task.status, diagnostics()).toBe("failed");
      const failedRun = failed.runs.at(-1)!;
      expect(failedRun.status, diagnostics()).toBe("failed");

      const row = await w.waitFor(
        "a high-severity notification for the failed run",
        () =>
          notifications(w).find(
            (entry) => entry.severity === "high" && entry.run_id === failedRun.id,
          ),
        15_000,
      );
      // A failed ad-hoc task with no retry queued is the last word for it.
      expect(row.kind, diagnostics()).toBe("retries_exhausted");
      expect(row.group_key).toBe(`retries_exhausted:task:${failing.task_key}`);
      expect(row.repo).toBe(w.repoName);
      expect(row.updated_at).toBeGreaterThan(firstTick);

      await w.waitFor(
        "webhook and Slack delivery",
        () => (hookRequests().length >= 1 && slackRequests().length >= 1 ? true : undefined),
        90_000,
      );
      // A later tick must not resend: wait for one to start after both receipts.
      const deliveredAt = Math.max(...receiver.requests.map((request) => request.at));
      await w.waitFor(
        "a delivery tick after the first delivery",
        () => ((lastTickAt(w) ?? 0) > deliveredAt ? true : undefined),
        60_000,
      );
      await Bun.sleep(1_000);
      expect(hookRequests(), diagnostics()).toHaveLength(1);
      expect(slackRequests(), diagnostics()).toHaveLength(1);
      // No other path was contacted, for example by a misread URL.
      expect(receiver.requests.length, diagnostics()).toBe(2);

      const hook = hookRequests()[0]!;
      expect(hook.method).toBe("POST");
      expect(hook.headers["content-type"]).toContain("application/json");
      const payload = JSON.parse(hook.body) as WebhookPayload;
      expect(payload).toMatchObject({
        source: "devintern",
        version: 1,
        type: "notification",
        event: "created",
        notification: {
          id: row.id,
          kind: row.kind,
          severity: "high",
          repo: w.repoName,
          title: row.title,
          groupKey: row.group_key,
          count: 1,
        },
      });
      expect(payload.dashboardUrl).toBe(`${DASHBOARD_URL}/#/runs/${failedRun.id}`);
      // Compare booleans so a mismatch cannot print a value derived from the secret.
      expect(
        hook.headers["x-devintern-signature"] === expectedSignature(signingSecret, hook.body),
      ).toBe(true);

      const slack = slackRequests()[0]!;
      expect(slack.method).toBe("POST");
      expect(slack.headers["content-type"]).toContain("application/json");
      expect(slack.headers["x-devintern-signature"]).toBeUndefined();
      const slackBody = JSON.parse(slack.body) as { text: string };
      expect(slackBody.text).toContain(row.title);
      expect(slackBody.text).toContain(
        `<${DASHBOARD_URL}/#/runs/${failedRun.id}|Open in dashboard>`,
      );
      expect(slackBody.text).toContain(`repo ${w.repoName}`);

      // --- Phase 2: a repeat of the group is held; a new group still goes out,
      // and a failing webhook does not block Slack or change the run. -------
      receiver.respond(HOOK_PATH, 500);
      const resumed = await w.runAdd(["--resume", failing.task_key, "--json"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      await w.waitFor(
        "the resumed run to fail again",
        () => {
          const runs = w.runRecords(failing.task_key);
          return runs.length >= 2 && runs.at(-1)!.status === "failed" ? true : undefined;
        },
        60_000,
      );
      const repeat = await w.waitFor(
        "the repeat to fold into the same notification group",
        () => notifications(w).find((entry) => entry.id === row.id && entry.count === 2),
        15_000,
      );
      expect(repeat.group_key).toBe(row.group_key);

      const second = await w.addTask({
        title: "Break the farewell",
        body: `Change the farewell. ${FAIL_MARKER}`,
      });
      const secondSettled = await w.waitForSettled(second.id, 60_000);
      expect(secondSettled.task.status, diagnostics()).toBe("failed");
      const secondRun = secondSettled.runs.at(-1)!;
      const secondRow = await w.waitFor(
        "a notification for the second task",
        () =>
          notifications(w).find(
            (entry) => entry.severity === "high" && entry.run_id === secondRun.id,
          ),
        15_000,
      );
      expect(secondRow.group_key).not.toBe(row.group_key);
      const outcomeBefore = { status: secondRun.status, reason: secondRun.outcome_reason };

      await w.waitFor(
        "Slack delivery of the new group and the failing webhook attempts",
        () =>
          slackRequests().length >= 2 && hookRequests().length >= 1 + ATTEMPTS_PER_FAILED_SEND
            ? true
            : undefined,
        90_000,
      );
      const phase2At = Math.max(...receiver.requests.map((request) => request.at));
      await w.waitFor(
        "a delivery tick after the second delivery",
        () => ((lastTickAt(w) ?? 0) > phase2At ? true : undefined),
        60_000,
      );
      await Bun.sleep(1_000);

      // Slack: exactly one more message, for the new group only.
      expect(slackRequests(), diagnostics()).toHaveLength(2);
      const slackSecond = JSON.parse(slackRequests()[1]!.body) as { text: string };
      expect(slackSecond.text).toContain(secondRow.title);
      expect(slackSecond.text).toContain(`${DASHBOARD_URL}/#/runs/${secondRun.id}`);
      // Webhook: one try plus two retries for the new group, then given up.
      const failedHooks = hookRequests().slice(1);
      expect(failedHooks, diagnostics()).toHaveLength(ATTEMPTS_PER_FAILED_SEND);
      for (const attempt of failedHooks) {
        expect(attempt.status).toBe(500);
        const attemptPayload = JSON.parse(attempt.body) as WebhookPayload;
        expect(attemptPayload.notification.id).toBe(secondRow.id);
      }
      // The webhook's retry delays did not hold up the Slack send.
      expect(slackRequests()[1]!.at).toBeLessThan(failedHooks.at(-1)!.at);
      // The held repeat stays undelivered on both channels.
      for (const channel of ["slack", "webhook"]) {
        const record = deliveries(w).find(
          (entry) => entry.channel === channel && entry.notification_id === row.id,
        );
        expect(record?.delivered_count, diagnostics()).toBe(1);
      }
      expect(
        deliveries(w).find(
          (entry) => entry.channel === "webhook" && entry.notification_id === secondRow.id,
        )?.status,
      ).toBe("failed");
      await w.waitForOutput(
        new RegExp(
          `webhook delivery of notification #${secondRow.id} failed: webhook answered HTTP 500`,
        ),
        5_000,
        "the webhook failure warning",
      );
      // Delivery failure changed neither the run nor the worker.
      const after = w.runRecords(second.task_key).at(-1)!;
      expect({ status: after.status, reason: after.outcome_reason }).toEqual(outcomeBefore);
      expect(w.running, diagnostics()).toBe(true);

      // --- Redaction: no credential in any body or the worker log. --------
      for (const secret of secrets) {
        for (const form of leakForms(secret)) {
          for (const request of receiver.requests) {
            expect(request.body.includes(form)).toBe(false);
          }
          expect(w.logs.includes(form)).toBe(false);
        }
      }
      expect(w.logs.includes(receiver.url)).toBe(false);
    } finally {
      if (worker) {
        try {
          await worker.dispose();
        } catch (error) {
          cleanupErrors.push(`worker: ${(error as Error).message}`);
        }
      }
      try {
        receiver.dispose();
      } catch (error) {
        cleanupErrors.push(`receiver: ${(error as Error).message}`);
      }
      if (cleanupErrors.length > 0) console.warn(`cleanup incomplete: ${cleanupErrors.join("; ")}`);
    }
  },
  // prepare + warm-up run + first tick (≤30 s) + failed run + delivery tick
  // (≤30 s) + two more failed runs + delivery tick with 5 s of retries + a
  // confirming tick (≤30 s).
  240_000,
);
