import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parseAutoMergeArgs } from "../src/lib/review/cli";
const gate = await import("../src/lib/review/merge-gate");

const URL = "https://github.com/owner/repo/pull/1";

describe("parseAutoMergeArgs --review-instructions", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("`=` form keeps text, including a leading dash", () => {
    const parsed = parseAutoMergeArgs([URL, "--review-instructions=-never billing/"], gate);
    expect(parsed?.prUrl).toBe(URL);
    expect(parsed?.policy.reviewInstructions).toBe("-never billing/");
  });

  test("space form with URL after the flag", () => {
    const parsed = parseAutoMergeArgs(["--review-instructions", "Never merge billing/", URL], gate);
    expect(parsed?.prUrl).toBe(URL);
    expect(parsed?.policy.reviewInstructions).toBe("Never merge billing/");
  });

  test("space form with URL before the flag", () => {
    const parsed = parseAutoMergeArgs([URL, "--review-instructions", "Never merge billing/"], gate);
    expect(parsed?.prUrl).toBe(URL);
    expect(parsed?.policy.reviewInstructions).toBe("Never merge billing/");
  });

  test("missing or flag-like value is a usage error, not swallowed", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseAutoMergeArgs([URL, "--review-instructions"], gate)).toBeUndefined();
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      expect(parseAutoMergeArgs([URL, "--review-instructions", "--dry-run"], gate)).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});
