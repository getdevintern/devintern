/**
 * What keeps a freshly set-up worker from running, shown at the end of the
 * `worker init` wizard.
 */

import { WORKER_PILOT_OFFER, signInCommand } from "../account/worker-pilot";
import type { ReadinessCheck } from "../observability/readiness";

/**
 * What still keeps the worker from running, one line each: the failing
 * readiness checks when they ran, otherwise the license step's result.
 *
 * @param checks - `worker doctor` checks, or undefined when they did not run
 * @param licenseFailure - License step outcome (null when entitled)
 */
export function readinessBlockers(
  checks: ReadinessCheck[] | undefined,
  licenseFailure: string | null | undefined,
): ReadinessBlocker[] {
  if (checks) {
    return checks
      .filter((check) => check.status === "fail" || check.status === "action")
      .map((check) => ({
        text: `${check.label}: ${check.hint ?? check.detail ?? "see the check above"}`,
        action: check.status === "action",
      }));
  }
  if (licenseFailure) {
    return [
      {
        text: `Automation entitlement: run \`${signInCommand()}\` to begin your ${WORKER_PILOT_OFFER}, or set LICENSE_KEY in the workspace .env`,
        action: false,
      },
    ];
  }
  return [];
}

/** Something that keeps the worker from starting; `action` is a step, not a failure. */
export interface ReadinessBlocker {
  text: string;
  action: boolean;
}
