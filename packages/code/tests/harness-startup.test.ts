import { describe, expect, test } from "bun:test";

import { detectHarnessStartupFailure } from "../src/lib/agent/harness-startup";

describe("detectHarnessStartupFailure", () => {
  test("classifies a mise sandbox denial", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr:
        "mise ERROR Failed to install npm:@xai-official/grok: Permission denied (os error 13)",
      durationMs: 150,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("mise ERROR");
  });

  test("classifies nono path_not_granted startup errors", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "nono: path_not_granted: /home/user/.local/share/mise",
      durationMs: 90,
    });
    expect(result?.unavailable).toBe(true);
  });

  test("classifies EACCES and ENOENT", () => {
    for (const stderr of ["spawn grok EACCES", "spawn grok ENOENT"]) {
      expect(
        detectHarnessStartupFailure({ exitCode: 1, stdout: "", stderr, durationMs: 50 })
          ?.unavailable,
      ).toBe(true);
    }
  });

  test("classifies a fast non-zero exit with no output", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 2,
      stdout: "",
      stderr: "",
      durationMs: 500,
    });
    expect(result?.unavailable).toBe(true);
  });

  test("keeps a slow agent failure as a normal failure", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "The tests failed.\n",
        stderr: "some tool error",
        durationMs: 10_000,
      }),
    ).toBeNull();
  });

  test("does not classify a successful run", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 0,
        stdout: "",
        stderr: "mise ERROR Permission denied",
        durationMs: 100,
      }),
    ).toBeNull();
  });
});
