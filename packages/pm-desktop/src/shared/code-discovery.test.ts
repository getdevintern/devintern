import { describe, expect, test } from "bun:test";
import { CODE_PRODUCT_URL, shouldShowCodeDiscovery } from "./code-discovery.ts";

describe("shouldShowCodeDiscovery", () => {
  test("shows for a configured project without Code and not dismissed", () => {
    expect(
      shouldShowCodeDiscovery({
        configured: true,
        hasCodeConfig: false,
        dismissed: false,
      }),
    ).toBe(true);
  });

  test("hides during setup when project is not configured", () => {
    expect(
      shouldShowCodeDiscovery({
        configured: false,
        hasCodeConfig: false,
        dismissed: false,
      }),
    ).toBe(false);
  });

  test("hides when the project already has .devintern-code", () => {
    expect(
      shouldShowCodeDiscovery({
        configured: true,
        hasCodeConfig: true,
        dismissed: false,
      }),
    ).toBe(false);
  });

  test("hides after the user dismisses", () => {
    expect(
      shouldShowCodeDiscovery({
        configured: true,
        hasCodeConfig: false,
        dismissed: true,
      }),
    ).toBe(false);
  });
});

describe("CODE_PRODUCT_URL", () => {
  test("points at the founders page on devintern.com with discovery UTMs", () => {
    expect(CODE_PRODUCT_URL.startsWith("https://devintern.com/for/founders/")).toBe(true);
    expect(CODE_PRODUCT_URL).toContain("utm_source=pm-desktop");
    expect(CODE_PRODUCT_URL).toContain("utm_campaign=code-discovery");
  });
});
