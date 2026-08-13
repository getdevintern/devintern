import { afterEach, describe, expect, test } from "bun:test";
import {
  POLAR_ORGANIZATION_ID,
  getAllowedBenefitIds,
  getAllowedBenefits,
  isAutomationSource,
  validatePolarLicenseKey,
} from "./src/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DevIntern license policy", () => {
  test("code grants the solo and team automation benefits", () => {
    const benefits = getAllowedBenefits("devintern/code");

    expect(benefits.map((benefit) => benefit.source).sort()).toEqual([
      "solo-automation",
      "team-automation",
    ]);
    expect(benefits.every((benefit) => isAutomationSource(benefit.source))).toBe(true);
  });

  test("returns the Polar License Key benefit ids", () => {
    expect(getAllowedBenefitIds("devintern/code")).toEqual([
      "d15d2b30-390b-45e3-8adf-b6e32080b704",
      "5d9628d5-2ee8-44eb-9b32-f75c4c4daf0a",
    ]);
  });

  test("unknown and interactive-only products have no automation benefits", () => {
    expect(getAllowedBenefits("devintern/pm")).toEqual([]);
    expect(getAllowedBenefits("devintern/nope")).toEqual([]);
  });
});

describe("validatePolarLicenseKey", () => {
  test("maps a granted Polar response and sends the organization id", async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        status: "granted",
        benefit_id: "benefit-1",
        customer_id: "customer-1",
      });
    }) as typeof fetch;

    await expect(validatePolarLicenseKey("license-key")).resolves.toEqual({
      valid: true,
      benefitId: "benefit-1",
      customerId: "customer-1",
    });
    expect(requestBody).toEqual({
      key: "license-key",
      organization_id: POLAR_ORGANIZATION_ID,
    });
  });

  test("treats a missing Polar key as invalid", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

    await expect(validatePolarLicenseKey("missing-key")).resolves.toEqual({ valid: false });
  });

  test("surfaces Polar infrastructure failures", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

    await expect(validatePolarLicenseKey("license-key")).rejects.toThrow(
      "Polar license validation failed (503)",
    );
  });
});
