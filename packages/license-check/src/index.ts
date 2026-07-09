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
import {
  type AuthenticatedUser,
  type SupabaseAuthConfig,
  getAuthenticatedUser,
} from "@devintern/auth";
import { fetchWithRetry } from "@devintern/utils";

const POLAR_API_BASE = "https://api.polar.sh/v1";
const POLAR_ORGANIZATION_ID = "64a2bf56-c294-40f7-8971-39d32da0c254";

const DEFAULT_API_BASE = "https://devintern.com";

/** How long a cached last-known-good entitlement is honored when the license server is unreachable. */
const GRACE_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface LicenseCheckResult {
  valid: boolean;
  source: "license-key" | "entitlement" | "grace" | "none";
  message: string;
  /** When source is "entitlement" (or "grace"), indicates the underlying SKU type */
  entitlementSource?: EntitlementSource;
}

export type EntitlementSource = "solo-automation" | "team-automation";

/**
 * Entitlement sources that qualify for unattended automation. Under FSL,
 * interactive use is free; only the worker / unattended execution requires a
 * license, so every source is an automation source.
 */
const AUTOMATION_SOURCES: ReadonlySet<EntitlementSource> = new Set([
  "solo-automation",
  "team-automation",
]);

/** Whether an entitlement source qualifies for unattended automation. */
export function isAutomationSource(source: EntitlementSource | undefined): boolean {
  return source !== undefined && AUTOMATION_SOURCES.has(source);
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
}

interface ValidatedLicenseKey {
  status: string;
  benefit_id?: string;
}

/**
 * Validates a Polar license key via the customer-portal API.
 *
 * @param key - License key to validate (from `LICENSE_KEY` or CLI flag).
 * @returns Whether Polar granted the key and the associated benefit ID when present.
 * @throws {Error} When Polar returns a non-404 HTTP error.
 */
async function validateLicenseKey(key: string): Promise<{ valid: boolean; benefitId?: string }> {
  const response = await fetch(`${POLAR_API_BASE}/customer-portal/license-keys/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key,
      organization_id: POLAR_ORGANIZATION_ID,
    }),
  });

  if (response.status === 404) {
    return { valid: false };
  }
  if (!response.ok) {
    throw new Error(`Polar license validation failed (${response.status})`);
  }

  const data = (await response.json()) as ValidatedLicenseKey;

  return {
    valid: data.status === "granted",
    benefitId: data.benefit_id,
  };
}

/**
 * Polar license-key benefit IDs that grant unattended automation, tagged with
 * the entitlement source for reporting. Under FSL interactive use is free, so
 * only automation benefits are listed: the Supporter one-time license grants
 * `solo-automation`; the Team and Business subscriptions (monthly and yearly)
 * share one reusable `team-automation` benefit.
 */
const ALLOWED_BENEFITS: Record<string, Array<{ id: string; source: EntitlementSource }>> = {
  "devintern/code": [
    { id: "d15d2b30-390b-45e3-8adf-b6e32080b704", source: "solo-automation" }, // Supporter (one-time)
    { id: "5d9628d5-2ee8-44eb-9b32-f75c4c4daf0a", source: "team-automation" }, // Team/Business (subscription)
  ],
};

/**
 * Returns Polar benefit IDs and SKU sources permitted for a product key.
 *
 * @param productKey - Product identifier, e.g. `"devintern/pm"` or `"devintern/code"`.
 * @returns Allowed benefits for the product, or an empty array when the key is unknown.
 */
export function getAllowedBenefits(
  productKey: string,
): Array<{ id: string; source: EntitlementSource }> {
  return ALLOWED_BENEFITS[productKey.toLowerCase().trim()] ?? [];
}

/**
 * Returns only the Polar benefit UUIDs allowed for a product key.
 *
 * @param productKey - Product identifier, e.g. `"devintern/pm"` or `"devintern/code"`.
 * @returns Benefit IDs from {@link getAllowedBenefits}.
 */
export function getAllowedBenefitIds(productKey: string): string[] {
  return getAllowedBenefits(productKey).map((b) => b.id);
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

/** Builds the grace-mode success result from a cached entitlement. */
function graceResult(cached: CachedEntitlement, cause: string): LicenseCheckResult {
  const checkedDate = cached.checkedAt.slice(0, 10);
  return {
    valid: true,
    source: "grace",
    entitlementSource: cached.entitlementSource,
    message:
      `License server unreachable (${cause}). ` +
      `Using cached entitlement from ${checkedDate}; valid for up to 72 hours after the last successful check.`,
  };
}

interface EntitlementResponse {
  entitled: boolean;
  source?: EntitlementSource;
  productName?: string;
  reason?: string;
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
): Promise<EntitlementCheckResult> {
  const base = process.env.DEVINTERN_API_BASE || DEFAULT_API_BASE;
  const params = new URLSearchParams({ productKey });
  if (requireAutomation) params.set("server", "1");
  const url = `${base}/api/license/check?${params.toString()}`;

  try {
    const response = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { maxRetries: ENTITLEMENT_MAX_RETRIES, baseDelay: 500, jitter: false },
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
 * Skipped entirely when `DEVINTERN_SKIP_LICENSE_CHECK=1` (tests/CI).
 *
 * @param options - Product key, auth config, and optional license key / automation flag.
 * @returns Validation outcome with `valid`, `source`, and a human-readable `message`.
 */
export async function checkLicense(options: LicenseCheckOptions): Promise<LicenseCheckResult> {
  const { productKey, licenseKey, supabaseConfig, requireAutomation = false } = options;

  // Allow tests and CI to skip license checks
  if (process.env.DEVINTERN_SKIP_LICENSE_CHECK === "1") {
    return {
      valid: true,
      source: "license-key",
      message: "License check skipped (DEVINTERN_SKIP_LICENSE_CHECK=1).",
    };
  }

  // 1. Direct license key validation via Polar public customer portal API
  const explicitKey = licenseKey || process.env.LICENSE_KEY;
  if (explicitKey) {
    try {
      const result = await validateLicenseKey(explicitKey);
      if (!result.valid) {
        clearCachedEntitlement(supabaseConfig);
        return {
          valid: false,
          source: "license-key",
          message: "License key is invalid or revoked.",
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
    );

    if (entitlementResult.status === "entitled") {
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

  // 3. No valid license. LICENSE_KEY is the recommended remedy: it's more
  // reliable than auth, which can fail when the purchase was made under a
  // different email than the Supabase login. Sign-in is the alternative path.
  const messages: string[] = [];
  if (requireAutomation) {
    messages.push(
      "Automated execution detected (CI / systemd / cron) but no automation license was found.",
    );
    if (entitlementCheckError) {
      messages.push(`License entitlement check failed: ${entitlementCheckError}.`);
    }
    messages.push(
      "Set LICENSE_KEY to a Supporter, Team, or Business license key from https://devintern.com/account, or purchase one at https://devintern.com/pricing.",
    );
    if (!user) {
      messages.push("Alternatively, sign in if your account already holds one.");
    }
  } else {
    if (!user) {
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
 * Enforces a license check result: logs success or grace info, or exits with code 1 on failure.
 *
 * @param result - Outcome from {@link checkLicense}.
 */
export function requireLicense(result: LicenseCheckResult): void {
  if (!result.valid) {
    console.error("\n❌ License check failed");
    console.error(`   ${result.message}\n`);
    process.exit(1);
  }

  if (result.source === "grace") {
    console.warn(`⚠️  ${result.message}\n`);
  } else if (result.source === "license-key" || result.source === "entitlement") {
    console.log(`✅ ${result.message}\n`);
  }
}
