import { describe, expect, test } from "bun:test";
import {
  ABOUT_PRODUCT_NAME,
  ABOUT_WEBSITE_URL,
  APP_DISPLAY_NAME,
  formatAppWindowTitle,
} from "./about.ts";

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

describe("formatAppWindowTitle", () => {
  test("includes the product name and running app version", () => {
    expect(formatAppWindowTitle("0.9.11")).toBe("DevIntern PM v0.9.11");
  });

  test("normalizes surrounding version whitespace", () => {
    expect(formatAppWindowTitle(" 1.2.3-beta.1 ")).toBe("DevIntern PM v1.2.3-beta.1");
  });

  test.each([undefined, null, "", "   ", 123])(
    "falls back to the product name for unavailable version %p",
    (version) => {
      expect(formatAppWindowTitle(version)).toBe("DevIntern PM");
    },
  );
});
