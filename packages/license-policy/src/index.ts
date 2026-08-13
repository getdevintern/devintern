/**
 * Pure DevIntern licensing policy and Polar license-key validation.
 *
 * This package is zero-dependency and uses only `fetch`, so the public CLI,
 * private website, and Cloudflare workers can share one entitlement table.
 */

const POLAR_API_BASE = "https://api.polar.sh/v1";

export const POLAR_ORGANIZATION_ID = "64a2bf56-c294-40f7-8971-39d32da0c254";

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
  return getAllowedBenefits(productKey).map((benefit) => benefit.id);
}

interface PolarValidateResponse {
  status: string;
  benefit_id?: string;
  customer_id?: string;
}

export interface ValidatedPolarKey {
  valid: boolean;
  benefitId?: string;
  /** Polar customer id — the durable customer identity for hosted services. */
  customerId?: string;
}

/**
 * Validates a Polar license key via the public customer-portal API.
 *
 * Stateless and secretless: any runtime holding just the key can validate it.
 *
 * @param key - License key to validate (from `LICENSE_KEY` or CLI flag).
 * @returns Whether Polar granted the key, plus the benefit and customer ids when present.
 * @throws {Error} When Polar returns a non-404 HTTP error.
 */
export async function validatePolarLicenseKey(key: string): Promise<ValidatedPolarKey> {
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

  const data = (await response.json()) as PolarValidateResponse;

  return {
    valid: data.status === "granted",
    benefitId: data.benefit_id,
    customerId: data.customer_id,
  };
}
