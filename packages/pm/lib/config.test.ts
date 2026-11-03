import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "./config";
import { extractHarnessFlags } from "./parse-args";

describe("loadConfig harness resolution", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "pm-config-test-"));
    mkdirSync(join(testDir, ".devintern-pm"));
    writeFileSync(join(testDir, ".devintern-pm", ".env"), "TASK_TRACKER=markdown\n");
    process.chdir(testDir);

    delete process.env.AGENT_CLI_PATH;
    delete process.env.OPENCODE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.AGENT_HARNESS;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  function writeExecutable(path: string): void {
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  }

  test("--harness resolves harness name and CLI path over AGENT_CLI_PATH", async () => {
    const globalCli = join(testDir, "global-agent");
    const opencodeCli = join(testDir, "opencode-cli");
    writeExecutable(globalCli);
    writeExecutable(opencodeCli);

    process.env.AGENT_CLI_PATH = globalCli;
    process.env.OPENCODE_CLI_PATH = opencodeCli;

    const { harness } = extractHarnessFlags(["--prompt", "x", "--harness", "opencode"]);
    expect(harness).toBe("opencode");

    const config = await loadConfig({ harnessName: harness, baseDir: testDir });
    expect(config.agent.harness.name).toBe("opencode");
    expect(config.agent.path).toBe(opencodeCli);
  });
});

describe("loadConfig workspace env fallback", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let testDir: string;
  let workspaceDir: string;

  const trackerKeys = [
    "TASK_TRACKER",
    "MARKDOWN_TASKS_DIR",
    "JIRA_BASE_URL",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "JIRA_DEFAULT_PROJECT_KEY",
  ];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "pm-config-workspace-test-"));
    workspaceDir = join(testDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.chdir(testDir);
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    delete process.env.DEVINTERN_WORKER_SUBPROCESS;
    delete process.env.AGENT_CLI_PATH;
    delete process.env.OPENCODE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.AGENT_HARNESS;
    for (const key of trackerKeys) delete process.env[key];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  function writeExecutable(path: string): void {
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  }

  test("CLI fallback resolves tracker config from the workspace .env", async () => {
    const cli = join(testDir, "agent");
    writeExecutable(cli);
    process.env.AGENT_CLI_PATH = cli;
    writeFileSync(join(workspaceDir, ".env"), "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=.tasks\n");

    const config = await loadConfig({ baseDir: testDir, workspaceEnvFallback: true });

    expect(config.backend.type).toBe("markdown");
    expect(config.backend.directory).toBe(".tasks");
  });

  test("legacy loadConfig(projectDir) does not adopt the workspace .env", async () => {
    const cli = join(testDir, "agent");
    writeExecutable(cli);
    process.env.AGENT_CLI_PATH = cli;
    writeFileSync(join(workspaceDir, ".env"), "TASK_TRACKER=markdown\n");

    await expect(loadConfig(testDir)).rejects.toThrow(/Missing required environment variables/);
  });
});
