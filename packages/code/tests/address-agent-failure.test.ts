/**
 * Failure reporting for the review/CI-fix agent run.
 *
 * A spawn error produces no agent output at all, so the old generic error hid
 * the cause (for example `E2BIG: argument list too long` from an oversized
 * review prompt) from the operator and from error tracking.
 */

import { describe, expect, test } from "bun:test";

import { describeAgentFailure, classifyAgentFailure } from "../src/lib/review/address";

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

  test("truncates a very long output line, keeping the tail", () => {
    const message = describeAgentFailure({
      success: false,
      output: "x".repeat(800),
      failureReason: "exited with code 1",
    });

    expect(message).toContain("Last agent output: ...");
    expect(message.length).toBeLessThan(800);
    expect(message).not.toContain("x".repeat(800));
  });

  test("keeps the final error when output uses carriage-return progress updates", () => {
    const progress = Array.from({ length: 60 }, (_, i) => `progress ${i}%`).join("\r");
    const message = describeAgentFailure({
      success: false,
      output: `${progress}\rfinal: Error: unknown option --dir\n`,
      failureReason: "exited with code 1",
    });

    expect(message).toContain("Last agent output: final: Error: unknown option --dir");
  });

  test("masks credentials in the reason and the output excerpt", () => {
    const message = describeAgentFailure({
      success: false,
      output: "starting\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      failureReason: "exited with code 1",
    });

    expect(message).not.toContain("wJalrXUtnFEMI");
    expect(message).toContain("AWS_SECRET_ACCESS_KEY=[redacted]");
  });

  test("falls back to a reason when the harness reported none", () => {
    expect(describeAgentFailure({ success: false, output: "" })).toBe(
      "Agent failed to complete successfully: agent process did not report success",
    );
  });
});

describe("classifyAgentFailure", () => {
  const base = { code: 0, timedOut: false, maxTurnsReached: false, timeoutMinutes: 60 };

  test("returns undefined for a clean exit", () => {
    expect(classifyAgentFailure(base)).toBeUndefined();
  });

  test("reports a non-zero exit code", () => {
    expect(classifyAgentFailure({ ...base, code: 2 })).toBe("exited with code 2");
  });

  test("reports a signal termination when the exit code is null", () => {
    expect(classifyAgentFailure({ ...base, code: null })).toBe(
      "agent process was terminated by a signal",
    );
  });

  test("reports max turns ahead of the accompanying non-zero exit", () => {
    expect(classifyAgentFailure({ ...base, code: 1, maxTurnsReached: true })).toBe(
      "reached max turns limit",
    );
  });

  test("reports the timeout ahead of max turns and a null exit code", () => {
    expect(
      classifyAgentFailure({
        ...base,
        code: null,
        timedOut: true,
        maxTurnsReached: true,
        timeoutMinutes: 5,
      }),
    ).toBe("timed out after 5 minutes");
  });
});
