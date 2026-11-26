/**
 * `[notifications]` delivery settings from `workspace.toml`.
 *
 * ```toml
 * [notifications]
 * dashboard_url = "https://box.tailnet.ts.net"   # optional link base
 * timezone = "Europe/Berlin"                      # optional, for digest_time
 *
 * [notifications.slack]
 * url_env = "SLACK_WEBHOOK_URL"                   # URL lives in the workspace .env
 * min_severity = "high"
 * digest_time = "09:00"
 * ```
 *
 * One table per channel type (`desktop`, `slack`, `webhook`); a present table
 * enables the channel unless it sets `enabled = false`. No table, no delivery.
 * Secrets (the Slack webhook URL, the webhook signing secret) are referenced
 * by environment variable name, following the workspace convention that
 * credentials live in `.env` files, never in `workspace.toml`.
 */

import {
  asTable,
  readOptionalBoolean,
  readOptionalInteger,
  readString,
  readStringList,
} from "../../workspace/config-readers";
import { isValidTimeZone } from "../../worker/schedule";
import { NOTIFICATION_KINDS, isNotificationKind, isNotificationSeverity } from "../types";
import type { NotificationKind, NotificationSeverity } from "../types";

export const NOTIFICATION_CHANNEL_TYPES = ["desktop", "slack", "webhook"] as const;

export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

/** Default rate-limit window per group key (1 hour). */
export const DEFAULT_RATE_LIMIT_MINUTES = 60;
/** Default env var holding the Slack incoming webhook URL. */
export const DEFAULT_SLACK_URL_ENV = "SLACK_WEBHOOK_URL";
/** Default env var holding the generic webhook URL (when `url` is not set). */
export const DEFAULT_WEBHOOK_URL_ENV = "DEVINTERN_NOTIFICATION_WEBHOOK_URL";

/** A daily local time (`HH:MM`). */
export interface DailyTime {
  spec: string;
  /** Minutes after local midnight. */
  minutes: number;
}

/** One enabled delivery channel. */
export interface NotificationChannelConfig {
  type: NotificationChannelType;
  /** Lowest severity delivered right away (default `high`). */
  minSeverity: NotificationSeverity;
  /** Only these kinds (all kinds when absent). */
  kinds?: NotificationKind[];
  /** Never these kinds. */
  excludeKinds: NotificationKind[];
  /** At most one message per group key within this window. */
  rateLimitMinutes: number;
  /** Also send a message when a delivered notification resolves. */
  notifyResolved: boolean;
  /** Send a daily digest at this local time. */
  digestTime?: DailyTime;
  /** Inline endpoint (webhook only; never Slack). */
  url?: string;
  /** Env var holding the endpoint URL (Slack, webhook). */
  urlEnv?: string;
  /** Env var holding an HMAC-SHA256 signing secret (webhook only). */
  secretEnv?: string;
}

/** Parsed `[notifications]` section. */
export interface NotificationsSettings {
  /** Base for dashboard links; derived from the dashboard config when absent. */
  dashboardUrl?: string;
  /** IANA timezone for `digest_time`; machine local time when absent. */
  timezone?: string;
  /** Enabled channels, in `desktop`, `slack`, `webhook` order. */
  channels: NotificationChannelConfig[];
}

const TOP_KEYS = new Set(["dashboard_url", "timezone", ...NOTIFICATION_CHANNEL_TYPES]);
const COMMON_CHANNEL_KEYS = [
  "enabled",
  "min_severity",
  "kinds",
  "exclude_kinds",
  "rate_limit_minutes",
  "notify_resolved",
  "digest_time",
];
const CHANNEL_KEYS: Record<NotificationChannelType, Set<string>> = {
  desktop: new Set(COMMON_CHANNEL_KEYS),
  slack: new Set([...COMMON_CHANNEL_KEYS, "url_env"]),
  webhook: new Set([...COMMON_CHANNEL_KEYS, "url", "url_env", "secret_env"]),
};
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAILY_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** Empty settings: nothing is delivered. */
export function emptyNotificationsSettings(): NotificationsSettings {
  return { channels: [] };
}

