/**
 * License check module for devintern CLI tools.
 *
 * Resolves entitlement in this order:
 *   1. LICENSE_KEY env / explicit arg → Polar customer-portal validation.
 *   2. Authenticated Supabase user   → devintern.com entitlement endpoint
 *                                       (covers Supporter and Team/Business
 *                                       automation licenses).
 *
 * When the check server is unreachable (network error, 5xx), a cached
 * last-known-good entitlement is honored for a 72-hour grace window so an
 * outage on our side never blocks a paying customer's automation. Definitive
 * denials (invalid key, not entitled, 401) clear the cache and fail
 * immediately.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAuthenticatedUser } from "@devintern/auth";
import type { AuthenticatedUser, SupabaseAuthConfig } from "@devintern/auth";
import { fetchWithRetry } from "@devintern/utils";
import {
  getAllowedBenefits,
  isAutomationSource,
  validatePolarLicenseKey,
} from "@getdevintern/license-policy";
import type { EntitlementSource } from "@getdevintern/license-policy";

export {
  type EntitlementSource,
  type ValidatedPolarKey,
  POLAR_ORGANIZATION_ID,
  getAllowedBenefitIds,
  getAllowedBenefits,
  isAutomationSource,
  validatePolarLicenseKey,
} from "@getdevintern/license-policy";

const DEFAULT_API_BASE = "https://devintern.com";

/** The Worker Pilot sign-in and license docs (docs/code/worker.md). */
export const WORKER_PILOT_DOCS_URL =
  "https://devintern.com/docs/code/worker#worker-pilot-and-licenses";

/**
 * What a worker with no `LICENSE_KEY` and no session needs: sign in to start
 * the Worker Pilot (the interactive form, which asks for the method), or set
 * an existing license key instead. The worker start path, `worker doctor`,
 * and `worker service` all show this text.
 *
 * @param loginCommand - Sign-in command (may include `--workspace <path>`).
 * @returns The message, ending with the docs link.
 */
export function workerPilotSignInMessage(loginCommand: string = "devintern worker login"): string {
  return (
    `Sign in to start your free 14-day Worker Pilot: \`${loginCommand}\` (no card required). ` +
    "Already have a Supporter, Team, or Business license? Set LICENSE_KEY in the workspace .env instead. " +
    `See ${WORKER_PILOT_DOCS_URL}`
  );
}

/**
 * A signed-in account with no automation license and no Worker Pilot left.
 * Worded so {@link LicenseCheckResult} callers keep treating it as before
 * (a retryable denial for the worker service).
 */
function workerPilotOverMessage(): string {
  return (
    "Your free Worker Pilot is over and this account has no automation license. " +
    "Set LICENSE_KEY in the workspace .env to a Supporter, Team, or Business license key from " +
    `https://devintern.com/account (buy one at https://devintern.com/pricing). See ${WORKER_PILOT_DOCS_URL}`
  );
}

/** How long a cached last-known-good entitlement is honored when the license server is unreachable. */
const GRACE_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface LicenseCheckResult {
  valid: boolean;
  source: "license-key" | "entitlement" | "trial" | "grace" | "none";
  message: string;
  /** When source is "entitlement" (or "grace"), indicates the underlying SKU type */
  entitlementSource?: EntitlementSource;
  /** Server-authoritative worker-trial expiry. */
  trialEndsAt?: string;
  /** True when the trial is eligible but has not been activated yet. */
  trialAvailable?: boolean;
  /** When source is "grace": the end of the 72-hour offline window (ISO 8601). */
  graceEndsAt?: string;
  /**
   * True when nothing is wrong except that nobody is signed in: no
   * `LICENSE_KEY`, no session, and the check allows a Worker Pilot. Signing
   * in is the next step, not a fix for a broken setup.
   */
  signInRequired?: boolean;
  /**
   * True when no license was checked at all: `DEVINTERN_SKIP_LICENSE_CHECK=1`
   * on a non-release build. `source` stays `license-key` for older callers.
   */
  skipped?: boolean;
}

