/**
 * Anonymous product analytics for pm-desktop (PostHog).
 *
 * On by default; gated by settings.analyticsEnabled. Never sends prompts,
 * ticket text, project paths, or credentials — only allowlisted enum/bool props.
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { isAnalyticsEnabled, readSettings, updateSettings } from "./settings.ts";

/** Curated event names — keep in sync with privacy copy. */
export type AnalyticsEvent =
  | "app_opened"
  | "project_opened"
  | "project_configured"
  | "story_generated"
  | "story_edited"
  | "story_decomposed"
  | "task_created"
  | "analytics_opt_out"
  | "update_available"
  | "update_downloaded"
  | "update_applied"
  | "update_failed";

const ALLOWED_PROP_KEYS = new Set([
  "app_version",
  "os",
  "configured",
  "tracker",
  "harness",
  "source_type",
  "ok",
  "epic_linked",
  "labels_applied",
  "attachment_count",
  "has_images",
  "attachments_uploaded",
  "attachment_errors",
  "update_version",
]);

export type AnalyticsPropValue = string | boolean | number;

/** Minimal capture surface so tests can inject a mock without PostHog. */
export interface AnalyticsCapture {
  capture(payload: {
    distinctId: string;
    event: string;
    properties?: Record<string, AnalyticsPropValue>;
  }): void;
  shutdown(): Promise<void>;
}

let client: AnalyticsCapture | null | undefined;
let installIdCache: string | undefined;
/** Test override: `null` forces disabled capture; `undefined` uses real/lazy client. */
let captureForTests: AnalyticsCapture | null | undefined;

/** @internal */
export function setAnalyticsCaptureForTests(value: AnalyticsCapture | null | undefined): void {
  captureForTests = value;
  client = undefined;
  installIdCache = undefined;
}

function resolveApiKey(): string {
  return process.env.POSTHOG_API_KEY?.trim() ?? "";
}

function resolveHost(): string {
  const host = process.env.POSTHOG_HOST?.trim();
  return host && host.length > 0 ? host : "https://us.i.posthog.com";
}

function getClient(): AnalyticsCapture | null {
  if (captureForTests !== undefined) {
    return captureForTests;
  }
  if (client !== undefined) {
    return client;
  }
  const apiKey = resolveApiKey();
  if (!apiKey) {
    client = null;
    return null;
  }
  const posthog = new PostHog(apiKey, {
    host: resolveHost(),
    disableGeoip: true,
    personProfiles: "never",
  });
  client = {
    capture: (payload) => posthog.capture(payload),
    shutdown: () => posthog.shutdown(),
  };
  return client;
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

async function getOrCreateInstallId(): Promise<string> {
  if (installIdCache) return installIdCache;
  const settings = await readSettings();
  if (settings.installId) {
    installIdCache = settings.installId;
    return settings.installId;
  }
  const id = randomUUID();
  await updateSettings({ installId: id });
  installIdCache = id;
  return id;
}

/**
 * Capture a product event. Never throws — analytics must not break IPC/UI.
 */
export async function track(
  event: AnalyticsEvent,
  props?: Record<string, AnalyticsPropValue | undefined>,
): Promise<void> {
  try {
    const settings = await readSettings();
    if (!isAnalyticsEnabled(settings)) return;

    const capture = getClient();
    if (!capture) return;

    const distinctId = await getOrCreateInstallId();
    capture.capture({
      distinctId,
      event,
      properties: scrubProps(props),
    });
  } catch {
    // Swallow — product use must not fail because of analytics.
  }
}

/** Flush pending events on quit. Safe to call when analytics is unused. */
export async function shutdownAnalytics(): Promise<void> {
  try {
    const capture = getClient();
    if (capture) await capture.shutdown();
  } catch {
    // ignore
  }
}

/** Props for the app_opened event. */
export function appOpenedProps(appVersion: string): Record<string, AnalyticsPropValue> {
  return {
    app_version: appVersion,
    os: process.platform,
  };
}

/**
 * Persist opt-out / opt-in. Sends `analytics_opt_out` once when disabling
 * while still enabled, then stops further capture.
 */
export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  const settings = await readSettings();
  const currentlyEnabled = isAnalyticsEnabled(settings);

  if (!enabled && currentlyEnabled) {
    // Capture before flipping the flag so this event is still sent.
    await track("analytics_opt_out");
  }

  await updateSettings({ analyticsEnabled: enabled });
}

export async function getAnalyticsEnabled(): Promise<boolean> {
  return isAnalyticsEnabled(await readSettings());
}
