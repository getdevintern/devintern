import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  MAX_AGENT_OUTPUT_CHARS,
  appendOutputTail,
  executeScheduledAutomation,
} from "../src/lib/scheduled-executor";
import { spawnAutomationProcess } from "../src/lib/automation-acquirer";
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
if (process.env.REQUIRE_AUTOMATION_TEST_ENV === "1" && process.env.AUTOMATION_TEST_ENV !== "propagated") {
  process.exit(7);
}
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

  test("retains a bounded tail of verbose agent output", () => {
    let output = appendOutputTail("prefix", "a".repeat(MAX_AGENT_OUTPUT_CHARS));
    output = appendOutputTail(output, "diagnostic-tail");

    expect(output).toHaveLength(MAX_AGENT_OUTPUT_CHARS);
    expect(output.endsWith("diagnostic-tail")).toBe(true);
    expect(output).not.toContain("prefix");
  });

  test("runs headless and lets create_ticket resolve the PM harness", async () => {
    expect(
      await executeScheduledAutomation({
        automationId: "headless-test",
        action: "headless",
        prompt: "Inspect this repository",
        cwd: dir,
        repo: "test-repo",
      }),
    ).toBe(true);

    const pmConfigDir = join(dir, ".devintern-pm");
    mkdirSync(pmConfigDir, { recursive: true });
    writeFileSync(
      join(pmConfigDir, ".env"),
      [
        "TASK_TRACKER=markdown",
        `MARKDOWN_TASKS_DIR=${join(dir, "tasks")}`,
        "AGENT_HARNESS=codex",
        `AGENT_CLI_PATH=${agentPath}`,
      ].join("\n"),
    );
    process.env.AGENT_CLI_PATH = join(dir, "missing-code-agent");
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

  test("rejects direct internal automation invocation without entitlement", async () => {
    const entrypoint = join(import.meta.dir, "..", "src", "index.ts");
    const unlicensedHome = join(dir, "unlicensed-home");
    mkdirSync(unlicensedHome, { recursive: true });
    const { LICENSE_KEY: _licenseKey, ...unlicensedEnv } = process.env;
    const env = {
      ...unlicensedEnv,
      HOME: unlicensedHome,
      WEBHOOK_QUEUE_DB: dbPath,
      AGENT_HARNESS: "codex",
      AGENT_CLI_PATH: agentPath,
      AGENT_SANDBOX: "none",
      TASK_TRACKER: "markdown",
      MARKDOWN_TASKS_DIR: join(dir, "tasks"),
      REQUIRE_AUTOMATION_TEST_ENV: "1",
      AUTOMATION_TEST_ENV: "propagated",
    };
    const run = spawnAutomationProcess(
      process.execPath,
      [entrypoint, "__automation-run"],
      JSON.stringify({
        id: "subprocess-test",
        action: "headless",
        prompt: "Verify the internal automation subprocess",
        repo: "subprocess-repo",
      }),
      { cwd: dir, env },
    );
    expect(await run.completion).toBe(false);

    const invalidRun = spawnAutomationProcess(
      process.execPath,
      [entrypoint, "__automation-run"],
      "{invalid-json",
      { cwd: dir, env },
    );
    expect(await invalidRun.completion).toBe(false);

    const store = new RunStore(dbPath);
    expect(
      store
        .listRuns({ origin: "scheduled" })
        .find((item) => item.automationId === "subprocess-test"),
    ).toBeUndefined();
    store.close();
  });
});