export interface LicenseCheckOptions {
  /** Product key, e.g. "devintern/pm" or "devintern/code" */
  productKey: string;
  /** Explicit license key to validate (falls back to LICENSE_KEY env var) */
  licenseKey?: string;
  /** Supabase auth config for user-based checks */
  supabaseConfig: SupabaseAuthConfig;
  /**
   * Restrict acceptance to automation licenses only (Supporter / Team /
   * Business). Used for unattended execution (systemd, cron, CI) where only
   * an automation entitlement grants the right to run.
   */
  requireAutomation?: boolean;
  /** Include a signed-in user's worker trial when no paid entitlement exists. */
  allowTrial?: boolean;
  /**
   * Word a missing automation license for someone setting up unattended use
   * in a terminal (e.g. `worker init`) instead of for a run that was
   * detected as automated.
   */
  setup?: boolean;
  /** Sign-in command named in the message (defaults to `devintern login`). */
  loginCommand?: string;
  /** Base delay between entitlement retries in ms (defaults to 500). */
  retryBaseDelayMs?: number;
  /**
   * Environment to read `LICENSE_KEY` and `DEVINTERN_SKIP_LICENSE_CHECK` from
   * (defaults to `process.env`), for callers that compose a workspace env
   * without applying it to the process.
   */
  env?: Record<string, string | undefined>;
}

interface CachedEntitlement {
  productKey: string;
  automation: boolean;
  source: "license-key" | "entitlement";
  entitlementSource?: EntitlementSource;
  checkedAt: string;
}

/** Cache lives next to the auth session file so it shares that directory's lifecycle. */
function cacheFilePath(config: SupabaseAuthConfig): string {
  return join(dirname(config.sessionFilePath), "license-cache.json");
}

/** Best-effort write of the last successful check; failures are ignored. */
function writeCachedEntitlement(
  config: SupabaseAuthConfig,
  entry: Omit<CachedEntitlement, "checkedAt">,
): void {
  try {
    const path = cacheFilePath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...entry, checkedAt: new Date().toISOString() }), "utf8");
  } catch {
    // cache is best-effort
  }
}

/** Best-effort removal of the cache after a definitive denial. */
function clearCachedEntitlement(config: SupabaseAuthConfig): void {
  try {
    const path = cacheFilePath(config);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // cache is best-effort
  }
}

/**
 * Reads a cached entitlement if it matches the request and is inside the
 * grace window. Returns `null` otherwise.
 */
