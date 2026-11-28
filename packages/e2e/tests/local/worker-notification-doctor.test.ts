/**
 * `devintern worker doctor --test-notifications`: one test message per
 * configured `[notifications]` channel (Slack and a signed generic webhook)
 * to a loopback receiver (`packages/code/src/lib/notifications/delivery/doctor.ts`,
 * flag parsing in `packages/code/src/lib/worker/cli.ts`).
 *
 * Endpoint URLs and the signing secret come only from the workspace `.env`.
 * A refusing recording proxy proves nothing leaves the machine.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { NotificationReceiverFixture } from "../../helpers/notification-receiver";
import {
  HOOK_PATH,
  HOOK_SECRET_ENV,
  HOOK_URL_ENV,
  NOTIFY_DASHBOARD_URL,
  SLACK_URL_ENV,
  containsSecret,
  describeRequests,
  expectedSignature,
  notificationCredentials,
  notificationsToml,
  writeNotificationEnv,
} from "../../helpers/notification-delivery";
import type { WebhookPayload } from "../../helpers/notification-delivery";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

/** Sends per message when every attempt fails: one try plus two retries. */
const ATTEMPTS_PER_FAILED_SEND = 3;

const SLACK_ITEM = `✓ slack: URL from ${SLACK_URL_ENV}; high severity, max 1 per 60 min per cause`;
const HOOK_ITEM = `✓ webhook: URL from ${HOOK_URL_ENV}, signed with ${HOOK_SECRET_ENV}; high severity, max 1 per 60 min per cause`;

cliTest(
  "worker doctor --test-notifications sends one signed test message per channel and reports a failing endpoint",
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
        rootPrefix: "devintern-e2e-notify-doctor-",
        workspaceTomlExtra: notificationsToml(),
      });
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      const w = worker;
      const r = receiver;
      await w.prepare();
      writeNotificationEnv(w.workspaceDir, r, credentials);
      const doctor = async (args: string[]) => {
        const result = await w.runCli(["worker", "doctor", ...args]);
        // Booleans, so a failing check cannot print a credential.
        expect(containsSecret(result.stdout, secrets)).toBe(false);
        expect(containsSecret(result.stderr, secrets)).toBe(false);
        expect(result.stdout.includes(r.url)).toBe(false);
        return result;
      };
      const diag = () => `receiver: ${describeRequests(r.requests)}`;

      // --- Without the flag: the row lists channels and sends nothing. ------
      const plain = await doctor([]);
      expect(plain.exitCode, plain.stdout).toBe(0);
      expect(plain.stdout).toContain(
        `✅ Notification delivery — slack, webhook; links open ${NOTIFY_DASHBOARD_URL} (send a test with --test-notifications)`,
      );
      expect(plain.stdout).toContain(SLACK_ITEM);
      expect(plain.stdout).toContain(HOOK_ITEM);
      expect(plain.stdout).not.toContain("test message sent");
      expect(r.requests, diag()).toHaveLength(0);

      // --- With the flag: exactly one message per channel. ------------------
      const sent = await doctor(["--test-notifications"]);
      expect(sent.exitCode, sent.stdout).toBe(0);
      expect(sent.stdout).toContain(
        `✅ Notification delivery — slack, webhook; links open ${NOTIFY_DASHBOARD_URL}\n`,
      );
      expect(sent.stdout).toContain(`${SLACK_ITEM}\n       test message sent`);
      expect(sent.stdout).toContain(`${HOOK_ITEM}\n       test message sent`);
      expect(sent.stdout).not.toContain("❌");
      expect(r.requestsTo(slackPath), diag()).toHaveLength(1);
      expect(r.requestsTo(HOOK_PATH), diag()).toHaveLength(1);
      expect(r.requests, diag()).toHaveLength(2);

      const hook = r.requestsTo(HOOK_PATH)[0]!;
      expect(hook.method).toBe("POST");
      expect(hook.headers["content-type"]).toContain("application/json");
      const payload = JSON.parse(hook.body) as WebhookPayload;
      expect(payload).toMatchObject({
        source: "devintern",
        version: 1,
        type: "notification",
        event: "test",
        notification: { title: "DevIntern test notification", groupKey: "test", count: 1 },
        dashboardUrl: `${NOTIFY_DASHBOARD_URL}/#/inbox`,
      });
      expect(
        hook.headers["x-devintern-signature"] === expectedSignature(signingSecret, hook.body),
      ).toBe(true);

      const slack = r.requestsTo(slackPath)[0]!;
      expect(slack.method).toBe("POST");
      expect(slack.headers["content-type"]).toContain("application/json");
      expect(slack.headers["x-devintern-signature"]).toBeUndefined();
      const slackBody = JSON.parse(slack.body) as { text: string };
      expect(slackBody.text).toContain("DevIntern test notification");
      expect(slackBody.text).toContain(`<${NOTIFY_DASHBOARD_URL}/#/inbox|Open in dashboard>`);

      // --- A failing webhook: doctor fails that channel; Slack still sends. --
      r.respond(HOOK_PATH, 500);
      const failed = await doctor(["--test-notifications"]);
      expect(failed.exitCode, failed.stdout).toBe(1);
      expect(failed.stdout).toContain(
        "❌ Notification delivery — slack, webhook: 1 test message(s) failed",
      );
      expect(failed.stdout).toContain(`${SLACK_ITEM}\n       test message sent`);
      expect(failed.stdout).toContain(
        `${HOOK_ITEM}\n       test failed: webhook answered HTTP 500`,
      );
      expect(failed.stdout).toContain(
        "💡 Check the endpoint URL in the workspace .env and that this host can reach it",
      );
      expect(failed.stdout).toContain("Setup: not_ready — 1 check failed (Notification delivery).");
      expect(r.requestsTo(slackPath), diag()).toHaveLength(2);
      const failedHooks = r.requestsTo(HOOK_PATH).slice(1);
      expect(failedHooks, diag()).toHaveLength(ATTEMPTS_PER_FAILED_SEND);
      for (const attempt of failedHooks) {
        expect(attempt.status).toBe(500);
        expect((JSON.parse(attempt.body) as WebhookPayload).event).toBe("test");
        expect(
          attempt.headers["x-devintern-signature"] ===
            expectedSignature(signingSecret, attempt.body),
        ).toBe(true);
      }

      // --- Nothing left the machine; no credential in any body. -------------
      for (const request of r.requests) {
        expect(containsSecret(request.body, secrets)).toBe(false);
      }
      expect(proxy.requests(), "no request may reach the proxy").toEqual([]);
      // Doctor stays side-effect free: no state database.
      expect(existsSync(w.dbPath)).toBe(false);
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
  60_000,
);
