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