function readCachedEntitlement(
  config: SupabaseAuthConfig,
  productKey: string,
  automation: boolean,
): CachedEntitlement | null {
  try {
    const raw = readFileSync(cacheFilePath(config), "utf8");
    const cached = JSON.parse(raw) as CachedEntitlement;
    if (cached.productKey !== productKey) return null;
    // A cache written for an automation check also covers non-automation
    // checks, but not the other way around.
    if (automation && !cached.automation) return null;
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > GRACE_WINDOW_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function graceEnd(checkedAt: string): string | undefined {
  const checked = Date.parse(checkedAt);
  return Number.isFinite(checked) ? new Date(checked + GRACE_WINDOW_MS).toISOString() : undefined;
}

/** Builds the grace-mode success result from a cached entitlement. */
function graceResult(cached: CachedEntitlement, cause: string): LicenseCheckResult {
  const checkedDate = cached.checkedAt.slice(0, 10);
  return {
    valid: true,
    source: "grace",
    entitlementSource: cached.entitlementSource,
    graceEndsAt: graceEnd(cached.checkedAt),
    message:
      `License server unreachable (${cause}). ` +
      `Using cached entitlement from ${checkedDate}; valid for up to 72 hours after the last successful check.`,
  };
}

interface EntitlementResponse {
  entitled: boolean;
  source?: EntitlementSource | "worker-trial";
  productName?: string;
  reason?: string;
  trial?: {
    status: "available" | "active";
    endsAt?: string;
  };
}

function trialResult(response: EntitlementResponse): LicenseCheckResult | null {
  if (response.source !== "worker-trial" || !response.trial) return null;
  const { trial } = response;
  if (
    (trial.status !== "available" && trial.status !== "active") ||
    (trial.status === "active" &&
      (!trial.endsAt ||
        !Number.isFinite(Date.parse(trial.endsAt)) ||
        Date.parse(trial.endsAt) <= Date.now()))
  ) {
    return {
      valid: false,
      source: "none",
      message: "The license server returned an invalid or expired Worker Pilot response.",
    };
  }
  return {
    valid: true,
    source: "trial",
    message:
      trial.status === "available"
        ? "Free Worker Pilot available; it starts after the worker is ready."
        : `Free Worker Pilot active until ${trial.endsAt ?? "the server-provided expiry"}.`,
    trialEndsAt: trial.endsAt,
    trialAvailable: trial.status === "available",
  };
}

/** Retries after the first attempt (`maxRetries: 2` → 3 total requests). */
const ENTITLEMENT_MAX_RETRIES = 2;
const ENTITLEMENT_TOTAL_ATTEMPTS = ENTITLEMENT_MAX_RETRIES + 1;

type EntitlementCheckResult =
  | { status: "entitled"; response: EntitlementResponse }
  | { status: "not_entitled"; reason?: string }
  | { status: "error"; error: string };

function formatEntitlementHttpError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return `HTTP ${status}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as { reason?: string; message?: string };
    const detail = parsed.reason || parsed.message;
    if (detail) {
      return `HTTP ${status}: ${detail}`;
    }
  } catch {
    // use raw body below
  }

  const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  return `HTTP ${status}: ${snippet}`;
}

/**
 * Baked in at build time (`DEVINTERN_RELEASE_BUILD=1` in the publish jobs).
 * Undefined in source runs and tests, which keep the developer escape hatches.
 */
declare const __DEVINTERN_RELEASE_BUILD__: boolean | undefined;

let releaseBuildOverride: boolean | undefined;

/** True only in published release bundles. */
export function isReleaseBuild(): boolean {
  if (releaseBuildOverride !== undefined) return releaseBuildOverride;
  return typeof __DEVINTERN_RELEASE_BUILD__ !== "undefined" && __DEVINTERN_RELEASE_BUILD__ === true;
}

/** Test seam: force the release flag; pass `undefined` to restore the build-time value. */
export function setReleaseBuildForTests(value: boolean | undefined): void {
  releaseBuildOverride = value;
}

/**
 * Whether `DEVINTERN_SKIP_LICENSE_CHECK=1` is honoured. Release builds ignore
 * it so a one-line env edit cannot bypass licensing.
 */
export function shouldSkipLicenseCheck(
  env: Record<string, string | undefined> = process.env,
  releaseBuild: boolean = isReleaseBuild(),
): boolean {
  return !releaseBuild && env.DEVINTERN_SKIP_LICENSE_CHECK === "1";
}

/**
 * Entitlement API base URL. `DEVINTERN_API_BASE` is a test/staging override
 * and is ignored in release builds.
 */
export function resolveApiBase(
  env: Record<string, string | undefined> = process.env,
  releaseBuild: boolean = isReleaseBuild(),
): string {
  return (!releaseBuild && env.DEVINTERN_API_BASE) || DEFAULT_API_BASE;
}

let warnedSkipIgnored = false;

/**
 * Checks entitlement for the signed-in user via the devintern.com license API.
 *
 * Uses {@link fetchWithRetry} for transient failures (5xx, 429, network).
 * Definitive 4xx responses are not retried.
 *
 * @param productKey - Product to check (e.g. `"devintern/code"`).
 * @param accessToken - Supabase access token sent as `Authorization: Bearer`.
 * @param requireAutomation - When true, only automation entitlements qualify.
 */
async function checkEntitlementViaWebsite(
  productKey: string,
  accessToken: string,
  requireAutomation: boolean,
  allowTrial: boolean,
  retryBaseDelayMs: number,
): Promise<EntitlementCheckResult> {
  const base = resolveApiBase();
  const params = new URLSearchParams({ productKey });
  if (requireAutomation) params.set("server", "1");
  if (allowTrial) params.set("trial", "1");
  const url = `${base}/api/license/check?${params.toString()}`;

  try {
    const response = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { maxRetries: ENTITLEMENT_MAX_RETRIES, baseDelay: retryBaseDelayMs, jitter: false },
    );

    if (response.ok) {
      const body = (await response.json()) as EntitlementResponse;
      if (body.entitled) {
        return { status: "entitled", response: body };
      }
      return { status: "not_entitled", reason: body.reason };
    }

    // 401 is a definitive denial of this token, not an infrastructure error.
    if (response.status === 401) {
      const bodyText = await response.text();
      return { status: "not_entitled", reason: formatEntitlementHttpError(401, bodyText) };
    }

    const bodyText = await response.text();
    return { status: "error", error: formatEntitlementHttpError(response.status, bodyText) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", error: message };
  }
}

/** Validate an explicit `LICENSE_KEY` against the Polar customer portal. */
async function checkExplicitLicenseKey(
  explicitKey: string,
  options: LicenseCheckOptions,
): Promise<LicenseCheckResult> {
  const { productKey, supabaseConfig, requireAutomation = false } = options;
  try {
    const result = await validatePolarLicenseKey(explicitKey);
    if (!result.valid) {
      clearCachedEntitlement(supabaseConfig);
      return {
        valid: false,
        source: "license-key",
        message: invalidKeyMessage(options),
      };
    }

    const allowed = getAllowedBenefits(productKey);
    const matched = result.benefitId ? allowed.find((b) => b.id === result.benefitId) : undefined;

    if (allowed.length > 0 && !matched && result.benefitId) {
      clearCachedEntitlement(supabaseConfig);
      return {
        valid: false,
        source: "license-key",
        message: "License key is valid but does not match this product.",
      };
    }

    if (requireAutomation && !isAutomationSource(matched?.source)) {
      clearCachedEntitlement(supabaseConfig);
      return {
        valid: false,
        source: "license-key",
        message:
          "Automated execution requires an automation license (Supporter, Team, or Business). " +
          "Purchase one at https://devintern.com/pricing.",
      };
    }

    writeCachedEntitlement(supabaseConfig, {
      productKey,
      automation: requireAutomation || isAutomationSource(matched?.source),
      source: "license-key",
      entitlementSource: matched?.source,
    });

    return {
      valid: true,
      source: "license-key",
      entitlementSource: matched?.source,
      message: "License key is valid.",
    };
  } catch (error) {
    // Infrastructure failure (Polar unreachable / 5xx): honor the grace window.
    const msg = error instanceof Error ? error.message : String(error);
    const cached = readCachedEntitlement(supabaseConfig, productKey, requireAutomation);
    if (cached) {
      return graceResult(cached, msg);
    }
    return {
      valid: false,
      source: "license-key",
      message: `License validation failed: ${msg}`,
    };
  }
}

/**
 * An invalid or revoked `LICENSE_KEY`. Where the Worker Pilot is allowed, it
 * names the Pilot sign-in as the way to run without a key.
 */
function invalidKeyMessage(options: LicenseCheckOptions): string {
  const message = "LICENSE_KEY is invalid or revoked.";
  if (!options.requireAutomation || !options.allowTrial) return message;
  return (
    `${message} Check the key at https://devintern.com/account, or remove LICENSE_KEY from the ` +
    "workspace .env and sign in to start your free 14-day Worker Pilot: " +
    `\`${options.loginCommand ?? "devintern login"}\`. See ${WORKER_PILOT_DOCS_URL}`
  );
}

