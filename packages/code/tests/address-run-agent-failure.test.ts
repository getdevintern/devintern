/**
 * `runAgent` must carry the harness failure through to `assertAgentSucceeded`.
 *
 * The reported Sentry issue was a bare "Agent failed to complete successfully"
 * for a run that never started (a spawn error such as `E2BIG`). Stub the
 * harness spawn so the error path is exercised without invoking a real CLI.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AgentHarness } from "@devintern/agent-harness";

const realHarness = { ...(await import("@devintern/agent-harness")) };
const realSpawn = { ...(await import("../src/lib/agent/spawn")) };
const realSandbox = { ...(await import("../src/lib/agent/sandbox")) };
const realHarnessLogs = { ...(await import("../src/lib/observability/harness-logs")) };

const fakeHarness = {
  name: "probe",
  displayName: "Probe",
  supportsMaxTurns: false,
  buildArgs: () => [],
} as unknown as AgentHarness;

interface Scenario {
  spawnError?: Error;
  code: number | null;
  stdout?: string;
  stderr?: string;
}

let scenario: Scenario = { code: 0 };

/** Build a child stand-in that emits the configured outcome on the next tick. */
function makeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, { stdout, stderr, killed: false });

  setTimeout(() => {
    if (scenario.spawnError) {
      child.emit("error", scenario.spawnError);
      return;
    }
    if (scenario.stdout) stdout.emit("data", Buffer.from(scenario.stdout));
    if (scenario.stderr) stderr.emit("data", Buffer.from(scenario.stderr));
    child.emit("close", scenario.code);
  }, 0);

  return child;
}

mock.module("@devintern/agent-harness", () => ({
  ...realHarness,
  resolveHarness: () => ({ harness: fakeHarness, path: "/bin/true" }),
  resolveExecutablePathWithRetry: async () => "/bin/true",
  spawnAgent: async () => ({ child: makeChild(), cleanup: async () => {} }),
}));
mock.module("../src/lib/agent/spawn", () => ({
  ...realSpawn,
  buildHeadlessAgentInvocation: async () => ({ args: [], env: {} }),
  harnessSpawnEnv: () => ({}),
}));
mock.module("../src/lib/agent/sandbox", () => ({
  ...realSandbox,
  getSandbox: async () => null,
}));
mock.module("../src/lib/observability/harness-logs", () => ({
  ...realHarnessLogs,
  createHarnessLogSink: () => null,
}));

const { runAgent } = await import("../src/lib/review/address");

afterAll(() => {
  mock.module("@devintern/agent-harness", () => ({ ...realHarness }));
  mock.module("../src/lib/agent/spawn", () => ({ ...realSpawn }));
  mock.module("../src/lib/agent/sandbox", () => ({ ...realSandbox }));
  mock.module("../src/lib/observability/harness-logs", () => ({ ...realHarnessLogs }));
});

describe("runAgent failure details", () => {
  test("keeps a spawn failure such as E2BIG instead of discarding it", async () => {
    scenario = {
      spawnError: Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }),
      code: 0,
    };

    const result = await runAgent("address this review", "/tmp", false);

    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("E2BIG");
    expect(result.output).toContain("E2BIG");
  });

  test("reports a non-zero exit code and the captured stderr", async () => {
    scenario = { code: 1, stderr: "Error: unknown option --dir\n" };

    const result = await runAgent("address this review", "/tmp", false);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("exited with code 1");
    expect(result.output).toContain("unknown option");
  });

  test("omits a failure reason when the harness exits cleanly", async () => {
    scenario = { code: 0, stdout: "done\n" };

    const result = await runAgent("address this review", "/tmp", false);

    expect(result.success).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });
});
