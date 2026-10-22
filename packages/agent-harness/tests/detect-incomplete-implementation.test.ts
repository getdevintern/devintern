import { describe, expect, test } from "bun:test";
import { detectIncompleteImplementation } from "../src/detect-incomplete-implementation.js";

/** Pad a transcript so the "too short" rule never fires in language tests. */
const PADDING = "Tool output that is unrelated to the verdict.\n".repeat(4);
const SUMMARY_START = "<!-- devintern:summary:start -->";
const SUMMARY_END = "<!-- devintern:summary:end -->";

function withSummary(body: string): string {
  return `${PADDING}${SUMMARY_START}\n${body}\n${SUMMARY_END}\n`;
}

describe("detectIncompleteImplementation", () => {
  test("returns incomplete when the final answer admits it could not complete the task", () => {
    const result = detectIncompleteImplementation(
      `${PADDING}I was unable to complete the implementation due to missing requirements.`,
    );
    expect(result.incomplete).toBe(true);
    expect(result.reasons).toContain("agent output contains failure language");
  });

  test("returns incomplete for failure language inside the summary block", () => {
    const stdout = withSummary(
      "## Why\nI could not implement the requested feature.\n\n## What changed\nNothing.",
    );
    expect(detectIncompleteImplementation(stdout).incomplete).toBe(true);
  });

  test("returns incomplete for minimal output", () => {
    const result = detectIncompleteImplementation("Done.");
    expect(result.incomplete).toBe(true);
    expect(result.reasons).toContain("agent output is too short");
  });

  test("ignores failure language in tool output before a complete summary", () => {
    // Regression: an agent that printed a source file or comment containing
    // "I could not implement ..." was reported as incomplete even though its
    // final summary showed completed, verified work.
    const stdout = [
      PADDING,
      "// Historical note: I could not implement the feature before this change.",
      "a harness whose CLI cannot emit JSON",
      "AI could not parse the old flag shape",
      withSummary("## Why\nRegistered the harness.\n\n## Verification\nAll suites pass."),
    ].join("\n");

    expect(detectIncompleteImplementation(stdout)).toEqual({ incomplete: false, reasons: [] });
  });

  test("ignores advisory verification notes inside the summary", () => {
    const stdout = withSummary(
      [
        "## Why\nAdded the adapter.",
        "## Verification",
        "I could not verify the live account because no credentials are configured.",
        "Everything else passes.",
      ].join("\n\n"),
    );
    expect(detectIncompleteImplementation(stdout).incomplete).toBe(false);
  });

  test("uses the tail when the summary protocol is absent", () => {
    // A matching phrase early in a long transcript is transcript noise; only
    // the final message region counts when there is no summary block.
    const filler = "earlier tool output line\n".repeat(400);
    const clean = `${"I was unable to complete the task.\n"}${filler}Final answer: implemented and verified. All checks pass.`;
    expect(detectIncompleteImplementation(clean).incomplete).toBe(false);

    const failed = `${filler}I was unable to complete the task; the API contract is unclear.`;
    expect(detectIncompleteImplementation(failed).incomplete).toBe(true);
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