/**
 * Resolves whether the caller may use a devintern CLI product.
 *
 * Resolution order:
 * 1. `LICENSE_KEY` env or explicit `licenseKey` → Polar customer-portal validation.
 * 2. Authenticated Supabase user → devintern.com entitlement endpoint.
 *
 * Infrastructure failures fall back to a cached last-known-good entitlement
 * for up to 72 hours; definitive denials clear the cache and fail.
 *
 * Skipped entirely when `DEVINTERN_SKIP_LICENSE_CHECK=1` (tests/CI), except in
 * release builds, which ignore the flag.
 *
 * @param options - Product key, auth config, and optional license key / automation flag.
 * @returns Validation outcome with `valid`, `source`, and a human-readable `message`.
 */
export async function checkLicense(options: LicenseCheckOptions): Promise<LicenseCheckResult> {
  const {
    productKey,
    licenseKey,
    supabaseConfig,
    requireAutomation = false,
    allowTrial = false,
    retryBaseDelayMs,
    env = process.env,
  } = options;

  // Allow tests and CI to skip license checks
  if (isReleaseBuild() && env.DEVINTERN_SKIP_LICENSE_CHECK === "1" && !warnedSkipIgnored) {
    warnedSkipIgnored = true;
    process.stderr.write("DEVINTERN_SKIP_LICENSE_CHECK is ignored in release builds.\n");
  }
  if (shouldSkipLicenseCheck(env)) {
    return {
      valid: true,
      source: "license-key",
      message: "License check skipped (DEVINTERN_SKIP_LICENSE_CHECK=1).",
      skipped: true,
    };
  }

  // 1. Direct license key validation via Polar public customer portal API
  const explicitKey = licenseKey || env.LICENSE_KEY;
  if (explicitKey) {
    return checkExplicitLicenseKey(explicitKey, options);
  }

  // 2. Authenticated user → check Polar entitlements via devintern.com
  let user: AuthenticatedUser | null = null;
  try {
    user = await getAuthenticatedUser(supabaseConfig);
  } catch {
    // Auth error — treat as not logged in
  }

  let entitlementCheckError: string | undefined;

  if (user?.accessToken) {
    const entitlementResult = await checkEntitlementViaWebsite(
      productKey,
      user.accessToken,
      requireAutomation,
      allowTrial,
      retryBaseDelayMs ?? 500,
    );

    if (entitlementResult.status === "entitled") {
      const trial = trialResult(entitlementResult.response);
      if (trial) {
        clearCachedEntitlement(supabaseConfig);
        return trial;
      }
      if (entitlementResult.response.source === "worker-trial") {
        return {
          valid: false,
          source: "none",
          message: "The license server returned an invalid Worker Pilot response.",
        };
      }

      writeCachedEntitlement(supabaseConfig, {
        productKey,
        automation: requireAutomation || isAutomationSource(entitlementResult.response.source),
        source: "entitlement",
        entitlementSource: entitlementResult.response.source,
      });
      const label = entitlementResult.response.productName || "your purchased license";
      return {
        valid: true,
        source: "entitlement",
        entitlementSource: entitlementResult.response.source,
        message: `Entitlement confirmed via ${label}.`,
      };
    }

    if (entitlementResult.status === "not_entitled") {
      // Definitive answer from the server: no entitlement (or revoked).
      clearCachedEntitlement(supabaseConfig);
    }

    if (entitlementResult.status === "error") {
      entitlementCheckError = entitlementResult.error;
      console.warn(
        `⚠️  License entitlement check failed after ${ENTITLEMENT_TOTAL_ATTEMPTS} attempts: ${entitlementCheckError}`,
      );
      const cached = readCachedEntitlement(supabaseConfig, productKey, requireAutomation);
      if (cached) {
        return graceResult(cached, entitlementCheckError);
      }
    }
  }

  return noLicenseResult(options, user !== null, entitlementCheckError);
}

