/**
 * Delivery channels: payload builders plus senders for the OS desktop
 * notifier, Slack incoming webhooks, and generic JSON webhooks.
 *
 * Every sender goes through {@link sendToChannel}, which retries a failed
 * attempt a small bounded number of times and then throws. Errors never
 * include the endpoint URL (a Slack webhook URL is a credential).
 */

import { createHmac } from "crypto";

import type { NotificationChannelConfig } from "./config";
import { digestHeadline, kindLabel, messageHeadline } from "./message";
import type { DeliveryMessage, DigestMessage, NotificationMessage } from "./message";

type Env = Record<string, string | undefined>;

/** Side effects a sender needs; injectable for tests. */
export interface ChannelDeps {
  env: Env;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  platform: NodeJS.Platform;
  /** Path of an executable on PATH, or null. */
  which: (command: string) => string | null;
  /** Run a command without a shell. */
  run: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>;
  sleep: (ms: number) => Promise<void>;
  /** Delay before each retry; its length is the retry budget. Default `[1000, 4000]`. */
  retryDelaysMs?: readonly number[];
  /** Per-request timeout for HTTP channels. Default 10 s. */
  timeoutMs?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 4_000] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DESKTOP_BODY_CHARS = 400;
const WEBHOOK_SCHEMA_VERSION = 1;

/** Default side effects: real fetch, `Bun.which`, `Bun.spawn`. */
export function defaultChannelDeps(env: Env = process.env): ChannelDeps {
  return {
    env,
    fetch: (url, init) => fetch(url, init),
    platform: process.platform,
    which: (command) => Bun.which(command),
    run: async (argv) => {
      const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      return { exitCode, stderr };
    },
    sleep: (ms) => Bun.sleep(ms),
  };
}

/** A failure that retrying cannot fix (bad config, 4xx). */
export class PermanentDeliveryError extends Error {}

/** Whether a channel can send from this host, and why not. */
export interface ChannelAvailability {
  available: boolean;
  detail: string;
}

function desktopNotifier(platform: NodeJS.Platform): string | null {
  if (platform === "linux") return "notify-send";
  if (platform === "darwin") return "osascript";
  return null;
}

/** Endpoint URL of an HTTP channel, from inline config or its env var. */
export function channelUrl(channel: NotificationChannelConfig, env: Env): string | undefined {
  if (channel.url) return channel.url;
  const value = channel.urlEnv ? env[channel.urlEnv]?.trim() : undefined;
  return value || undefined;
}

