import { describe, expect, test } from "bun:test";

import {
  getAllowedBenefits,
  isTeamAutomationEntitled,
  type LicenseCheckResult,
} from "../src/index";

function result(overrides: Partial<LicenseCheckResult>): LicenseCheckResult {
  return { valid: true, source: "entitlement", message: "ok", ...overrides };
}

describe("isTeamAutomationEntitled", () => {
  test("team-automation entitlements qualify", () => {
    expect(isTeamAutomationEntitled(result({ entitlementSource: "team-automation" }))).toBe(true);
    expect(
      isTeamAutomationEntitled(
        result({ source: "license-key", entitlementSource: "team-automation" }),
      ),
    ).toBe(true);
  });

  test("grace-window results qualify when the cached entitlement was team-automation", () => {
    expect(
      isTeamAutomationEntitled(result({ source: "grace", entitlementSource: "team-automation" })),
    ).toBe(true);
    expect(
      isTeamAutomationEntitled(result({ source: "grace", entitlementSource: "solo-automation" })),
    ).toBe(false);
  });

  test("solo automation entitlements do not qualify", () => {
    expect(isTeamAutomationEntitled(result({ entitlementSource: "solo-automation" }))).toBe(false);
    expect(isTeamAutomationEntitled(result({ entitlementSource: undefined }))).toBe(false);
  });

  test("invalid results never qualify, even with the right source", () => {
    expect(
      isTeamAutomationEntitled(
        result({ valid: false, source: "none", entitlementSource: "team-automation" }),
      ),
    ).toBe(false);
  });
});

describe("worker automation benefits", () => {
  test("devintern/code carries the solo and team automation benefit ids", () => {
    const sources = getAllowedBenefits("devintern/code").map((benefit) => benefit.source);
    expect(sources).toContain("solo-automation");
    expect(sources).toContain("team-automation");
  });
});
