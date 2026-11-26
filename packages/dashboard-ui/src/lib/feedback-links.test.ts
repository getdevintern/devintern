import { describe, expect, test } from "bun:test";

import { newIssueUrl, parseHealthVersion } from "./feedback-links";

describe("newIssueUrl", () => {
  test("selects the template and prefills the version", () => {
    expect(newIssueUrl("feature_request.yml", "2.29.0")).toBe(
      "https://github.com/getdevintern/devintern/issues/new?template=feature_request.yml&version=2.29.0",
    );
  });

  test("omits an unknown or blank version", () => {
    expect(newIssueUrl("bug_report.yml")).toBe(
      "https://github.com/getdevintern/devintern/issues/new?template=bug_report.yml",
    );
    expect(newIssueUrl("bug_report.yml", "  ")).not.toContain("version=");
  });
});

describe("parseHealthVersion", () => {
  test("reads a string version", () => {
    expect(parseHealthVersion({ status: "ok", version: " 2.29.0 " })).toBe("2.29.0");
  });

  test("returns null for missing or malformed versions", () => {
    expect(parseHealthVersion({ status: "ok" })).toBeNull();
    expect(parseHealthVersion({ version: 3 })).toBeNull();
    expect(parseHealthVersion(null)).toBeNull();
  });
});
