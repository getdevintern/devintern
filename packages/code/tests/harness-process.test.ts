import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AgentLaunchError,
  isFallbackEligible,
  executableMissingError,
  spawnFailedError,
  exitClassificationError,
} from "../src/lib/harness-launch";
import { runCapturedAgentProcess } from "../src/lib/harness-process";

/**
 * Integration-style coverage for the shared spawn lifecycle used by the
 * CLI's three launch sites (clarity check, estimation, implementation).
 *
 * `src/index.ts` cannot be imported from tests (it parses argv at module
 * load), so its exact spawn-site wiring was extracted into
 * {@link runCapturedAgentProcess} / {@link exitClassificationError}; these
 * tests exercise that wiring against real stub executables.
 */

let workDir: string;
let scriptCounter = 0;

/** Create an executable stub that emits the given streams and exit code. */
function writeStubScript(body: string): string {
  scriptCounter += 1;
  const path = join(workDir, `stub-${scriptCounter}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const MEANINGFUL_WORK_OUTPUT =
  "Implemented the OAuth device flow end to end: created src/auth/device-flow.ts with a " +
  "startDeviceAuthorization() helper, wired the token exchange into the session store, and " +
  "extended the unit tests to cover polling timeouts and credential refresh handling paths.";

async function launch(stubPath: string, extraOptions = {}) {
  return runCapturedAgentProcess({
    displayName: "Stub CLI",
    executablePath: stubPath,
    args: [],
    exitSubject: "Agent",
    timeoutMinutes: 60,
    timeoutMessage: "Stub CLI timed out after 60 minutes",
    ...extraOptions,
  });
}

describe("runCapturedAgentProcess", () => {
  let originalRetries: string | undefined;

  beforeEach(() => {
    originalRetries = process.env.AGENT_SPAWN_ENOENT_RETRIES;
    // Skip the auto-update-swap retry backoff for nonexistent test binaries.
    process.env.AGENT_SPAWN_ENOENT_RETRIES = "0";
    workDir = mkdtempSync("/tmp/opencode/harness-process-");
    scriptCounter = 0;
  });

  afterEach(() => {
    if (originalRetries === undefined) {
      delete process.env.AGENT_SPAWN_ENOENT_RETRIES;
    } else {
      process.env.AGENT_SPAWN_ENOENT_RETRIES = originalRetries;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  test("zero exit resolves with captured stdout/stderr", async () => {
    const stub = writeStubScript(`echo "assessment json"; echo "diag" >&2; exit 0`);
    const run = await launch(stub);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("assessment json");
    expect(run.stderr).toContain("diag");
  });

  test("ENOENT rejects with an executable-missing AgentLaunchError", async () => {
    const missing = join(workDir, "does-not-exist");
    let error: unknown;
    try {
      await launch(missing);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentLaunchError);
    const launchError = error as AgentLaunchError;
    expect(launchError.classification).toBe("executable-missing");
    expect(isFallbackEligible(launchError.classification)).toBe(true);
    expect(launchError.message).toContain("Stub CLI CLI not found at:");
  });

  test("non-ENOENT spawn failure rejects as spawn-failed", async () => {
    const notExecutable = join(workDir, "not-executable.sh");
    writeFileSync(notExecutable, "#!/bin/sh\necho nope\n", "utf8");
    chmodSync(notExecutable, 0o644);

    let error: unknown;
    try {
      await launch(notExecutable);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentLaunchError);
    const launchError = error as AgentLaunchError;
    expect(launchError.classification).toBe("spawn-failed");
    expect(isFallbackEligible(launchError.classification)).toBe(true);
  });

  test("exit 1 with an auth error classifies as auth-failed and stays fallback eligible", async () => {
    const stub = writeStubScript(`echo "error: Invalid API key provided" >&2; exit 1`);
    let error: unknown;
    try {
      await launch(stub);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentLaunchError);
    const launchError = error as AgentLaunchError;
    expect(launchError.classification).toBe("auth-failed");
    expect(isFallbackEligible(launchError.classification)).toBe(true);
    expect(launchError.message).toBe("Agent exited with code 1");
    expect(launchError.exitCode).toBe(1);
    expect(launchError.stderr).toContain("Invalid API key");
  });

  test("exit 3 after meaningful output is a plain error that never falls back", async () => {
    const stub = writeStubScript(`printf '%s\\n' '${MEANINGFUL_WORK_OUTPUT}'; exit 3`);
    let error: unknown;
    try {
      await launch(stub);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentLaunchError);
    expect((error as Error).message).toBe("Agent exited with code 3");
    expect((error as Error & { classification?: string }).classification).toBeUndefined();
  });

  test("mid-work transcripts mentioning auth vocabulary do not fall back", async () => {
    // Regression for review iteration 2, item 1: this output matches the auth
    // vocabulary patterns, but the match sits after meaningful task content,
    // so the exit must be treated as post-work rather than auth-failed.
    const transcript =
      `${MEANINGFUL_WORK_OUTPUT}\n` +
      "Docs note that users see a You-need-to-log-in-to-the-API prompt whenever a stored " +
      "token is invalid so the UI can prompt for re-authentication.";
    const stub = writeStubScript(`printf '%s\\n' '${transcript}'; exit 1`);

    let error: unknown;
    try {
      await launch(stub);
    } catch (caught) {
      error = caught;
    }
    expect(error).not.toBeInstanceOf(AgentLaunchError);
    expect((error as Error).message).toBe("Agent exited with code 1");
  });

  test("stage labels shape spawn-failure messages per site", async () => {
    const notExecutable = join(workDir, "not-executable-clarity.sh");
    writeFileSync(notExecutable, "#!/bin/sh\necho nope\n", "utf8");
    chmodSync(notExecutable, 0o644);
    await expect(
      runCapturedAgentProcess({
        displayName: "Codex",
        executablePath: notExecutable,
        args: [],
        stageLabel: "clarity check",
        exitSubject: "Agent clarity check",
        timeoutMinutes: 60,
        timeoutMessage: "Codex clarity check timed out after 60 minutes",
      }),
    ).rejects.toThrow("Failed to run Codex clarity check:");
  });
});

describe("exitClassificationError", () => {
  test("eligible classes become fallback-capable AgentLaunchErrors", () => {
    const error = exitClassificationError("Agent exited with code 2", "", "Not logged in", 2);
    expect(error).toBeInstanceOf(AgentLaunchError);
    expect((error as AgentLaunchError).classification).toBe("auth-failed");
    expect((error as AgentLaunchError).exitCode).toBe(2);
    expect(isFallbackEligible((error as AgentLaunchError).classification)).toBe(true);
  });

  test("post-work exits stay plain errors outside the fallback chain", () => {
    const error = exitClassificationError(
      "Agent exited with code 7",
      MEANINGFUL_WORK_OUTPUT,
      "",
      7,
    );
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe("Agent exited with code 7");
  });
});

describe("launch error factories", () => {
  test("executable-missing and spawn-failed factories keep their classes", () => {
    expect(executableMissingError("nope").classification).toBe("executable-missing");
    const spawnError = spawnFailedError("boom", "EACCES");
    expect(spawnError.classification).toBe("spawn-failed");
    expect(spawnError.stderr).toBe("EACCES");
  });
});
