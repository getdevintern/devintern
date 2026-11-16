import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "./config";
import { extractHarnessFlags } from "./parse-args";

describe("loadConfig harness resolution", () => {
  const originalEnv = { ...process.env };
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "pm-config-test-"));
    mkdirSync(join(testDir, ".devintern-pm"));
    writeFileSync(join(testDir, ".devintern-pm", ".env"), "TASK_TRACKER=markdown\n");

    delete process.env.AGENT_CLI_PATH;
    delete process.env.OPENCODE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.AGENT_HARNESS;
    delete process.env.GROK_CLI_PATH;
  });

  afterEach(() => {
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

  test("multi-entry AGENT_HARNESS carries fallbacks with their own CLI paths", async () => {
    const globalCli = join(testDir, "global-agent");
    const grokCli = join(testDir, "grok-cli");
    writeExecutable(globalCli);
    writeExecutable(grokCli);
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.AGENT_CLI_PATH = globalCli;
    process.env.GROK_CLI_PATH = grokCli;

    const config = await loadConfig({ baseDir: testDir });
    expect(config.agent.harness.name).toBe("opencode");
    expect(config.agent.path).toBe(globalCli);
    expect(config.agentFallbacks?.map((e) => [e.name, e.path])).toEqual([["grok", grokCli]]);
  });

  test("--harness disables failover even with a multi-entry AGENT_HARNESS", async () => {
    const opencodeCli = join(testDir, "opencode-cli");
    const grokCli = join(testDir, "grok-cli");
    writeExecutable(opencodeCli);
    writeExecutable(grokCli);
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.OPENCODE_CLI_PATH = opencodeCli;
    process.env.GROK_CLI_PATH = grokCli;

    const config = await loadConfig({ harnessName: "opencode", baseDir: testDir });
    expect(config.agent.harness.name).toBe("opencode");
    expect(config.agentFallbacks).toEqual([]);
  });

  test("single-entry AGENT_HARNESS has no fallbacks", async () => {
    const opencodeCli = join(testDir, "opencode-cli");
    writeExecutable(opencodeCli);
    process.env.AGENT_HARNESS = "opencode";
    process.env.OPENCODE_CLI_PATH = opencodeCli;

    const config = await loadConfig({ baseDir: testDir });
    expect(config.agent.path).toBe(opencodeCli);
    expect(config.agentFallbacks).toEqual([]);
  });

  test("unknown chain entries are warned about and skipped", async () => {
    const opencodeCli = join(testDir, "opencode-cli");
    const grokCli = join(testDir, "grok-cli");
    writeExecutable(opencodeCli);
    writeExecutable(grokCli);
    process.env.AGENT_HARNESS = "opencode,nope,grok";
    process.env.OPENCODE_CLI_PATH = opencodeCli;
    process.env.GROK_CLI_PATH = grokCli;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const config = await loadConfig({ baseDir: testDir });
      expect(config.agentFallbacks?.map((e) => e.name)).toEqual(["grok"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('Unknown agent harness "nope"'))).toBe(true);
  });

  test("a dropped first entry flags the stand-in primary and ignores cliPath", async () => {
    const grokCli = join(testDir, "grok-cli");
    const explicitCli = join(testDir, "explicit-cli");
    writeExecutable(grokCli);
    writeExecutable(explicitCli);
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.OPENCODE_CLI_PATH = join(testDir, "missing-opencode");
    process.env.GROK_CLI_PATH = grokCli;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const config = await loadConfig({ baseDir: testDir, cliPath: explicitCli });
      expect(config.agent.harness.name).toBe("grok");
      expect(config.agent.path).toBe(grokCli);
      expect(config.agentIsFallback).toBe(true);
      expect(config.agentFallbacks).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("an installed first entry is not flagged as a fallback", async () => {
    const opencodeCli = join(testDir, "opencode-cli");
    const grokCli = join(testDir, "grok-cli");
    writeExecutable(opencodeCli);
    writeExecutable(grokCli);
    process.env.AGENT_HARNESS = "opencode,grok";
    process.env.OPENCODE_CLI_PATH = opencodeCli;
    process.env.GROK_CLI_PATH = grokCli;

    const config = await loadConfig({ baseDir: testDir });
    expect(config.agentIsFallback).toBeUndefined();
  });
});
