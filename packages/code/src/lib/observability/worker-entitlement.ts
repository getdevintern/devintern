/**
 * The `worker doctor` entitlement row, shared by `worker init` (both modes).
 */

import {
  WORKER_PILOT_NOT_STARTED,
  WORKER_PILOT_OFFER,
  describePilotEnd,
  signInHint,
} from "../account/worker-pilot";
import type { ReadinessCheck } from "./readiness";

/** Minimal license result the entitlement check needs (subset of `LicenseCheckResult`). */
export interface WorkerEntitlementLike {
  valid: boolean;
  source: string;
  message: string;
  trialAvailable?: boolean;
  /** Server-provided end of an active Worker Pilot (ISO 8601). */
  trialEndsAt?: string;
  /** Nothing is wrong except that nobody is signed in (see `LicenseCheckResult`). */
  signInRequired?: boolean;
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
        detail: `Worker Pilot: signed in; your ${WORKER_PILOT_OFFER} starts when the worker first starts`,
      };
    }
    if (license.source === "trial") {
      const end = describePilotEnd(license.trialEndsAt, now);
      return {
        ...base,
        status: "ok",
        detail: end ? `Worker Pilot active, ${end}` : `trial: ${license.message}`,
      };
    }
    return {
      ...base,
      status: "ok",
      detail: `${license.source}${license.source === "grace" ? `: ${license.message}` : ""}`,
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
