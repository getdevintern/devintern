/**
 * Anonymous product analytics for the CLI (PostHog via `posthog-node`).
 *
 * Fire-and-forget events with flush-on-exit. Never sends task keys, prompts,
 * repo names, paths, or credentials — only allowlisted enum/bool/number props
 * (see ALLOWED_PROP_KEYS). Opt out via DEVINTERN_TELEMETRY_DISABLED=1 or
 * `analytics.enabled: false` in .devintern-code/settings.json; the settings
 * opt-out is reported once as an anonymous `analytics_opt_out` event so the
 * funnel can exclude it going forward. The env kill-switch suppresses even
 * that acknowledgement, guaranteeing zero outbound analytics traffic.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PostHog } from "posthog-node";
import { resolveConfigDir } from "@devintern/utils";

// Injected at build time via --define; absent when running from source,
// which permanently disables analytics in dev builds.
declare const __POSTHOG_API_KEY__: string;
declare const __POSTHOG_HOST__: string;
declare const __VERSION__: string;

const CONFIG_DIR_NAME = ".devintern-code";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const CLI_VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0";

export type AnalyticsPropValue = string | boolean | number;

/** Curated event names — keep in sync with privacy copy. */
export type AnalyticsEvent =
  | "cli_run"
  | "task_run"
  | "setup_started"
  | "setup_completed"
  | "setup_failed"
  | "setup_declined"
  | "doctor_run"
  | "login_result"
  | "worker_init_started"
  | "worker_init_completed"
  | "worker_init_failed"
  | "worker_connect"
  | "worker_started"
  | "worker_task_run"
  | "analytics_opt_out";

export type WorkerTaskOutcome = "succeeded" | "failed" | "deferred" | "escalated" | "abandoned";

export type WorkerTaskTrigger = "task" | "scheduled" | "estimate" | "manual";
export type WorkerMode = "polling" | "relay" | "hybrid" | "scheduled";

/** Which entry point started guided setup. */
export type SetupSource = "init" | "rescue";
/** Sign-in result recorded as part of `devintern init`. */
export type SetupSignInStatus = "success" | "skipped" | "failed";
/** Allowlisted, low-cardinality reasons for setup/worker-init failures. */
export type SetupFailureReason =
  | "missing_tracker_credentials"
  | "scaffold_refused"
  | "tracker_setup_incomplete"
  | "tracker_not_pollable"
  | "workspace_error"
  | "workspace_tracker_mismatch";

/** Readiness check outcomes reported by doctor and the init summary. */
export type ReadinessCheckStatus = "ok" | "warn" | "fail";
/** A structural subset of readiness.ts's ReadinessCheck (no import cycle). */
export interface ReadinessCheckLike {
  id: string;
  status: ReadinessCheckStatus;
}

export type RelayConnectOutcome = "succeeded" | "partial" | "failed" | "skipped";
export type ServiceInstallOutcome =
  | "installed"
  | "updated"
  | "declined"
  | "failed"
  | "skipped"
  | "existing"
  | "unavailable";
export type GitHubAppOutcome = "connected" | "existing" | "skipped" | "unavailable";
export type LoginOutcome = "succeeded" | "failed";

/** Internal marker inherited only by task subprocesses launched by the worker. */
export const RUN_ORIGIN_ENV = "DEVINTERN_RUN_ORIGIN";
/** Keeps worker subprocesses on the workspace's stable anonymous identity. */
export const ANALYTICS_CONFIG_DIR_ENV = "DEVINTERN_ANALYTICS_CONFIG_DIR";

const ALLOWED_PROP_KEYS = new Set([
  "cli_version",
  "os",
  "arch",
  "ci",
  "tracker",
  "target",
  "run_mode",
  "task_count",
  "create_pr",
  "auto_review",
  "estimate",
  "sandbox",
  "outcome",
  "worker_trigger",
  "worker_mode",
  "source",
  "signed_in",
  "reason",
  "method",
  "relay_connect",
  "service_install",
  "github_app",
  "check_bun",
  "check_git",
  "check_agent",
  "check_tracker",
  "check_auth",
  "check_license",
]);

/** Doctor/init readiness check ids → allowlisted property names. */
const CHECK_PROP_BY_ID: Record<string, string> = {
  runtime: "check_bun",
  git: "check_git",
  agent: "check_agent",
  tracker: "check_tracker",
  auth: "check_auth",
  license: "check_license",
};

