/**
 * Anonymous product analytics for the CLI (PostHog).
 *
 * Sends one fire-and-forget event per run. Never sends task keys, prompts,
 * repo names, paths, or credentials — only allowlisted enum/bool/number props
 * (see ALLOWED_PROP_KEYS). Opt out via DEVINTERN_TELEMETRY_DISABLED=1 or
 * `analytics.enabled: false` in .devintern-code/settings.json.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "@devintern/utils";

// Injected at build time via --define; absent when running from source,
// which permanently disables analytics in dev builds.
declare const __POSTHOG_API_KEY__: string;
declare const __POSTHOG_HOST__: string;

const CONFIG_DIR_NAME = ".devintern-code";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export type AnalyticsPropValue = string | boolean | number;

/** Curated event names — keep in sync with privacy copy. */
export type AnalyticsEvent = "cli_run" | "analytics_opt_out";

const ALLOWED_PROP_KEYS = new Set([
  "cli_version",
  "os",
  "arch",
  "ci",
  "tracker",
  "run_mode",
  "task_count",
  "create_pr",
  "auto_review",
  "estimate",
  "sandbox",
]);

/** Minimal send surface so tests can inject a mock without network access. */
export interface AnalyticsSender {
  send(payload: {
    api_key: string;
    event: string;
    distinct_id: string;
    properties: Record<string, AnalyticsPropValue>;
    timestamp: string;
  }): Promise<void>;
}

type RealSender = AnalyticsSender & { inflight: Promise<void>[] };

let senderForTests: AnalyticsSender | null | undefined;
let realSender: RealSender | undefined;

/** @internal Test override: `null` forces disabled capture; `undefined` restores the real sender. */
export function setAnalyticsSenderForTests(value: AnalyticsSender | null | undefined): void {
  senderForTests = value;
  realSender = undefined;
}

export function resolveApiKey(): string {
  const baked = typeof __POSTHOG_API_KEY__ === "string" ? __POSTHOG_API_KEY__.trim() : "";
  return baked || process.env.POSTHOG_API_KEY?.trim() || "";
}

function resolveHost(): string {
  if (typeof __POSTHOG_HOST__ === "string" && __POSTHOG_HOST__.trim().length > 0) {
    return __POSTHOG_HOST__.trim();
  }
  return process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
}

/**
 * Truthy env values disable telemetry; the variable only needs to exist for
 * common CI conventions like `DEVINTERN_TELEMETRY_DISABLED=` to work too.
 */
export function isTelemetryDisabledByEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.DEVINTERN_TELEMETRY_DISABLED;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "" || value === "0" ? false : true;
}

interface TelemetrySettingsShape {
  analytics?: { enabled?: boolean };
}

/**
 * Reads `analytics.enabled` from .devintern-code/settings.json. Returns
 * `undefined` when unset or unreadable so env/config absence means opt-in.
 */
export function readAnalyticsEnabledFromSettings(configDir?: string): boolean | undefined {
  try {
    const dir =
      configDir ?? resolveConfigDir({ startDir: process.cwd(), configDirName: CONFIG_DIR_NAME });
    const settingsPath = join(dir, "settings.json");
    if (!existsSync(settingsPath)) return undefined;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as TelemetrySettingsShape;
    return parsed.analytics?.enabled;
  } catch {
    return undefined;
  }
}

export function isAnalyticsEnabled(configDir?: string): boolean {
  if (!resolveApiKey()) return false;
  if (isTelemetryDisabledByEnv()) return false;
  if (readAnalyticsEnabledFromSettings(configDir) === false) return false;
  return true;
}

/** Scrub to allowlisted keys; drop nullish values. */
export function scrubProps(
  props: Record<string, AnalyticsPropValue | undefined> | undefined,
): Record<string, AnalyticsPropValue> {
  if (!props) return {};
  const out: Record<string, AnalyticsPropValue> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED_PROP_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function getOrCreateAnonymousId(configDir?: string): string {
  const dir =
    configDir ?? resolveConfigDir({ startDir: process.cwd(), configDirName: CONFIG_DIR_NAME });
  const telemetryFile = join(dir, "telemetry.json");
  try {
    if (existsSync(telemetryFile)) {
      const parsed = JSON.parse(readFileSync(telemetryFile, "utf8")) as { anonymousId?: string };
      if (parsed.anonymousId) return parsed.anonymousId;
    }
  } catch {
    // Corrupt file — fall through and regenerate.
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(telemetryFile, `${JSON.stringify({ anonymousId: id }, null, 2)}\n`, "utf8");
  } catch {
    // Read-only config dir — use an ephemeral id for this run only.
  }
  return id;
}

function getSender(): AnalyticsSender | null {
  if (senderForTests !== undefined) return senderForTests ?? null;
  if (!realSender) {
    realSender = {
      inflight: [],
      async send(payload) {
        const request = fetch(`${resolveHost()}/i/v0/e/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).then(
          () => {},
          () => {},
        );
        this.inflight.push(request);
        await request;
      },
    };
  }
  return realSender;
}

/** True when this is the first run that created telemetry.json (for disclosure). */
export function isAnonymousIdNewlyCreated(configDir?: string): boolean {
  try {
    const dir =
      configDir ?? resolveConfigDir({ startDir: process.cwd(), configDirName: CONFIG_DIR_NAME });
    return !existsSync(join(dir, "telemetry.json"));
  } catch {
    return false;
  }
}

/**
 * Capture a product event without blocking or ever throwing. The returned
 * promise resolves once the payload is handed to the network layer (or
 * immediately when analytics is disabled).
 */
export async function track(
  event: AnalyticsEvent,
  props?: Record<string, AnalyticsPropValue | undefined>,
  options: { configDir?: string } = {},
): Promise<void> {
  try {
    if (!isAnalyticsEnabled(options.configDir)) return;
    const sender = getSender();
    if (!sender) return;
    await sender.send({
      api_key: resolveApiKey(),
      event,
      distinct_id: getOrCreateAnonymousId(options.configDir),
      properties: scrubProps(props),
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Swallow — product use must not fail because of analytics.
  }
}

/**
 * Await pending sends so short-lived runs do not drop their event before
 * exit. Bounded by `timeoutMs`; never throws.
 */
export async function flushAnalytics(timeoutMs = 1500): Promise<void> {
  try {
    const sender = getSender();
    if (!sender || !("inflight" in sender)) return;
    await Promise.race([
      Promise.all((sender as RealSender).inflight.splice(0)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // ignore
  }
}
