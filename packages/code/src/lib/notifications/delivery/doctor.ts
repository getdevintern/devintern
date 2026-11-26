/**
 * `devintern worker doctor` row for notification delivery: which channels are
 * configured and whether each can send from this host, plus an optional test
 * message (`--test-notifications`).
 */

import type { ReadinessCheck } from "../../observability/readiness";
import type { WorkspaceConfig } from "../../workspace/config-types";
import { channelAvailability, defaultChannelDeps, sendToChannel } from "./channels";
import type { ChannelDeps } from "./channels";
import type { NotificationChannelConfig } from "./config";
import { buildNotificationMessage, resolveDashboardBaseUrl, testNotification } from "./message";

export interface NotificationDoctorOptions {
  /** Send a test message through every available channel. */
  test: boolean;
  /** Skip network channels when testing. */
  offline: boolean;
  now?: number;
}

function describeChannel(channel: NotificationChannelConfig): string {
  const parts = [channel.minSeverity === "high" ? "high severity" : "all severities"];
  if (channel.kinds) parts.push(`kinds ${channel.kinds.join(", ") || "(none)"}`);
  if (channel.excludeKinds.length > 0) parts.push(`except ${channel.excludeKinds.join(", ")}`);
  if (channel.digestTime) parts.push(`digest ${channel.digestTime.spec}`);
  if (channel.notifyResolved) parts.push("resolve messages");
  parts.push(
    channel.rateLimitMinutes > 0
      ? `max 1 per ${channel.rateLimitMinutes} min per cause`
      : "no rate limit",
  );
  return parts.join(", ");
}

/**
 * Build the notification delivery check.
 *
 * @param config - Parsed workspace config
 * @param deps - Channel side effects (env, fetch, spawn)
 * @param options - Test-send and offline flags
 */
export async function notificationDeliveryCheck(
  config: Pick<WorkspaceConfig, "workspace" | "dashboard" | "notifications">,
  deps: ChannelDeps,
  options: NotificationDoctorOptions,
): Promise<ReadinessCheck> {
  const channels = config.notifications?.channels ?? [];
  if (channels.length === 0) {
    return {
      id: "notifications",
      label: "Notification delivery",
      status: "ok",
      detail: options.test
        ? "no channels configured, nothing to test (add [notifications.<channel>] to workspace.toml)"
        : "no channels configured (dashboard inbox only)",
    };
  }
  const base = resolveDashboardBaseUrl(config, deps.env);
  const items: string[] = [];
  let unavailable = 0;
  let testFailures = 0;
  for (const channel of channels) {
    const availability = channelAvailability(channel, deps);
    const icon = availability.available ? "✓" : "✗";
    items.push(`${icon} ${channel.type}: ${availability.detail}; ${describeChannel(channel)}`);
    if (!availability.available) {
      unavailable++;
      continue;
    }
    if (!options.test) continue;
    if (options.offline && channel.type !== "desktop") {
      items.push(`  test skipped (--offline)`);
      continue;
    }
    try {
      await sendToChannel(
        channel,
        buildNotificationMessage(testNotification(options.now ?? Date.now()), "test", base),
        deps,
      );
      items.push("  test message sent");
    } catch (error) {
      testFailures++;
      items.push(`  test failed: ${(error as Error).message}`);
    }
  }
  const names = channels.map((channel) => channel.type).join(", ");
  if (testFailures > 0) {
    return {
      id: "notifications",
      label: "Notification delivery",
      status: "fail",
      detail: `${names}: ${testFailures} test message(s) failed`,
      hint: "Check the endpoint URL in the workspace .env and that this host can reach it",
      items,
    };
  }
  if (unavailable > 0) {
    return {
      id: "notifications",
      label: "Notification delivery",
      status: "warn",
      detail: `${names}: ${unavailable} channel(s) cannot send from this host`,
      hint: "Set the missing variables in the workspace .env, or remove the channel from [notifications]",
      items,
    };
  }
  return {
    id: "notifications",
    label: "Notification delivery",
    status: "ok",
    detail: options.test
      ? `${names}; links open ${base}`
      : `${names}; links open ${base} (send a test with --test-notifications)`,
    items,
  };
}

/**
 * The doctor row over the workspace env; a check that cannot run is a
 * warning, never an exception.
 */
export async function notificationDoctorCheck(
  config: Pick<WorkspaceConfig, "workspace" | "dashboard" | "notifications">,
  env: Record<string, string | undefined>,
  options: { testNotifications?: boolean; offline?: boolean },
  deps: Omit<ChannelDeps, "env"> = defaultChannelDeps(),
): Promise<ReadinessCheck> {
  try {
    return await notificationDeliveryCheck(
      config,
      { ...deps, env },
      { test: options.testNotifications === true, offline: options.offline === true },
    );
  } catch (error) {
    return {
      id: "notifications",
      label: "Notification delivery",
      status: "warn",
      detail: (error as Error).message,
      hint: "Check the [notifications] section of workspace.toml",
    };
  }
}
