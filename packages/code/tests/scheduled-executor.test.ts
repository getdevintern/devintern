import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { executeScheduledAutomation } from "../src/lib/scheduled-executor";
import { RunStore } from "../src/lib/run-recorder";

describe("executeScheduledAutomation", () => {
  const dir = join(tmpdir(), `scheduled-executor-${Date.now()}-${Math.random()}`);
  const dbPath = join(dir, "queue.db");
  const agentPath = join(dir, "fake-agent.ts");
  const previous: Record<string, string | undefined> = {};

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      agentPath,
      `#!/usr/bin/env bun
console.log(JSON.stringify({
  summary: "Scheduled maintenance story",
  description: "A sufficiently detailed generated description for the scheduled executor test. It is deliberately longer than one hundred characters so the headless completion detector treats this successful fake-agent response as substantive output."
}));
`,
    );
    chmodSync(agentPath, 0o755);
    for (const key of [
      "WEBHOOK_QUEUE_DB",
      "AGENT_HARNESS",
      "AGENT_CLI_PATH",
      "AGENT_SANDBOX",
      "TASK_TRACKER",
      "MARKDOWN_TASKS_DIR",
    ]) {
      previous[key] = process.env[key];
    }
    process.env.WEBHOOK_QUEUE_DB = dbPath;
    process.env.AGENT_HARNESS = "codex";
    process.env.AGENT_CLI_PATH = agentPath;
    process.env.AGENT_SANDBOX = "none";
    process.env.TASK_TRACKER = "markdown";
    process.env.MARKDOWN_TASKS_DIR = join(dir, "tasks");
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs both headless and create_ticket actions with scheduled records", async () => {
    expect(
      await executeScheduledAutomation({
        automationId: "headless-test",
        action: "headless",
        prompt: "Inspect this repository",
        cwd: dir,
        repo: "test-repo",
      }),
    ).toBe(true);
    expect(
      await executeScheduledAutomation({
        automationId: "ticket-test",
        action: "create_ticket",
        prompt: "Draft maintenance work",
        trackerProject: "ignored-by-markdown",
        cwd: dir,
      }),
    ).toBe(true);

    const store = new RunStore(dbPath);
    const runs = store.listRuns({ origin: "scheduled" });
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(runs.find((run) => run.automationId === "ticket-test")?.ticketKey).toBeTruthy();
    store.close();
  });
});
