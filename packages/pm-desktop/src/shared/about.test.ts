import { describe, expect, test } from "bun:test";
import { ABOUT_PRODUCT_NAME, ABOUT_WEBSITE_URL, APP_DISPLAY_NAME } from "./about.ts";

describe("ABOUT_WEBSITE_URL", () => {
  test("points at the DevIntern homepage with desktop about UTMs", () => {
    expect(ABOUT_WEBSITE_URL.startsWith("https://devintern.com/")).toBe(true);
    expect(ABOUT_WEBSITE_URL).toContain("utm_source=pm-desktop");
    expect(ABOUT_WEBSITE_URL).toContain("utm_campaign=about");
  });
});

describe("About copy constants", () => {
  test("uses expected product naming", () => {
    expect(ABOUT_PRODUCT_NAME).toBe("DevIntern");
    expect(APP_DISPLAY_NAME).toBe("DevIntern PM");
  });
});
