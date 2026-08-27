import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import {
  generateWebhookSecret,
  renderLaunchdPlist,
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

  test("uses the canonical webhook command when webhook mode is chosen", () => {
    const unit = renderSystemdUnit({ execPath: "devintern", projectDir: "/srv/app", listen: true });
    expect(unit).toContain("ExecStart=devintern webhook serve");
  });
});

describe("renderLaunchdPlist", () => {
  test("renders a user agent with escaped paths and restart behavior", () => {
    const plist = renderLaunchdPlist({
      execPath: "/Applications/Dev & Intern/devintern",
      workingDir: "/Users/dev/Dev & Intern",
    });
    expect(plist).toContain("com.devintern.worker");
    expect(plist).toContain("/Applications/Dev &amp; Intern/devintern");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
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
  let workspaceDir: string;
  let logs: string[];
  const savedTracker = process.env.TASK_TRACKER;
  const savedWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-worker-init-"));
    workspaceDir = path.join(tempDir, "workspace");
    mkdirSync(path.join(tempDir, ".devintern-code"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(tempDir, ".devintern-code", ".env"), "TASK_TRACKER=markdown\n", "utf8");
    writeFileSync(path.join(workspaceDir, "workspace.toml"), '[defaults]\ntracker = "markdown"\n');
    process.env.TASK_TRACKER = "markdown";
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    logs = [];
  });

  afterEach(() => {
    if (savedTracker === undefined) delete process.env.TASK_TRACKER;
    else process.env.TASK_TRACKER = savedTracker;
    if (savedWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspace;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(answers: string[], overrides: Partial<Parameters<typeof runWorkerInit>[0]> = {}) {
    const queued = [...answers, "n", "n"];
    return {
      cwd: tempDir,
      log: (m: string) => logs.push(m),
      prompt: async () => queued.shift() ?? "n",
      ensureTracker: async () => "markdown",
      bootstrapWorkspace: async () => ({ workspaceDir }),
      ...overrides,
    };
  }

  test("fails when tracker setup does not finish", async () => {
    const result = await runWorkerInit(deps([], { ensureTracker: async () => null }));
    expect(result.ok).toBe(false);
    expect(logs.join("\n")).toContain("Tracker setup did not finish");
  });

  test("writes task_query to workspace.toml, not WORKER_TASK_QUERY", async () => {
    const result = await runWorkerInit(deps(["status=todo"], { dryRunQuery: async () => 3 }));
    expect(result.ok).toBe(true);
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("status=todo");
    expect(config.defaults.tracker).toBe("markdown");
    const env = readFileSync(path.join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).not.toContain("WORKER_TASK_QUERY");
    expect(logs.join("\n")).toContain("3 task(s) match");
    expect(logs.join("\n")).not.toContain("webhook listener");
  });

  test("failing dry run offers a retry then accepts the corrected query", async () => {
    let calls = 0;
    const result = await runWorkerInit(
      deps(["bad query", "y", "status=todo"], {
        dryRunQuery: async (q) => {
          calls++;
          if (q === "bad query") throw new Error("syntax error");
          return 1;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
    expect(config.defaults.taskQuery).toBe("status=todo");
  });

  test("license failure is reported but does not abort setup", async () => {
    const result = await runWorkerInit(
      deps(["status=todo"], {
        checkAutomationLicense: async () => "No automation license found.",
      }),
    );
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("No automation license found.");
    expect(logs.join("\n")).toContain("devintern.com/pricing");
  });

  test("refuses trackers without polling support", async () => {
    const result = await runWorkerInit(deps([], { ensureTracker: async () => "not-a-tracker" }));
    expect(result.ok).toBe(false);
    expect(logs.join("\n")).toContain("does not support worker polling");
  });

  test("connects signed-in users and stores relay state in the workspace", async () => {
    const calls: Array<{ workspaceDir: string; trackerType: string }> = [];
    const result = await runWorkerInit(
      deps(["status=todo", "", "n"], {
        getUser: async () => ({ id: "user-1", email: "dev@example.com" }),
        connectRelay: async ({ workspaceDir: dir, trackerType }) => {
          calls.push({ workspaceDir: dir, trackerType });
          return true;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ workspaceDir, trackerType: "markdown" }]);
    expect(logs.join("\n")).toContain("Relay pairing stored");
  });

  test("writes a Linux user service definition", async () => {
    const files = new Map<string, string>();
    const result = await runWorkerInit(
      deps(["status=todo", "n", ""], {
        platform: "linux",
        execPath: "/usr/local/bin/devintern",
        writeFile: (file, content) => files.set(file, content),
      }),
    );
    expect(result.ok).toBe(true);
    const unit = files.get(path.join(workspaceDir, "devintern-worker.service"));
    expect(unit).toContain("WorkingDirectory=" + workspaceDir);
    expect(unit).toContain("ExecStart=/usr/local/bin/devintern worker");
  });

  test("writes a macOS launchd agent", async () => {
    const files = new Map<string, string>();
    const result = await runWorkerInit(
      deps(["status=todo", "n", ""], {
        platform: "darwin",
        execPath: "/usr/local/bin/devintern",
        writeFile: (file, content) => files.set(file, content),
      }),
    );
    expect(result.ok).toBe(true);
    const plist = files.get(path.join(workspaceDir, "com.devintern.worker.plist"));
    expect(plist).toContain("<string>/usr/local/bin/devintern</string>");
    expect(plist).toContain(`<string>${workspaceDir}</string>`);
  });

  test("finds tracker config from a repository subdirectory", async () => {
    mkdirSync(path.join(tempDir, ".git"));
    const subdir = path.join(tempDir, "packages", "app");
    mkdirSync(subdir, { recursive: true });
    const result = await runWorkerInit(
      deps(["status=todo"], {
        cwd: subdir,
        ensureTracker: undefined,
      }),
    );
    expect(result.ok).toBe(true);
  });
});
