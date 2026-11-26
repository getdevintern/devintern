import { describe, expect, test } from "bun:test";
import { entitlementCheck } from "../src/lib/observability/worker-entitlement";
import type { WorkerEntitlementLike } from "../src/lib/observability/worker-entitlement";

const NOW = Date.parse("2026-11-26T00:00:00Z");

function detail(license: WorkerEntitlementLike): string | undefined {
  return entitlementCheck(license, "login", "hint", NOW).detail;
}

describe("entitlement row detail", () => {
  test("signed-in account names the product", () => {
    expect(
      detail({
        valid: true,
        source: "entitlement",
        entitlementSource: "solo-automation",
        message: "Entitlement confirmed via Supporter license.",
      }),
    ).toBe("Supporter license (signed-in account)");
  });

  test("a generic product label falls back to the SKU name", () => {
    expect(
      detail({
        valid: true,
        source: "entitlement",
        entitlementSource: "team-automation",
        message: "Entitlement confirmed via your purchased license.",
      }),
    ).toBe("Team/Business license (signed-in account)");
  });

  test("license key", () => {
    expect(
      detail({
        valid: true,
        source: "license-key",
        entitlementSource: "solo-automation",
        message: "License key is valid.",
      }),
    ).toBe("LICENSE_KEY (Supporter license)");
  });

  test("active Worker Pilot shows the end date", () => {
    expect(
      detail({
        valid: true,
        source: "trial",
        message: "x",
        trialEndsAt: "2026-12-03T00:00:00Z",
      }),
    ).toBe("Worker Pilot, active until 2026-12-03 (7 days left)");
  });

  test("available Worker Pilot", () => {
    expect(detail({ valid: true, source: "trial", message: "x", trialAvailable: true })).toBe(
      "Worker Pilot available; it starts when the worker starts",
    );
  });

  test("grace says offline and when it ends", () => {
    expect(
      detail({
        valid: true,
        source: "grace",
        entitlementSource: "solo-automation",
        graceEndsAt: "2026-11-27T12:00:00Z",
        message: "License server unreachable",
      }),
    ).toBe(
      "offline grace: cached Supporter license until 2026-11-27 12:00 UTC; the license server is unreachable",
    );
  });

  test("grace without an expiry still says offline", () => {
    expect(detail({ valid: true, source: "grace", message: "m" })).toBe(
      "offline grace: cached entitlement; the license server is unreachable",
    );
  });
});
