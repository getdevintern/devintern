/**
 * A webhook review spawn must leave a durable harness log that the dashboard
 * attributes to the run the review pipeline opened.
 *
 * `resolveActiveHarness` and `getSandbox` are the only stubs: the real
 * `runAgentHarnessForReview` reads the prompt, spawns a probe executable
 * (`/bin/echo`), and attaches the real harness-log sink. The run is opened the
 * same way `review-pipeline.ts` opens it (`beginRun({ origin: "pr_mention" })`)
 * and then read back through the dashboard surface.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarness } from "@devintern/agent-harness";

const realRuntime = { ...(await import("../src/lib/webhook/runtime")) };
const realSandbox = { ...(await import("../src/lib/agent/sandbox")) };

const fakeHarness = {
  name: "probe",
  displayName: "Probe",
  supportsMaxTurns: false,
  buildArgs: () => [],
} as unknown as AgentHarness;

mock.module("../src/lib/webhook/runtime", () => ({
  ...realRuntime,
  resolveActiveHarness: () => ({ harness: fakeHarness, path: "/bin/echo" }),
}));
mock.module("../src/lib/agent/sandbox", () => ({ ...realSandbox, getSandbox: async () => null }));

const { runAgentHarnessForReview } = await import("../src/lib/webhook/agent-review");
const { beginRun, endRun, getActiveRunContext } = await import("../src/lib/state/run-recorder");
const { DashboardData } = await import("../src/lib/observability/dashboard-api");
const { resolveQueueDbPath } = await import("../src/lib/state/webhook-queue");

afterAll(() => {
  mock.module("../src/lib/webhook/runtime", () => ({ ...realRuntime }));
  mock.module("../src/lib/agent/sandbox", () => ({ ...realSandbox }));
});

describe("webhook review harness log attribution", () => {
  let root: string;
  let promptFile: string;
  let savedWorkspace: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "review-harness-log-"));
    savedWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = root;
    delete process.env.DEVINTERN_HARNESS_LOGS;
    promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "please address the review feedback", "utf8");
  });

  afterEach(() => {
    if (savedWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspace;
    rmSync(root, { recursive: true, force: true });
  });

  test("leaves a run whose harness log the dashboard can list", async () => {
    beginRun({ origin: "pr_mention", repo: "o/r", prNumber: 7, harness: fakeHarness.name });
    const active = getActiveRunContext();
    expect(active).not.toBeNull();

    try {
      const result = await runAgentHarnessForReview(promptFile, root);
      expect(result.success).toBe(true);
    } finally {
      endRun("succeeded");
    }

    const data = new DashboardData({ dbPath: resolveQueueDbPath(), workingDir: root });
    try {
      const logs = data.listRunHarnessLogs(active!.id);
      expect(logs.length).toBe(1);
      expect(logs[0]?.origin).toBe("pr_mention");
      expect(logs[0]?.label).toBe("review");
      expect(logs[0]?.runId).toBe(active!.id);
    } finally {
      data.close();
    }
  });
});
