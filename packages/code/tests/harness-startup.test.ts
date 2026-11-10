import { describe, expect, test } from "bun:test";

import {
  describeAgentExitFailure,
  detectHarnessStartupFailure,
  redactAgentOutput,
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

  test("does not mistreat a compiler diagnostic that names a landlock symbol", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        // No stdout and an exit inside the startup window, so the gate is open
        // and the compiler-diagnostic filter is the only reason this is not a
        // landlock startup failure.
        stdout: "",
        stderr: "src/sandbox.c:42:5: error: use of undeclared identifier 'landlock_ruleset'",
        durationMs: 5_000,
      }),
    ).toBeNull();
  });

  test("does not mistreat a compiler diagnostic whose path contains a space", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "",
        stderr:
          "/Users/John Smith/project/src/sandbox.c:42:5: error: landlock operation not permitted",
        durationMs: 5_000,
      }),
    ).toBeNull();
  });

  test("still classifies the same wording without a compiler-diagnostic prefix", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "error: landlock operation not permitted",
      durationMs: 5_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("landlock");
  });

  test("does not treat mid-run landlock output as a startup failure", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "✓ other tests\n✗ sandbox landlock ruleset failed to apply",
        stderr: "",
        durationMs: 20 * 60 * 1000,
      }),
    ).toBeNull();
  });

  test("does not treat a mid-run landlock diagnostic on stderr as a startup failure", () => {
    // Build/test tools write diagnostics to stderr while stdout stays empty;
    // that is still agent work, not a harness start failure.
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "",
        stderr: "test landlock_ruleset ... sandbox landlock ruleset failed to apply",
        durationMs: 20 * 60 * 1000,
      }),
    ).toBeNull();
  });

  test("reports the startup line that matched instead of the first stdout line", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "booting harness\nnono: path_not_granted: /home/user/.local/share/mise",
      stderr: "",
      durationMs: 5_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("path_not_granted");
  });

  test("does not mistreat a mid-run nono session failure as a startup failure", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "working for 20 minutes",
        stderr: "nono: session audit log write failed",
        durationMs: 20 * 60 * 1000,
      }),
    ).toBeNull();
  });

  test("gates generic OS errors on the 30s startup window", () => {
    const cases = [
      "Error: spawn failed\ncode: 'ENOENT'",
      "npm ERR! EACCES: permission denied",
      "mise ERROR Failed to install npm:@xai-official/grok: Permission denied (os error 13)",
      "fork/exec /home/user/.local/share/mise/shims/nono: Permission denied (os error 13)",
    ];
    for (const stderr of cases) {
      // Inside the window the same wording is still a harness startup failure.
      expect(
        detectHarnessStartupFailure({ exitCode: 1, stdout: "", stderr, durationMs: 500 })
          ?.unavailable,
      ).toBe(true);
      // After 20 minutes of agent work the same line is ordinary task output:
      // reclassifying it would swallow the real failure and defer the task.
      expect(
        detectHarnessStartupFailure({
          exitCode: 1,
          stdout: "working for 20 minutes",
          stderr,
          durationMs: 20 * 60 * 1000,
        }),
      ).toBeNull();
    }
  });

  test("does not classify a compiler diagnostic that fails the agent within 2s", () => {
    expect(
      detectHarnessStartupFailure({
        exitCode: 1,
        stdout: "",
        stderr: "src/sandbox.c:42:5: error: use of undeclared identifier 'landlock_ruleset'",
        durationMs: 1_200,
      }),
    ).toBeNull();
  });

  test("still classifies a fast non-zero exit with no output", () => {
    expect(
      detectHarnessStartupFailure({ exitCode: 2, stdout: "", stderr: "", durationMs: 500 }),
    ).not.toBeNull();
  });

  test("still classifies a genuine landlock runtime failure", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "landlock: failed to apply ruleset: Operation not permitted",
      durationMs: 120,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("landlock");
  });

  test("gates landlock/nono signals on the 30s startup window", () => {
    const signals = {
      exitCode: 1,
      stdout: "",
      stderr: "landlock: failed to apply ruleset: Operation not permitted",
    };
    expect(detectHarnessStartupFailure({ ...signals, durationMs: 30_000 })?.unavailable).toBe(true);
    // Past the window a stderr-only mention is indistinguishable from mid-run
    // test/build output, so it stays an ordinary task failure.
    expect(detectHarnessStartupFailure({ ...signals, durationMs: 30_001 })).toBeNull();
  });

  test("classifies a landlock startup failure that printed a banner and exited slowly", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "Starting agent...\n",
      stderr: "landlock: failed to apply ruleset: Operation not permitted",
      durationMs: 5_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("landlock");
  });

  test("classifies a banner-prefixed nono session failure after 2s", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "Starting agent...\n",
      stderr:
        "nono: Snapshot error: Failed to create session directory /tmp/x: Read-only file system",
      durationMs: 5_000,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).toContain("nono: Snapshot error");
  });

  test("redacts credentials carried into a startup failure reason", () => {
    const result = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "mise ERROR AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE Permission denied",
      durationMs: 150,
    });
    expect(result?.unavailable).toBe(true);
    expect(result?.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result?.reason).toContain("[redacted]");
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

describe("redactAgentOutput", () => {
  test("masks GitLab and Google tokens whose final character is - or _", () => {
    const tokens = [
      `glpat-${"a".repeat(19)}-`,
      `glpat-${"a".repeat(19)}_`,
      `AIza${"a".repeat(34)}-`,
      `AIza${"a".repeat(34)}_`,
    ];
    for (const token of tokens) {
      expect(redactAgentOutput(`token ${token}`)).toBe("token [redacted]");
    }
  });

  test("still masks ordinary GitLab and npm tokens", () => {
    expect(redactAgentOutput(`glpat-${"a".repeat(20)}`)).toBe("[redacted]");
    expect(redactAgentOutput(`npm_${"a".repeat(36)}`)).toBe("[redacted]");
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

  test("redacts credentials that the agent printed before failing", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const reason = describeAgentExitFailure("", `error: failed to push using token ${token}\n`);
    expect(reason).not.toContain(token);
    expect(reason).toContain("[redacted]");
  });

  test("redacts AWS keys and JSON password fields echoed by the agent", () => {
    const aws = describeAgentExitFailure(
      "",
      "error: AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE denied\n",
    );
    expect(aws).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(aws).toContain("[redacted]");

    const json = describeAgentExitFailure(
      "",
      'error: {"password": "hunter2", "apiKey": "s3cr3t"}\n',
    );
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("s3cr3t");
    expect(json).toContain("[redacted]");
  });

  test("never returns bare key material as the failure reason", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    // A lone PEM body line has no BEGIN/END marker, so marker-based redaction
    // cannot match it: it must be rejected outright.
    expect(describeAgentExitFailure("", `${body}\n`)).toBeUndefined();
    // The line before it is the actionable one.
    expect(describeAgentExitFailure("", `fatal: authentication failed\n${body}\n`)).toBe(
      "fatal: authentication failed",
    );
    // Inline key material is masked rather than emitted.
    expect(describeAgentExitFailure("", `error: ${body}\n`)).not.toContain("MIIEvQ");
    // A long prose line is not key material: whitespace keeps it selectable.
    const prose = "error: the agent could not resolve the dependency graph because of network";
    expect(describeAgentExitFailure("", `${prose}\n`)).toBe(prose);
  });
});
