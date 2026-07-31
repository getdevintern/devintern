import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  generateWebhookSecret,
  renderSystemdUnit,
  runWorkerInit,
  upsertEnvVars,
} from "../src/lib/worker-init";

describe("upsertEnvVars", () => {
  test("appends new keys under a worker section", () => {
    const result = upsertEnvVars("TASK_TRACKER=jira\n", { WORKER_TASK_QUERY: "status=todo" });
    expect(result).toContain("TASK_TRACKER=jira");
    expect(result).toContain("worker init");
    expect(result).toContain("WORKER_TASK_QUERY=status=todo");
  });

  test("updates existing keys in place without duplicating", () => {
    const result = upsertEnvVars("WORKER_TASK_QUERY=old\nTASK_TRACKER=jira\n", {
      WORKER_TASK_QUERY: "new",
    });
    expect(result).toContain("WORKER_TASK_QUERY=new");
    expect(result).not.toContain("WORKER_TASK_QUERY=old");
    expect(result.match(/WORKER_TASK_QUERY=/g)).toHaveLength(1);
  });

  test("activates commented-out template keys", () => {
    const result = upsertEnvVars("# WEBHOOK_SECRET=your-secret\n", { WEBHOOK_SECRET: "abc" });
    expect(result).toContain("WEBHOOK_SECRET=abc");
    expect(result).not.toContain("# WEBHOOK_SECRET");
  });
});

describe("renderSystemdUnit", () => {
  test("renders working directory, exec, and restart policy", () => {
    const unit = renderSystemdUnit({
      execPath: "/usr/local/bin/devintern",
      projectDir: "/srv/app",
      listen: false,
    });
    expect(unit).toContain("WorkingDirectory=/srv/app");
    expect(unit).toContain("ExecStart=/usr/local/bin/devintern worker\n");
    expect(unit).toContain("Restart=on-failure");
  });

  test("appends --listen when webhook mode is chosen", () => {
    const unit = renderSystemdUnit({ execPath: "devintern", projectDir: "/srv/app", listen: true });
    expect(unit).toContain("ExecStart=devintern worker --listen");
  });
});

describe("generateWebhookSecret", () => {
  test("produces 64 hex chars, unique per call", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe("runWorkerInit", () => {
  let tempDir: string;
  let logs: string[];
  let files: Map<string, string>;
  const savedTracker = process.env.TASK_TRACKER;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-worker-init-"));
    mkdirSync(path.join(tempDir, ".devintern-code"), { recursive: true });
    writeFileSync(path.join(tempDir, ".devintern-code", ".env"), "TASK_TRACKER=markdown\n", "utf8");
    process.env.TASK_TRACKER = "markdown";
    logs = [];
    files = new Map();
  });

  afterEach(() => {
    if (savedTracker === undefined) delete process.env.TASK_TRACKER;
    else process.env.TASK_TRACKER = savedTracker;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(answers: string[], overrides: Partial<Parameters<typeof runWorkerInit>[0]> = {}) {
    return {
      cwd: tempDir,
      log: (m: string) => logs.push(m),
      prompt: async () => answers.shift() ?? "",
      readFile: () => "TASK_TRACKER=markdown\n",
      writeFile: (p: string, content: string) => files.set(p, content),
      ...overrides,
    };
  }

  test("fails when the project is not initialized", async () => {
    const bare = mkdtempSync(path.join(tmpdir(), "devintern-worker-init-bare-"));
    const ok = await runWorkerInit(deps([], { cwd: bare }));
    expect(ok).toBe(false);
    expect(logs.join("\n")).toContain("devintern init");
    rmSync(bare, { recursive: true, force: true });
  });

  test("polling-only happy path writes query and interval", async () => {
    const ok = await runWorkerInit(
      deps(["status=todo", "", "n", "n"], { dryRunQuery: async () => 3 }),
    );
    expect(ok).toBe(true);
    const env = files.get(path.join(tempDir, ".devintern-code", ".env"))!;
    expect(env).toContain("WORKER_TASK_QUERY=status=todo");
    expect(env).toContain("WORKER_POLL_INTERVAL=60");
    expect(env).not.toContain("WEBHOOK_SECRET");
    expect(logs.join("\n")).toContain("3 task(s) match");
  });

  test("webhook mode generates a secret and systemd unit carries --listen", async () => {
    const ok = await runWorkerInit(deps(["status=todo", "120", "y", "y"]));
    expect(ok).toBe(true);
    const env = files.get(path.join(tempDir, ".devintern-code", ".env"))!;
    expect(env).toMatch(/WEBHOOK_SECRET=[0-9a-f]{64}/);
    expect(env).toContain("WORKER_POLL_INTERVAL=120");
    const unit = files.get(path.join(tempDir, ".devintern-code", "devintern-worker.service"))!;
    expect(unit).toContain("--listen");
  });

  test("failing dry run offers a retry then accepts the corrected query", async () => {
    let calls = 0;
    const ok = await runWorkerInit(
      deps(["bad query", "y", "status=todo", "", "n", "n"], {
        dryRunQuery: async (q) => {
          calls++;
          if (q === "bad query") throw new Error("syntax error");
          return 1;
        },
      }),
    );
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    const env = files.get(path.join(tempDir, ".devintern-code", ".env"))!;
    expect(env).toContain("WORKER_TASK_QUERY=status=todo");
  });

  test("license failure is reported but does not abort setup", async () => {
    const ok = await runWorkerInit(
      deps(["status=todo", "", "n", "n"], {
        checkAutomationLicense: async () => "No automation license found.",
      }),
    );
    expect(ok).toBe(true);
    expect(logs.join("\n")).toContain("No automation license found.");
    expect(logs.join("\n")).toContain("devintern.com/pricing");
  });

  test("refuses trackers without polling support", async () => {
    process.env.TASK_TRACKER = "not-a-tracker";
    const ok = await runWorkerInit(deps([]));
    expect(ok).toBe(false);
    expect(logs.join("\n")).toContain("does not support worker polling");
  });
});
