/**
 * Shared setup for worker notification delivery tests: generated dummy
 * endpoint credentials, the workspace `.env` that carries them, the
 * `[notifications]` TOML block, queue-DB readers for notification and
 * delivery state, and leak/redaction helpers.
 *
 * Endpoint URLs and the signing secret live only in the workspace `.env`
 * (`url_env`, `secret_env`), never in `workspace.toml` or the process env.
 */

import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readQueueRows } from "./dashboard";
import type {
  NotificationReceiverFixture,
  NotificationRequestRecord,
} from "./notification-receiver";

export const NOTIFY_DASHBOARD_URL = "https://devintern-e2e.invalid/board";
export const SLACK_PATH_PREFIX = "/slack/services/";
export const HOOK_PATH = "/hook";
export const SLACK_URL_ENV = "E2E_SLACK_WEBHOOK_URL";
export const HOOK_URL_ENV = "E2E_NOTIFY_WEBHOOK_URL";
export const HOOK_SECRET_ENV = "E2E_NOTIFY_WEBHOOK_SECRET";

/** A stored notification row, as the delivery tests read it. */
export interface NotificationRow {
  id: number;
  kind: string;
  severity: string;
  group_key: string;
  count: number;
  run_id: number | null;
  repo: string | null;
  title: string;
  updated_at: number;
  resolved_at: number | null;
}

/** One channel's delivery record for one notification. */
export interface DeliveryRow {
  channel: string;
  notification_id: number;
  delivered_count: number;
  status: string;
  resolved_sent: number;
}

/** The documented generic-webhook body. */
export interface WebhookPayload {
  source: string;
  version: number;
  type: string;
  event: string;
  notification: {
    id: number;
    kind: string;
    severity: string;
    repo?: string;
    title: string;
    groupKey: string;
    count: number;
  };
  cause?: string;
  dashboardUrl: string;
}

/** Generated dummy credentials for one test: never a real Slack token or secret. */
export interface NotificationCredentials {
  slackToken: string;
  slackPath: string;
  signingSecret: string;
  /** Every credential, for leak checks. */
  secrets: string[];
}

/** Generate a Slack-shaped dummy token path and a webhook signing secret. */
export function notificationCredentials(): NotificationCredentials {
  const slackToken = `T${randomBytes(4).toString("hex").toUpperCase()}/B${randomBytes(4)
    .toString("hex")
    .toUpperCase()}/${randomBytes(12).toString("hex")}`;
  const signingSecret = `whsec-e2e-${randomBytes(16).toString("hex")}`;
  return {
    slackToken,
    slackPath: `${SLACK_PATH_PREFIX}${slackToken}`,
    signingSecret,
    secrets: [slackToken, signingSecret],
  };
}

/**
 * The `[notifications]` block with Slack and a signed webhook reading their
 * endpoints from the workspace `.env`. `slack` and `webhook` add extra lines
 * to each channel table (filters, `notify_resolved`, ...).
 */
export function notificationsToml(extra: { slack?: string[]; webhook?: string[] } = {}): string {
  return [
    "[notifications]",
    `dashboard_url = "${NOTIFY_DASHBOARD_URL}"`,
    "",
    "[notifications.slack]",
    `url_env = "${SLACK_URL_ENV}"`,
    ...(extra.slack ?? []),
    "",
    "[notifications.webhook]",
    `url_env = "${HOOK_URL_ENV}"`,
    `secret_env = "${HOOK_SECRET_ENV}"`,
    ...(extra.webhook ?? []),
  ].join("\n");
}

/** Write the endpoint URLs and signing secret to the workspace `.env` (mode 0600). */
export function writeNotificationEnv(
  workspaceDir: string,
  receiver: NotificationReceiverFixture,
  credentials: NotificationCredentials,
): void {
  writeFileSync(
    join(workspaceDir, ".env"),
    [
      `${SLACK_URL_ENV}=${receiver.endpoint(credentials.slackPath)}`,
      `${HOOK_URL_ENV}=${receiver.endpoint(HOOK_PATH)}`,
      `${HOOK_SECRET_ENV}=${credentials.signingSecret}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

/** Notification rows in the worker's queue DB, oldest first. */
export function notificationRows(dbPath: string): NotificationRow[] {
  return readQueueRows<NotificationRow>(
    dbPath,
    "notifications",
    "SELECT id, kind, severity, group_key, count, run_id, repo, title, updated_at, resolved_at FROM notifications ORDER BY id",
  );
}

/** Per-channel delivery records in the worker's queue DB. */
export function deliveryRows(dbPath: string): DeliveryRow[] {
  return readQueueRows<DeliveryRow>(
    dbPath,
    "notification_deliveries",
    "SELECT channel, notification_id, delivered_count, status, resolved_sent FROM notification_deliveries ORDER BY channel, notification_id",
  );
}

/** When the delivery loop last started a tick, if it has. */
export function lastDeliveryTickAt(dbPath: string): number | undefined {
  return readQueueRows<{ last_tick_at: number }>(
    dbPath,
    "notification_delivery_ticks",
    "SELECT last_tick_at FROM notification_delivery_ticks WHERE id = 1",
  )[0]?.last_tick_at;
}

/** `sha256=<hex HMAC-SHA256 of the raw body>`, as `X-DevIntern-Signature` carries it. */
export function expectedSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Every form a credential could take on the wire or in a log. */
export function leakForms(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value), encodeURI(value)])];
}

/** Whether any credential (in any encoding) appears in `text`. Returns a boolean so a failure cannot print it. */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => leakForms(secret).some((form) => text.includes(form)));
}

/** Redacted request summary for failure messages: no bodies, no secret-bearing paths. */
export function describeRequests(requests: NotificationRequestRecord[]): string {
  return JSON.stringify(
    requests.map(({ method, path, status, at }) => ({
      method,
      path: path.startsWith(SLACK_PATH_PREFIX) ? `${SLACK_PATH_PREFIX}<redacted>` : path,
      status,
      at,
    })),
  );
}

/** Replace every credential in `text` with a placeholder. */
export function redactSecrets(text: string, credentials: NotificationCredentials): string {
  let out = text;
  for (const form of leakForms(credentials.slackToken)) out = out.replaceAll(form, "<slack-token>");
  for (const form of leakForms(credentials.signingSecret)) out = out.replaceAll(form, "<secret>");
  return out;
}
