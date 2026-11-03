import { describe, expect, test } from "bun:test";

import {
  describeAgentExitFailure,
  detectHarnessStartupFailure,
} from "../src/lib/agent/harness-startup";

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

  test("classifies a nested nono session-state failure regardless of the OS error wording", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      // A second nono layer cannot create its audit state under the outer
      // confinement and exits before the agent starts.
      stderr:
        "nono: Snapshot error: Failed to create session directory " +
        "/home/user/.local/state/nono/audit/abc123: Read-only file system (os error 30)",
      durationMs: 10_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("nono: Snapshot error");
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

describe("describeAgentExitFailure", () => {
  test("prefers the last failure-shaped stderr line over routine progress output", () => {
    expect(
      describeAgentExitFailure(
        "working...\n",
        "warning: retrying\nfatal: remote rejected the push\n",
      ),
    ).toBe("fatal: remote rejected the push");
  });

  test("falls back to stderr then stdout when no line names a failure", () => {
    expect(describeAgentExitFailure("", "agent stopped\n")).toBe("agent stopped");
    expect(describeAgentExitFailure("agent stopped\n", "")).toBe("agent stopped");
  });

  test("strips ANSI sequences and truncates long reasons", () => {
    expect(describeAgentExitFailure("", "\u001b[31mfatal: boom\u001b[0m\n")).toBe("fatal: boom");
    const long = `error: ${"x".repeat(400)}`;
    const reason = describeAgentExitFailure("", long, 20);
    expect(reason).toBe(`error: ${"x".repeat(13)}…`);
    expect(reason?.length).toBe(21);
  });

  test("returns undefined when the agent produced no output", () => {
    expect(describeAgentExitFailure("", "")).toBeUndefined();
    expect(describeAgentExitFailure("\n \r\n", "\n")).toBeUndefined();
  });
});
