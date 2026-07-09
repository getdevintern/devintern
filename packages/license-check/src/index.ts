/**
 * License check module for devintern CLI tools.
 *
 * Resolves entitlement in this order:
 *   1. LICENSE_KEY env / explicit arg → Polar customer-portal validation.
 *   2. Authenticated Supabase user   → devintern.com entitlement endpoint
 *                                       (covers Supporter and Team/Business
 *                                       automation licenses).
 *   3. 14-day trial window based on first successful CLI authentication.
 */

import {
  type AuthenticatedUser,
  type SupabaseAuthConfig,
  getAuthenticatedUser,
  getUserTrialStartedAt,
} from "@devintern/auth";
import { fetchWithRetry } from "@devintern/utils";

const POLAR_API_BASE = "https://api.polar.sh/v1";
const POLAR_ORGANIZATION_ID = "64a2bf56-c294-40f7-8971-39d32da0c254";

const DEFAULT_API_BASE = "https://devintern.com";

const TRIAL_DAYS = 14;

export interface LicenseCheckResult {
  valid: boolean;
  source: "license-key" | "entitlement" | "trial" | "none";
  message: string;
  trialDaysRemaining?: number;
  /** When source is "entitlement", indicates the underlying SKU type */
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
  /** Whether to allow trial if no license is found */
  allowTrial?: boolean;
  /**
   * Restrict acceptance to automation licenses only (Supporter / Team /
   * Business). Used for unattended execution (systemd, cron, CI) where only
   * an automation entitlement grants the right to run.
   */
  requireServerAddon?: boolean;
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
 * the entitlement source for reporting. Sourced via
 * `scripts/lookup-benefit-ids.ts`. Under FSL interactive use is free, so only
 * automation benefits are listed: the Supporter one-time license grants
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
 * @param requireServerAddon - When true, only automation entitlements qualify.
 */
async function checkEntitlementViaWebsite(
  productKey: string,
  accessToken: string,
  requireServerAddon: boolean,
): Promise<EntitlementCheckResult> {
  const base = process.env.DEVINTERN_API_BASE || DEFAULT_API_BASE;
  const params = new URLSearchParams({ productKey });
  if (requireServerAddon) params.set("server", "1");
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

    const bodyText = await response.text();
    return { status: "error", error: formatEntitlementHttpError(response.status, bodyText) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", error: message };
  }
}

/**
 * Computes whole days left in the CLI trial window from the trial start timestamp.
 *
 * @param createdAt - ISO timestamp when the trial started, or null/undefined if unknown.
 * @returns Days remaining (ceiled), `null` when `createdAt` is missing, or `0` when expired.
 */
function getTrialDaysRemaining(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;

  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const remaining = Math.max(0, TRIAL_DAYS - diffDays);

  return remaining > 0 ? Math.ceil(remaining) : 0;
}

/**
 * Resolves whether the caller may use a devintern CLI product.
 *
 * Resolution order:
 * 1. `LICENSE_KEY` env or explicit `licenseKey` → Polar customer-portal validation.
 * 2. Authenticated Supabase user → devintern.com entitlement endpoint.
 * 3. Optional 14-day trial when `allowTrial` is true and the user is signed in.
 *
 * Skipped entirely when `DEVINTERN_SKIP_LICENSE_CHECK=1` (tests/CI).
 *
 * @param options - Product key, auth config, and optional license key / trial / addon flags.
 * @returns Validation outcome with `valid`, `source`, human-readable `message`, and optional trial metadata.
 */
export async function checkLicense(options: LicenseCheckOptions): Promise<LicenseCheckResult> {
  const {
    productKey,
    licenseKey,
    supabaseConfig,
    allowTrial = true,
    requireServerAddon = false,
  } = options;

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
        return {
          valid: false,
          source: "license-key",
          message: "License key is invalid or revoked.",
        };
      }

      const allowed = getAllowedBenefits(productKey);
      const matched = result.benefitId ? allowed.find((b) => b.id === result.benefitId) : undefined;