/**
 * Step 3 of {@link checkLicense}: no valid license. LICENSE_KEY is the
 * recommended remedy: it's more reliable than auth, which can fail when the
 * purchase was made under a different email than the Supabase login. Sign-in
 * is the alternative path.
 */
function noLicenseResult(
  options: LicenseCheckOptions,
  signedIn: boolean,
  entitlementCheckError: string | undefined,
): LicenseCheckResult {
  const { requireAutomation = false, allowTrial = false } = options;
  const messages: string[] = [];
  const loginCommand = options.loginCommand ?? "devintern login";
  if (requireAutomation && allowTrial) {
    // The Worker Pilot leads; an existing license key is the alternative.
    if (!signedIn) {
      return {
        valid: false,
        source: "none",
        message: workerPilotSignInMessage(loginCommand),
        signInRequired: true,
      };
    }
    return {
      valid: false,
      source: "none",
      message: entitlementCheckError
        ? `License entitlement check failed: ${entitlementCheckError}. ` +
          `Set LICENSE_KEY in the workspace .env to skip the account check. See ${WORKER_PILOT_DOCS_URL}`
        : workerPilotOverMessage(),
    };
  }
  if (requireAutomation) {
    messages.push(
      options.setup
        ? "No automation license was found, and the unattended worker needs one to start."
        : "Automated execution detected (CI / systemd / cron) but no automation license was found.",
    );
    if (entitlementCheckError) {
      messages.push(`License entitlement check failed: ${entitlementCheckError}.`);
    }
    messages.push(
      "Set LICENSE_KEY to a Supporter, Team, or Business license key from https://devintern.com/account, or purchase one at https://devintern.com/pricing.",
    );
    if (!signedIn) {
      messages.push("Alternatively, sign in if your account already holds one.");
    }
  } else {
    if (!signedIn) {
      messages.push("No LICENSE_KEY is set and you are not signed in.");
    } else if (entitlementCheckError) {
      messages.push(`License entitlement check failed: ${entitlementCheckError}.`);
    } else {
      messages.push("Your account has no matching license for this product.");
    }
    messages.push(
      "Set LICENSE_KEY to a license key from https://devintern.com/account, or purchase one at https://devintern.com/pricing.",
    );
  }

  return {
    valid: false,
    source: "none",
    message: messages.join(" "),
  };
}

