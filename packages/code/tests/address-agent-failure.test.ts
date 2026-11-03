/**
 * Failure reporting for the review/CI-fix agent run.
 *
 * A spawn error produces no agent output at all, so the old generic error hid
 * the cause (for example `E2BIG: argument list too long` from an oversized
 * review prompt) from the operator and from error tracking.
 */

import { describe, expect, test } from "bun:test";

import { describeAgentFailure } from "../src/lib/review/address";

describe("describeAgentFailure", () => {
  test("names the harness outcome and keeps the spawn error", () => {
    const message = describeAgentFailure({
      success: false,
      output: "Failed to run OpenCode: spawn E2BIG",
      failureReason: "failed to run OpenCode: spawn E2BIG",
    });

    expect(message).toContain("Agent failed to complete successfully");
    expect(message).toContain("failed to run OpenCode");
    expect(message).toContain("E2BIG");
    // The output repeats the spawn reason; don't print it twice.
    expect(message).not.toContain("Failed to run OpenCode");
  });

  test("appends the last meaningful, ANSI-free output line for a non-zero exit", () => {
    const message = describeAgentFailure({
      success: false,
      output: "starting up\n\x1b[31mError: unknown option --dir\x1b[0m\n\n",
      failureReason: "exited with code 1",
    });

    expect(message).toBe(
      [
        "Agent failed to complete successfully: exited with code 1",
        "Last agent output: Error: unknown option --dir",
      ].join("\n"),
    );
  });

  test("reports a timeout without treating it as a generic failure", () => {
    const message = describeAgentFailure({
      success: false,
      output: "partial work\n\nTimed out after 60 minutes",
      failureReason: "timed out after 60 minutes",
    });

    expect(message).toContain("timed out after 60 minutes");
    expect(message).not.toContain("Last agent output");
  });

  test("truncates a very long output line", () => {
    const message = describeAgentFailure({
      success: false,
      output: "x".repeat(800),
      failureReason: "exited with code 1",
    });

    expect(message).toContain("Last agent output: xxxx");
    expect(message.length).toBeLessThan(800);
    expect(message).toContain("...");
  });

  test("falls back to a reason when the harness reported none", () => {
    expect(describeAgentFailure({ success: false, output: "" })).toBe(
      "Agent failed to complete successfully: agent process did not report success",
    );
  });
});