/** Parse `"HH:MM"`; null when malformed. */
export function parseDailyTime(raw: string): DailyTime | null {
  const spec = raw.trim();
  const match = DAILY_TIME_PATTERN.exec(spec);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { spec, minutes: hour * 60 + minute };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function readKinds(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): NotificationKind[] {
  const kinds: NotificationKind[] = [];
  for (const entry of readStringList(table, key, label, errors)) {
    if (isNotificationKind(entry)) {
      kinds.push(entry);
    } else {
      errors.push(
        `${label}.${key} has unknown kind "${entry}"; known kinds: ${NOTIFICATION_KINDS.join(", ")}.`,
      );
    }
  }
  return kinds;
}

function readEnvName(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string | undefined {
  const value = readString(table, key, label, errors);
  if (value && !ENV_NAME_PATTERN.test(value)) {
    errors.push(`${label}.${key} must be an environment variable name (e.g. "SLACK_WEBHOOK_URL").`);
    return undefined;
  }
  return value;
}

function parseChannel(
  type: NotificationChannelType,
  raw: unknown,
  errors: string[],
): NotificationChannelConfig | null {
  const label = `[notifications.${type}]`;
  const table = asTable(raw, label, errors);
  for (const key of Object.keys(table)) {
    if (CHANNEL_KEYS[type].has(key)) continue;
    if (type === "slack" && key === "url") {
      errors.push(
        `${label}.url is not supported: keep the Slack webhook URL out of workspace.toml. ` +
          `Put it in the workspace .env (e.g. ${DEFAULT_SLACK_URL_ENV}=…) and set url_env to its name.`,
      );
      continue;
    }
    errors.push(
      `${label}.${key} is not supported; known keys: ${[...CHANNEL_KEYS[type]].join(", ")}.`,
    );
  }
  if (readOptionalBoolean(table, "enabled", label, errors) === false) return null;

  const severityRaw = readString(table, "min_severity", label, errors);
  let minSeverity: NotificationSeverity = "high";
  if (severityRaw !== undefined) {
    if (isNotificationSeverity(severityRaw)) minSeverity = severityRaw;
    else errors.push(`${label}.min_severity must be "high" or "normal".`);
  }
  const kinds = table.kinds === undefined ? undefined : readKinds(table, "kinds", label, errors);
  const excludeKinds = readKinds(table, "exclude_kinds", label, errors);
  const rateLimitMinutes =
    readOptionalInteger(table, "rate_limit_minutes", label, errors, {
      min: 0,
      message: `${label}.rate_limit_minutes must be a non-negative integer (minutes).`,
    }) ?? DEFAULT_RATE_LIMIT_MINUTES;
  const notifyResolved = readOptionalBoolean(table, "notify_resolved", label, errors) ?? false;
  const digestRaw = readString(table, "digest_time", label, errors);
  let digestTime: DailyTime | undefined;
  if (digestRaw !== undefined) {
    const parsed = parseDailyTime(digestRaw);
    if (parsed) digestTime = parsed;
    else errors.push(`${label}.digest_time must be a local time "HH:MM", e.g. "09:00".`);
  }

  const channel: NotificationChannelConfig = {
    type,
    minSeverity,
    ...(kinds !== undefined ? { kinds } : {}),
    excludeKinds,
    rateLimitMinutes,
    notifyResolved,
    ...(digestTime ? { digestTime } : {}),
  };

  if (type === "slack") {
    channel.urlEnv = readEnvName(table, "url_env", label, errors) ?? DEFAULT_SLACK_URL_ENV;
  } else if (type === "webhook") {
    const url = readString(table, "url", label, errors);
    const urlEnv = readEnvName(table, "url_env", label, errors);
    if (url && urlEnv) {
      errors.push(`${label} sets both url and url_env; use one.`);
    } else if (url) {
      const parsed = httpUrl(url);
      if (parsed) channel.url = parsed;
      else errors.push(`${label}.url must be an http(s) URL.`);
    } else {
      channel.urlEnv = urlEnv ?? DEFAULT_WEBHOOK_URL_ENV;
    }
    const secretEnv = readEnvName(table, "secret_env", label, errors);
    if (secretEnv) channel.secretEnv = secretEnv;
  }
  return channel;
}

/**
 * Parse the `[notifications]` table, collecting problems into `errors`.
 *
 * @param raw - The raw `notifications` value of the TOML document
 * @param errors - Problem sink shared with the rest of the workspace parser
 */
export function parseNotificationsSection(raw: unknown, errors: string[]): NotificationsSettings {
  const table = asTable(raw, "[notifications]", errors);
  for (const key of Object.keys(table)) {
    if (!TOP_KEYS.has(key)) {
      errors.push(
        `[notifications].${key} is not supported; known keys: ${[...TOP_KEYS].join(", ")}.`,
      );
    }
  }
  const settings = emptyNotificationsSettings();
  const dashboardUrl = readString(table, "dashboard_url", "[notifications]", errors);
  if (dashboardUrl !== undefined) {
    const parsed = httpUrl(dashboardUrl);
    if (parsed) settings.dashboardUrl = parsed.replace(/\/+$/, "");
    else errors.push("[notifications].dashboard_url must be an http(s) URL.");
  }
  const timezone = readString(table, "timezone", "[notifications]", errors);
  if (timezone !== undefined) {
    if (isValidTimeZone(timezone)) settings.timezone = timezone;
    else errors.push(`[notifications].timezone "${timezone}" is not a valid IANA timezone.`);
  }
  for (const type of NOTIFICATION_CHANNEL_TYPES) {
    if (table[type] === undefined) continue;
    const channel = parseChannel(type, table[type], errors);
    if (channel) settings.channels.push(channel);
  }
  return settings;
}