/**
 * Error thrown by {@link requireLicense} when the license check result is not
 * valid. Library code must never terminate the host process; CLI entry points
 * catch this error and exit with code 1.
 */
export class LicenseCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseCheckError";
  }
}

/**
 * Activate a server-authoritative Worker Pilot after workspace validation and
 * lock acquisition, immediately before event sources can acquire work. Paid
 * license keys never call this path; trials always require a signed-in user.
 */
export async function activateWorkerTrial(options: {
  productKey: string;
  supabaseConfig: SupabaseAuthConfig;
  retryBaseDelayMs?: number;
  /** Sign-in command named in the message (defaults to `devintern login`). */
  loginCommand?: string;
}): Promise<LicenseCheckResult> {
  let user: AuthenticatedUser | null = null;
  try {
    user = await getAuthenticatedUser(options.supabaseConfig);
  } catch {
    // Render the same actionable login requirement as a missing session.
  }
  if (!user?.accessToken) {
    return {
      valid: false,
      source: "none",
      message: workerPilotSignInMessage(options.loginCommand ?? "devintern login"),
      signInRequired: true,
    };
  }

  const base = resolveApiBase();
  try {
    const response = await fetchWithRetry(
      `${base}/api/license/trial`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productKey: options.productKey }),
      },
      {
        maxRetries: ENTITLEMENT_MAX_RETRIES,
        baseDelay: options.retryBaseDelayMs ?? 500,
        jitter: false,
      },
    );
    if (!response.ok) {
      return {
        valid: false,
        source: "none",
        message: `Could not start the free Worker Pilot (${formatEntitlementHttpError(response.status, await response.text())}).`,
      };
    }
    const body = (await response.json()) as EntitlementResponse;
    const result = trialResult(body);
    if (result && !result.trialAvailable) return result;
    return {
      valid: false,
      source: "none",
      message: "The license server did not activate the free Worker Pilot.",
    };
  } catch (error) {
    return {
      valid: false,
      source: "none",
      message: `Could not start the free Worker Pilot: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

/**
 * Enforces a license check result: logs success or grace info, or throws a
 * {@link LicenseCheckError} on failure (the caller decides the process exit).
 *
 * @param result - Outcome from {@link checkLicense}.
 * @throws {@link LicenseCheckError} when `result.valid` is false.
 */
export function requireLicense(result: LicenseCheckResult): void {
  if (!result.valid) {
    console.error("\n❌ License check failed");
    console.error(`   ${result.message}\n`);
    throw new LicenseCheckError(result.message);
  }

  if (result.source === "grace") {
    console.warn(`⚠️  ${result.message}\n`);
  } else if (result.source === "trial") {
    console.log(`⏳ ${result.message}\n`);
  } else if (result.source === "license-key" || result.source === "entitlement") {
    console.log(`✅ ${result.message}\n`);
  }
}
