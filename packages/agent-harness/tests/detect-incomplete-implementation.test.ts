import { describe, expect, test } from "bun:test";
import { detectIncompleteImplementation } from "../src/detect-incomplete-implementation.js";

describe("detectIncompleteImplementation", () => {
  test("returns incomplete for failure language", () => {
    const result = detectIncompleteImplementation(
      "I was unable to complete the implementation due to missing requirements.",
    );
    expect(result.incomplete).toBe(true);
    expect(result.reasons).toContain("agent output contains failure language");
  });

  test("returns incomplete for minimal output", () => {
    const result = detectIncompleteImplementation("Done.");
    expect(result.incomplete).toBe(true);
    expect(result.reasons).toContain("agent output is too short");
  });

  test("ignores failure language that is part of another word", () => {
    // Regression: a complete run summary mentioning "a harness whose CLI
    // cannot emit JSON" matched "I cannot" and the run was reported as an
    // incomplete implementation after the agent had finished successfully.
    const stdout = `Registered the new harness.

- A harness whose CLI cannot emit JSON falls back to plain text.
- Users of Meta's \`muse\` CLI could not select it before this change.
- AI could not parse the old flag shape.

## Verification
All suites pass.`;
    expect(detectIncompleteImplementation(stdout)).toEqual({ incomplete: false, reasons: [] });
  });

  test("returns complete for successful implementation summary", () => {
    const stdout = `I have completed the implementation for DEV-4.

## Summary of Changes

All tests pass. Type checking is clean. Acceptance criteria are met.
`.repeat(5);

    const result = detectIncompleteImplementation(stdout);
    expect(result.incomplete).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});