/** Check that a channel has what it needs, without sending anything. */
export function channelAvailability(
  channel: NotificationChannelConfig,
  deps: Pick<ChannelDeps, "env" | "platform" | "which">,
): ChannelAvailability {
  if (channel.type === "desktop") {
    const notifier = desktopNotifier(deps.platform);
    if (!notifier) {
      return { available: false, detail: `not available on ${deps.platform}` };
    }
    return deps.which(notifier)
      ? { available: true, detail: `via ${notifier}` }
      : { available: false, detail: `${notifier} not found on PATH` };
  }
  const url = channelUrl(channel, deps.env);
  if (!url) {
    return { available: false, detail: `${channel.urlEnv} is not set` };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
  } catch {
    return { available: false, detail: `${channel.urlEnv} is not an http(s) URL` };
  }
  if (channel.secretEnv && !deps.env[channel.secretEnv]) {
    return { available: false, detail: `${channel.secretEnv} is not set` };
  }
  const source = channel.url ? "inline url" : `URL from ${channel.urlEnv}`;
  return {
    available: true,
    detail: channel.secretEnv ? `${source}, signed with ${channel.secretEnv}` : source,
  };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** Escape text for Slack mrkdwn. */
export function slackEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackLink(url: string, label: string): string {
  return `<${url.replaceAll("|", "%7C").replaceAll(">", "%3E")}|${slackEscape(label)}>`;
}

function severityIcon(message: NotificationMessage): string {
  if (message.event === "resolved") return "✅";
  return message.notification.severity === "high" ? "🔴" : "🔵";
}

function slackNotificationText(message: NotificationMessage): string {
  const { notification } = message;
  const lines = [`${severityIcon(message)} *${slackEscape(messageHeadline(message))}*`];
  if (message.cause && message.event !== "resolved") lines.push(slackEscape(message.cause));
  const meta = [
    kindLabel(notification.kind),
    ...(notification.repo ? [`repo ${slackEscape(notification.repo)}`] : []),
    slackLink(message.dashboardUrl, "Open in dashboard"),
  ];
  lines.push(meta.join(" · "));
  return lines.join("\n");
}

function slackDigestText(digest: DigestMessage): string {
  const lines = [
    `*${slackEscape(digestHeadline(digest))}*`,
    slackEscape(
      digest.countsByKind.map(({ kind, count }) => `${kindLabel(kind)}: ${count}`).join(", "),
    ),
  ];
  for (const item of digest.top) {
    const count = item.count > 1 ? ` (×${item.count})` : "";
    const repo = item.repo ? ` [${slackEscape(item.repo)}]` : "";
    const resolved = item.resolved ? " (resolved)" : "";
    lines.push(`• ${slackLink(item.dashboardUrl, `${item.title}${count}`)}${repo}${resolved}`);
  }
  const rest = digest.total - digest.top.length;
  if (rest > 0) lines.push(`…and ${rest} more`);
  lines.push(slackLink(digest.dashboardUrl, "Open the inbox"));
  return lines.join("\n");
}

/** Slack incoming-webhook body. */
export function slackPayload(message: DeliveryMessage): { text: string } {
  return {
    text: message.type === "digest" ? slackDigestText(message) : slackNotificationText(message),
  };
}

/** Generic webhook body: the redacted notification domain type plus context. */
export function webhookPayload(message: DeliveryMessage): Record<string, unknown> {
  if (message.type === "digest") {
    return {
      source: "devintern",
      version: WEBHOOK_SCHEMA_VERSION,
      type: "digest",
      digest: {
        since: new Date(message.since).toISOString(),
        until: new Date(message.until).toISOString(),
        total: message.total,
        countsByKind: message.countsByKind,
        top: message.top,
        dashboardUrl: message.dashboardUrl,
      },
    };
  }
  return {
    source: "devintern",
    version: WEBHOOK_SCHEMA_VERSION,
    type: "notification",
    event: message.event,
    notification: message.notification,
    ...(message.cause ? { cause: message.cause } : {}),
    dashboardUrl: message.dashboardUrl,
  };
}

/** Title and body for an OS notification. */
export function desktopContent(message: DeliveryMessage): { title: string; body: string } {
  if (message.type === "digest") {
    return {
      title: digestHeadline(message),
      body: message.countsByKind
        .map(({ kind, count }) => `${kindLabel(kind)}: ${count}`)
        .join(", "),
    };
  }
  const { notification } = message;
  const lines = [
    ...(message.cause && message.event !== "resolved" ? [message.cause] : []),
    ...(notification.repo ? [notification.repo] : []),
    message.dashboardUrl,
  ];
  const body = lines.join("\n");
  return {
    title: messageHeadline(message),
    body:
      body.length > MAX_DESKTOP_BODY_CHARS ? `${body.slice(0, MAX_DESKTOP_BODY_CHARS - 1)}…` : body,
  };
}

function appleScriptString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** argv for the platform notifier; null when the platform has none. */
export function desktopCommand(
  message: DeliveryMessage,
  platform: NodeJS.Platform,
): string[] | null {
  const { title, body } = desktopContent(message);
  const urgent = message.type === "notification" && message.notification.severity === "high";
  if (platform === "linux") {
    return [
      "notify-send",
      "--app-name=DevIntern",
      `--urgency=${urgent && message.event !== "resolved" ? "critical" : "normal"}`,
      "--",
      title,
      body,
    ];
  }
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      `display notification ${appleScriptString(body)} with title "DevIntern" subtitle ${appleScriptString(title)}`,
    ];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function channelName(channel: NotificationChannelConfig): string {
  return channel.type === "slack" ? "Slack" : channel.type;
}

async function postJson(
  channel: NotificationChannelConfig,
  body: string,
  headers: Record<string, string>,
  deps: ChannelDeps,
): Promise<void> {
  const url = channelUrl(channel, deps.env);
  if (!url) throw new PermanentDeliveryError(`${channel.urlEnv} is not set`);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // Network errors can echo the URL; report only their kind.
    throw new Error(`${channelName(channel)} request failed (${(error as Error).name})`);
  }
  if (response.ok) return;
  const message = `${channelName(channel)} answered HTTP ${response.status}`;
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new PermanentDeliveryError(message);
  }
  throw new Error(message);
}

async function sendOnce(
  channel: NotificationChannelConfig,
  message: DeliveryMessage,
  deps: ChannelDeps,
): Promise<void> {
  switch (channel.type) {
    case "desktop": {
      const argv = desktopCommand(message, deps.platform);
      if (!argv)
        throw new PermanentDeliveryError(
          `desktop notifications are not available on ${deps.platform}`,
        );
      const result = await deps.run(argv);
      if (result.exitCode !== 0) {
        throw new Error(
          `${argv[0]} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`,
        );
      }
      return;
    }
    case "slack":
      return postJson(channel, JSON.stringify(slackPayload(message)), {}, deps);
    case "webhook": {
      const body = JSON.stringify(webhookPayload(message));
      const secret = channel.secretEnv ? deps.env[channel.secretEnv] : undefined;
      if (channel.secretEnv && !secret) {
        throw new PermanentDeliveryError(`${channel.secretEnv} is not set`);
      }
      const headers: Record<string, string> = secret
        ? {
            "X-DevIntern-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          }
        : {};
      return postJson(channel, body, headers, deps);
    }
  }
}

/**
 * Send a message, retrying transient failures a bounded number of times.
 *
 * @throws The last error once the retry budget is spent, or a
 *   {@link PermanentDeliveryError} right away
 */
export async function sendToChannel(
  channel: NotificationChannelConfig,
  message: DeliveryMessage,
  deps: ChannelDeps,
): Promise<void> {
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await sendOnce(channel, message, deps);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (error instanceof PermanentDeliveryError || delay === undefined) throw error;
      await deps.sleep(delay);
    }
  }
}