      if (allowed.length > 0 && !matched && result.benefitId) {
        return {
          valid: false,
          source: "license-key",
          message: "License key is valid but does not match this product.",
        };
      }

      if (requireServerAddon && !isAutomationSource(matched?.source)) {
        return {
          valid: false,
          source: "license-key",
          message:
            "Automated execution requires an automation license (Supporter, Team, or Business). " +
            "Purchase one at https://devintern.com/pricing.",
        };
      }

      return {
        valid: true,
        source: "license-key",
        entitlementSource: matched?.source,
        message: "License key is valid.",
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
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
      requireServerAddon,
    );

    if (entitlementResult.status === "entitled") {
      const label = entitlementResult.response.productName || "your purchased license";
      return {
        valid: true,
        source: "entitlement",
        entitlementSource: entitlementResult.response.source,
        message: `Entitlement confirmed via ${label}.`,
      };
    }

    if (entitlementResult.status === "error") {
      entitlementCheckError = entitlementResult.error;
      console.warn(
        `⚠️  License entitlement check failed after ${ENTITLEMENT_TOTAL_ATTEMPTS} attempts: ${entitlementCheckError}`,
      );
    }
  }

  // 3. Trial period fallback — applies to both interactive and automated runs
  // so trial users can evaluate unattended automation.
  if (allowTrial && user?.accessToken) {
    const trialStartedAt = await getUserTrialStartedAt(supabaseConfig, user.accessToken);
    if (trialStartedAt) {
      const remaining = getTrialDaysRemaining(trialStartedAt);
      if (remaining && remaining > 0) {
        const trialMessage = entitlementCheckError
          ? `Entitlement check unavailable (${entitlementCheckError}). Using ${TRIAL_DAYS}-day trial (${remaining} days remaining).`
          : `No license found. Using ${TRIAL_DAYS}-day trial (${remaining} days remaining).`;

        return {
          valid: true,
          source: "trial",
          message: trialMessage,
          trialDaysRemaining: remaining,
        };
      }
    }
  }

  // 4. No valid license and trial expired or not available.
  // LICENSE_KEY is the recommended remedy — it's more reliable than auth,
  // which can fail silently when a seat is claimed under a different email
  // than the Supabase login. Sign-in is offered as an alternative path.
  const messages: string[] = [];
  if (requireServerAddon) {
    messages.push(
      "Automated execution detected (CI / systemd / cron) but no automation license was found.",
    );
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
    if (allowTrial) {
      if (!user) {
        messages.push(`Alternatively, sign in to start your ${TRIAL_DAYS}-day trial.`);
      } else if (user.accessToken) {
        const trialStartedAt = await getUserTrialStartedAt(supabaseConfig, user.accessToken);
        if (trialStartedAt) {
          messages.push(`Your ${TRIAL_DAYS}-day trial has expired.`);
        } else {
          messages.push(
            `Your trial has not started. Run the login command to begin your ${TRIAL_DAYS}-day trial.`,
          );
        }
      }
    }
  }

  return {
    valid: false,
    source: "none",
    message: messages.join(" "),
  };
}

/**
 * Enforces a license check result: logs success or trial info, or exits with code 1 on failure.
 *
 * @param result - Outcome from {@link checkLicense}.
 */
export function requireLicense(result: LicenseCheckResult): void {
  if (!result.valid) {
    console.error("\n❌ License check failed");
    console.error(`   ${result.message}\n`);
    process.exit(1);
  }

  if (result.source === "trial" && result.trialDaysRemaining) {
    console.log(
      `⏳ Trial mode: ${result.trialDaysRemaining} day${result.trialDaysRemaining === 1 ? "" : "s"} remaining. Purchase at https://devintern.com/pricing\n`,
    );
  } else if (result.source === "license-key" || result.source === "entitlement") {
    console.log(`✅ ${result.message}\n`);
  }
}
