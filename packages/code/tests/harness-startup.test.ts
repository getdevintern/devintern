import { describe, expect, test } from "bun:test";

import { DeepSeekHarness, buildHarnessInvocation } from "@devintern/agent-harness";

import {
  HarnessUnavailableError,
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

  test("classifies EACCES and ENOENT", () => {
    for (const stderr of ["spawn grok EACCES", "spawn grok ENOENT"]) {
      expect(
        detectHarnessStartupFailure({ exitCode: 1, stdout: "", stderr, durationMs: 50 })
          ?.unavailable,
      ).toBe(true);
    }
  });

  test("classifies DeepSeek Harness headless credential failures", () => {
    for (const stderr of [
      "dsh: MISSING_CREDENTIAL: no credential for provider deepseek\n",
      "dsh: UNAUTHORIZED: provider rejected the API key\n",
      "dsh: INVALID_API_KEY: check DEEPSEEK_API_KEY\n",
    ]) {
      const result = detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "",
        stderr,
        durationMs: 10_000,
      });
      expect(result?.unavailable).toBe(true);
      expect(result?.reason).toContain("dsh:");
    }
  });

  test("ignores dsh reasoning lines when choosing the failure reason", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr:
        "dsh: reasoning: inspecting the workspace\n" +
        "dsh: EACCES: permission denied writing $DSH_HOME/profiles/headless\n",
      durationMs: 10_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("EACCES");
    expect(result?.reason).not.toContain("reasoning:");
  });

  test("does not treat sandbox phrases inside dsh reasoning as startup failures", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "",
        stderr:
          "dsh: reasoning:\n" +
          "The sandbox setup failed earlier, retrying normally\n" +
          "implementation failed on purpose\n",
        durationMs: 30_000,
      }),
    ).toBeNull();
  });

  test("prefers the dsh credential error over reasoning text", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr:
        "dsh: reasoning: the command failed to run\n" +
        "sandbox setup problem\n" +
        "dsh: INVALID_CREDENTIAL: provider rejected the API key\n",
      durationMs: 10_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("dsh: INVALID_CREDENTIAL:");
    expect(result?.reason).not.toContain("reasoning:");
  });

  test("still reports a real startup error after a long dsh reasoning section", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr:
        "dsh: reasoning:\n" +
        "thinking about ENOENT and sandbox setup failures\n" +
        "dsh: MISSING_CREDENTIAL: no credential for provider deepseek\n",
      durationMs: 30_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("MISSING_CREDENTIAL");
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

  test("keeps ordinary dsh task-time error codes as a normal failure", () => {
    for (const code of ["INVALID_ARGUMENT", "INVALID_REQUEST", "authentication refreshed"]) {
      expect(
        detectHarnessStartupFailure({
          exitCode: 1,
          stdout: "I implemented most of the feature.\n",
          stderr: `dsh: session: 123\ndsh: ${code}: something went wrong\n`,
          durationMs: 240_000,
        }),
      ).toBeNull();
    }
  });

  test("keeps a dsh credential error after real work as a normal failure", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "Partial implementation committed.\n",
        stderr: "dsh: UNAUTHORIZED: provider rejected the API key\n",
        durationMs: 240_000,
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

  test("a stale Reasonix path is deferrable as HarnessUnavailableError", async () => {
    // The invocation guard runs before any spawn; the task pipeline only
    // defers/fails over when this is an instance of the shared class.
    const error = (await buildHarnessInvocation(
      new DeepSeekHarness(),
      "/nonexistent/reasonix",
      {},
    ).catch((thrown: unknown) => thrown)) as Error;
    expect(error).toBeInstanceOf(HarnessUnavailableError);
    expect(error.name).toBe("HarnessUnavailableError");
  });
});
