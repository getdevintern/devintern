/**
 * The `worker doctor` entitlement row, shared by `worker init` (both modes).
 */

import { WORKER_PILOT_NOT_STARTED, describePilotEnd, signInHint } from "../account/worker-pilot";
import type { ReadinessCheck } from "./readiness";

/** Minimal license result the entitlement check needs (subset of `LicenseCheckResult`). */
export interface WorkerEntitlementLike {
  valid: boolean;
  source: string;
  message: string;
  trialAvailable?: boolean;
  /** Server-provided end of an active Worker Pilot (ISO 8601). */
  trialEndsAt?: string;
  /** Underlying SKU of a paid entitlement or license key. */
  entitlementSource?: string;
  /** End of the offline grace window (ISO 8601), when source is `grace`. */
  graceEndsAt?: string;
  /** Nothing is wrong except that nobody is signed in (see `LicenseCheckResult`). */
  signInRequired?: boolean;
}

const SKU_NAMES: Record<string, string> = {
  "solo-automation": "Supporter license",
  "team-automation": "Team/Business license",
};

/** Product name from "Entitlement confirmed via <name>.", or the SKU's name. */
function productName(license: WorkerEntitlementLike): string | undefined {
  const match = /^Entitlement confirmed via (.+?)\.?$/.exec(license.message.trim());
  const named = match?.[1];
  if (named && named !== "your purchased license") return named;
  return license.entitlementSource ? SKU_NAMES[license.entitlementSource] : undefined;
}

/** Human detail for a valid entitlement that is not a Worker Pilot. */
function paidDetail(license: WorkerEntitlementLike): string {
  const name = productName(license);
  if (license.source === "license-key") {
    const sku = license.entitlementSource ? SKU_NAMES[license.entitlementSource] : undefined;
    return `LICENSE_KEY (${sku ?? "valid key"})`;
  }
  if (license.source === "entitlement") {
    return `${name ?? "Purchased license"} (signed-in account)`;
  }
  if (license.source === "grace") {
    const date = license.graceEndsAt ? Date.parse(license.graceEndsAt) : Number.NaN;
    const until = Number.isFinite(date)
      ? ` until ${new Date(date).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "";
    const sku = license.entitlementSource ? SKU_NAMES[license.entitlementSource] : undefined;
    return `offline grace: cached ${sku ?? "entitlement"}${until}; the license server is unreachable`;
  }
  return license.message || license.source;
}

/**
 * Entitlement row. Nobody signed in yet (with no `LICENSE_KEY`) is an
 * `action`: the setup is fine and one sign-in starts the Worker Pilot. Any
 * other missing entitlement (Pilot used up, bad key, failed check) fails.
 */
export function entitlementCheck(
  license: WorkerEntitlementLike,
  loginCommand: string,
  failHint: string,
  now: number = Date.now(),
): ReadinessCheck {
  const base = { id: "entitlement", label: "Automation entitlement" } as const;
  if (license.valid) {
    if (license.trialAvailable) {
      return {
        ...base,
        status: "ok",
        detail: `Worker Pilot available; it starts when the worker starts`,
      };
    }
    if (license.source === "trial") {
      const end = describePilotEnd(license.trialEndsAt, now);
      return {
        ...base,
        status: "ok",
        detail: end
          ? `Worker Pilot, active until ${end.replace(/^ends /, "")}`
          : `Worker Pilot active: ${license.message}`,
      };
    }
    return {
      ...base,
      status: "ok",
      detail: paidDetail(license),
    };
  }
  if (license.signInRequired) {
    return {
      ...base,
      status: "action",
      detail: WORKER_PILOT_NOT_STARTED,
      hint: signInHint(loginCommand),
    };
  }
  return {
    ...base,
    status: "fail",
    detail: `${license.source}: ${license.message}`,
    hint: failHint,
  };
}