/** Minimal capture surface so tests can inject a mock without PostHog. */
export interface AnalyticsCapture {
  capture(payload: {
    distinctId: string;
    event: string;
    properties?: Record<string, AnalyticsPropValue>;
  }): void;
  flush?: () => Promise<void>;
}

let client: AnalyticsCapture | null | undefined;
/** Test override: `null` forces disabled capture; `undefined` uses the real lazy client. */
let captureForTests: AnalyticsCapture | null | undefined;
/** Set once the one-time opt-out event has been captured in this process. */
let optOutCaptureAttempted = false;

/**
 * Test override: `null` forces disabled capture; `undefined` restores the
 * real client. Restoring also clears the one-time opt-out gate so test
 * reordering or new tests that combine telemetry.json with
 * `analytics.enabled: false` cannot silently suppress the acknowledgement.
 * @internal
 */
export function setAnalyticsCaptureForTests(value: AnalyticsCapture | null | undefined): void {
  captureForTests = value;
  client = undefined;
  if (value === undefined) optOutCaptureAttempted = false;
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

function analyticsConfigDir(configDir?: string): string {
  return (
    configDir ??
    process.env[ANALYTICS_CONFIG_DIR_ENV] ??
    resolveConfigDir({ startDir: process.cwd(), configDirName: CONFIG_DIR_NAME })
  );
}

/**
 * Reads `analytics.enabled` from .devintern-code/settings.json. Returns
 * `undefined` when unset or unreadable so env/config absence means opt-in.
 */
export function readAnalyticsEnabledFromSettings(configDir?: string): boolean | undefined {
  try {
    const dir = analyticsConfigDir(configDir);
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
  const dir = analyticsConfigDir(configDir);
  const telemetryFile = join(dir, "telemetry.json");
  try {
    if (existsSync(telemetryFile)) {
      const parsed = JSON.parse(readFileSync(telemetryFile, "utf8")) as {
        anonymousId?: string;
      };
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

function getClient(): AnalyticsCapture | null {
  if (captureForTests !== undefined) return captureForTests;
  if (client !== undefined) return client;
  const apiKey = resolveApiKey();
  if (!apiKey) {
    client = null;
    return null;
  }
  const posthog = new PostHog(apiKey, {
    host: resolveHost(),
    disableGeoip: true,
    personProfiles: "never",
    // CLI semantics: the library default batches (flushAt: 20 / 10s interval),
    // which drops everything on any exit that does not flush. Send each capture
    // immediately in the background instead, like the raw-fetch sender it
    // replaced; explicit exits still flush for deterministic delivery.
    flushAt: 1,
    flushInterval: 0,
  });
  client = {
    capture: (payload) => posthog.capture(payload),
    flush: () => posthog.flush(),
  };
  return client;
}

/** True when this is the first run that created telemetry.json (for disclosure). */
export function isAnonymousIdNewlyCreated(configDir?: string): boolean {
  try {
    const dir = analyticsConfigDir(configDir);
    return !existsSync(join(dir, "telemetry.json"));
  } catch {
    return false;
  }
}

/**
 * When `analytics.enabled: false` appears in settings.json for the first time,
 * emit one anonymous `analytics_opt_out` event (before the enabled gate stops
 * further capture), flush it, and only then mark it in telemetry.json so it is
 * not re-sent on later runs. Marking before the send could permanently lose
 * the event on exit paths that never flush.
 * Only the durable settings opt-out is reported; the env kill-switch is not.
 * When the env kill-switch is set, no opt-out acknowledgement is sent either —
 * users who disable telemetry via DEVINTERN_TELEMETRY_DISABLED get zero
 * outbound analytics traffic.
 */
async function reportOptOutIfNewlyDisabled(configDir?: string): Promise<void> {
  try {
    if (readAnalyticsEnabledFromSettings(configDir) !== false) return;
    if (isTelemetryDisabledByEnv()) return;
    if (!resolveApiKey()) return;
    const dir = analyticsConfigDir(configDir);
    const telemetryFile = join(dir, "telemetry.json");
    if (!existsSync(telemetryFile)) return;
    let parsed: { anonymousId?: string; optOutReported?: boolean };
    try {
      parsed = JSON.parse(readFileSync(telemetryFile, "utf8")) as typeof parsed;
    } catch {
      return;
    }
    if (!parsed.anonymousId || parsed.optOutReported) return;
    // At most one capture per process: only the marker write can fail, and
    // retrying within the same run would duplicate the event.
    if (optOutCaptureAttempted) return;
    optOutCaptureAttempted = true;
    const capture = getClient();
    if (!capture) return;
    capture.capture({
      distinctId: parsed.anonymousId,
      event: "analytics_opt_out",
      properties: {},
    });
    await flushAnalytics();
    try {
      writeFileSync(
        telemetryFile,
        `${JSON.stringify({ ...parsed, optOutReported: true }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Read-only config dir: the event went out; it may re-send on later runs.
    }
  } catch {
    // Swallow — opt-out reporting must never break the CLI.
  }
}

/**
 * Capture a product event without blocking or ever throwing. The returned
 * promise resolves once the payload is handed to the queueing layer (or
 * immediately when analytics is disabled).
 */
export async function track(
  event: AnalyticsEvent,
  props?: Record<string, AnalyticsPropValue | undefined>,
  options: { configDir?: string } = {},
): Promise<void> {
  try {
    await reportOptOutIfNewlyDisabled(options.configDir);
    if (!isAnalyticsEnabled(options.configDir)) return;
    const capture = getClient();
    if (!capture) return;
    capture.capture({
      distinctId: getOrCreateAnonymousId(options.configDir),
      event,
      properties: scrubProps(props),
    });
  } catch {
    // Swallow — product use must not fail because of analytics.
  }
}

/** Allowlisted per-check props (check_bun, check_git, ...) from readiness checks. */
export function readinessCheckProps(
  checks: readonly ReadinessCheckLike[],
): Record<string, AnalyticsPropValue> {
  const props: Record<string, AnalyticsPropValue> = {};
  for (const check of checks) {
    const propKey = CHECK_PROP_BY_ID[check.id];
    if (!propKey) continue;
    props[propKey] = check.status;
  }
  return props;
}

/** Emit when the guided setup wizard opens (`devintern init` or first-run rescue). */
export function trackSetupStarted(source: SetupSource): void {
  void track("setup_started", { cli_version: CLI_VERSION, os: process.platform, source });
}

/** Emit after the wizard scaffolded config and ran the readiness summary. */
export function trackSetupCompleted(props: {
  tracker?: string;
  signedIn: SetupSignInStatus;
  checks?: readonly ReadinessCheckLike[];
}): void {
  void track("setup_completed", {
    cli_version: CLI_VERSION,
    os: process.platform,
    tracker: props.tracker,
    signed_in: props.signedIn,
    ...readinessCheckProps(props.checks ?? []),
  });
}

/**
 * Emit when the first-run rescue offer is declined (setup never started).
 * Returns the capture promise so flush-then-exit sites can await it and
 * guarantee the event is queued before `flushAnalytics` runs.
 */
export function trackSetupDeclined(reason: SetupFailureReason): Promise<void> {
  return track("setup_declined", { cli_version: CLI_VERSION, os: process.platform, reason });
}

/**
 * Emit when guided setup ran but ended without usable configuration.
 * Returns the capture promise so flush-then-exit sites can await it and
 * guarantee the event is queued before `flushAnalytics` runs.
 */
export function trackSetupFailed(reason: SetupFailureReason): Promise<void> {
  return track("setup_failed", { cli_version: CLI_VERSION, os: process.platform, reason });
}

/**
 * Emit the doctor (or init readiness summary) outcome and per-check statuses.
 * Returns the capture promise so flush-then-exit sites can await it and
 * guarantee the event is queued before `flushAnalytics` runs.
 */
export function trackDoctorRun(props: {
  checks: readonly ReadinessCheckLike[];
  hasFailures: boolean;
  hasWarnings: boolean;
}): Promise<void> {
  return track("doctor_run", {
    cli_version: CLI_VERSION,
    os: process.platform,
    outcome: props.hasFailures ? "failures" : props.hasWarnings ? "warnings" : "ready",
    ...readinessCheckProps(props.checks),
  });
}

/**
 * Emit the outcome of `devintern login` (method is a provider enum, not PII).
 * Returns the capture promise so flush-then-exit sites can await it and
 * guarantee the event is queued before `flushAnalytics` runs.
 */
export function trackLoginResult(props: { outcome: LoginOutcome; method?: string }): Promise<void> {
  return track("login_result", {
    cli_version: CLI_VERSION,
    os: process.platform,
    outcome: props.outcome,
    method: props.method,
  });
}

/**
 * Emit one outcome event for a completed interactive task run (never for
 * worker subprocesses, whose terminal outcomes go to `worker_task_run`).
 * Returns the capture promise so flush-then-exit sites can await it and
 * guarantee the event is queued before `flushAnalytics` runs.
 */
export function trackInteractiveTaskRun(props: {
  tracker: string;
  outcome: "succeeded" | "partial" | "failed";
  taskCount: number;
  runMode: "tasks" | "query";
}): Promise<void> {
  return track("task_run", {
    cli_version: CLI_VERSION,
    os: process.platform,
    tracker: props.tracker,
    outcome: props.outcome,
    task_count: props.taskCount,
    run_mode: props.runMode,
  });
}

/** Emit when `devintern worker init` starts. */
export function trackWorkerInitStarted(): void {
  void track("worker_init_started", { cli_version: CLI_VERSION, os: process.platform });
}

/** Emit when the worker wizard finishes, with per-step outcome categories. */
export function trackWorkerInitCompleted(props: {
  tracker: string;
  relayConnect: RelayConnectOutcome;
  serviceInstall: ServiceInstallOutcome;
  githubApp: GitHubAppOutcome;
}): void {
  void track("worker_init_completed", {
    cli_version: CLI_VERSION,
    os: process.platform,
    tracker: props.tracker,
    relay_connect: props.relayConnect,
    service_install: props.serviceInstall,
    github_app: props.githubApp,
  });
}

/** Emit when `devintern worker init` aborts before completing. */
export function trackWorkerInitFailed(reason: SetupFailureReason): void {
  void track("worker_init_failed", { cli_version: CLI_VERSION, os: process.platform, reason });
}

/**
 * Emit the outcome of a standalone `devintern worker connect <target>`.
 * Returns the capture promise so flush-then-exit sites can await it and
 * guarantee the event is queued before `flushAnalytics` runs.
 */
export function trackWorkerConnect(props: {
  target: string;
  outcome: "succeeded" | "failed";
}): Promise<void> {
  return track("worker_connect", {
    cli_version: CLI_VERSION,
    os: process.platform,
    target: props.target,
    outcome: props.outcome,
  });
}

/**
 * Emit one high-signal event when a worker task reaches a terminal outcome.
 * Manual CLI runs are ignored, and the payload contains no task/repo identity.
 *
 * @returns True when this process was launched for a worker task.
 */
export function trackWorkerTaskRun(
  outcome: WorkerTaskOutcome,
  props: {
    cliVersion: string;
    tracker: string;
  },
  env: Record<string, string | undefined> = process.env,
): boolean {
  const runOrigin = env[RUN_ORIGIN_ENV];
  const workerTrigger: WorkerTaskTrigger | undefined =
    runOrigin === "worker" || runOrigin === "error_monitor"
      ? "task"
      : runOrigin === "scheduled"
        ? "scheduled"
        : runOrigin === "estimate"
          ? "estimate"
          : runOrigin === "manual"
            ? "manual"
            : undefined;
  if (!workerTrigger) return false;

  void track("worker_task_run", {
    cli_version: props.cliVersion,
    tracker: props.tracker,
    outcome,
    worker_trigger: workerTrigger,
  });
  return true;
}

/** Collapse configured acquirers into a stable, low-cardinality worker mode. */
export function resolveWorkerMode(acquirerNames: readonly string[]): WorkerMode {
  const hasRelay = acquirerNames.includes("relay");
  const hasPolling = acquirerNames.some((name) => name.startsWith("poll:"));
  if (hasRelay && hasPolling) return "hybrid";
  if (hasRelay) return "relay";
  if (hasPolling) return "polling";
  return "scheduled";
}

/** Emit once after a worker has successfully started all configured sources. */
export function trackWorkerStarted(props: {
  cliVersion: string;
  tracker: string;
  acquirerNames: readonly string[];
  configDir?: string;
}): void {
  void track(
    "worker_started",
    {
      cli_version: props.cliVersion,
      tracker: props.tracker,
      worker_mode: resolveWorkerMode(props.acquirerNames),
    },
    { configDir: props.configDir },
  );
}

/**
 * Flush queued events so short-lived runs do not drop them before exit.
 * Bounded by `timeoutMs`; never throws and never destroys the client, so the
 * long-lived worker daemon can keep capturing afterwards.
 */
export async function flushAnalytics(timeoutMs = 3000): Promise<void> {
  try {
    // Yield one microtask so fire-and-forget `track*()` calls made just before
    // flushing finish enqueueing their capture. posthog-node defers its queue
    // snapshot, so this is defense in depth for void call sites; deterministic
    // sites await the track* promise instead.
    await Promise.resolve();
    const capture = getClient();
    if (!capture?.flush) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        capture.flush(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // ignore
  }
}
