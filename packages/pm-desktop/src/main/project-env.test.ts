import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listConfiguredTrackersForProject,
  persistActiveHarness,
  persistActiveProject,
  persistActiveTracker,
  readProjectEnv,
  resolvePmEnvPath,
} from "./project-env.ts";

describe("project-env", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writeEnv(content: string): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-env-"));
    const configDir = join(tempDir, ".devintern-pm");
    await mkdir(configDir);
    await writeFile(join(configDir, ".env"), content, "utf8");
    return tempDir;
  }

  test("resolvePmEnvPath ignores a plain project .env without .devintern-pm", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-env-"));
    await mkdir(join(tempDir, ".git"));
    await writeFile(join(tempDir, ".env"), "GITHUB_TOKEN=not-pm\n", "utf8");
    expect(resolvePmEnvPath(tempDir)).toBeNull();
    const { envPath, env } = await readProjectEnv(tempDir);
    expect(envPath).toBeNull();
    expect(env).toEqual({});
  });

  test("listConfiguredTrackersForProject reads only fully configured trackers", async () => {
    const dir = await writeEnv(
      [
        "TASK_TRACKER=jira",
        "JIRA_BASE_URL=https://acme.atlassian.net",
        "JIRA_EMAIL=a@b.com",
        "JIRA_API_TOKEN=tok",
        "JIRA_DEFAULT_PROJECT_KEY=ACME",
        "LINEAR_API_KEY=lin_api_x",
        "GITHUB_TOKEN=ghp_x",
        "",
      ].join("\n"),
    );

    const configured = await listConfiguredTrackersForProject(dir);
    expect(configured.map((t) => t.id)).toEqual(["jira", "linear"]);
  });

  test("persistActiveTracker updates TASK_TRACKER in .env", async () => {
    const dir = await writeEnv(
      [
        "TASK_TRACKER=jira",
        "JIRA_BASE_URL=https://acme.atlassian.net",
        "JIRA_EMAIL=a@b.com",
        "JIRA_API_TOKEN=tok",
        "JIRA_DEFAULT_PROJECT_KEY=ACME",
        "LINEAR_API_KEY=lin_api_x",
        "",
      ].join("\n"),
    );

    await persistActiveTracker(dir, "linear");
    const { env } = await readProjectEnv(dir);
    expect(env.TASK_TRACKER).toBe("linear");
    const raw = await readFile(join(dir, ".devintern-pm", ".env"), "utf8");
    expect(raw).toContain("TASK_TRACKER=linear");
  });

  test("persistActiveTracker rejects an unconfigured tracker", async () => {
    const dir = await writeEnv("TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\n");
    await expect(persistActiveTracker(dir, "jira")).rejects.toThrow(/not fully configured/);
  });

  test("persistActiveProject writes the tracker project-key env var", async () => {
    const dir = await writeEnv(
      [
        "TASK_TRACKER=jira",
        "JIRA_BASE_URL=https://acme.atlassian.net",
        "JIRA_EMAIL=a@b.com",
        "JIRA_API_TOKEN=tok",
        "JIRA_DEFAULT_PROJECT_KEY=ACME",
        "",
      ].join("\n"),
    );

    const result = await persistActiveProject(dir, "OTHER");
    expect(result.projectKeyEnv).toBe("JIRA_DEFAULT_PROJECT_KEY");
    expect(result.projectKey).toBe("OTHER");
    const { env } = await readProjectEnv(dir);
    expect(env.JIRA_DEFAULT_PROJECT_KEY).toBe("OTHER");
  });

  test("persistActiveProject rejects markdown (no project-key env)", async () => {
    const dir = await writeEnv("TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\n");
    await expect(persistActiveProject(dir, "x")).rejects.toThrow(/does not support/);
  });

  describe("persistActiveHarness", () => {
    const originalEnv = { ...process.env };
    let cliDir: string | undefined;

    beforeEach(() => {
      delete process.env.AGENT_HARNESS;
      delete process.env.AGENT_CLI_PATH;
      delete process.env.OPENCODE_CLI_PATH;
      delete process.env.CLAUDE_CLI_PATH;
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
      if (cliDir) {
        rmSync(cliDir, { recursive: true, force: true });
        cliDir = undefined;
      }
    });

    function writeExecutable(name: string): string {
      cliDir = mkdtempSync(join(tmpdir(), "pm-desktop-harness-cli-"));
      const path = join(cliDir, name);
      writeFileSync(path, "#!/bin/sh\n");
      chmodSync(path, 0o755);
      return path;
    }

    test("writes AGENT_HARNESS and clears sticky AGENT_CLI_PATH", async () => {
      const opencodeCli = writeExecutable("opencode");
      process.env.OPENCODE_CLI_PATH = opencodeCli;

      const dir = await writeEnv(
        [
          "TASK_TRACKER=markdown",
          "MARKDOWN_TASKS_DIR=./tasks",
          "AGENT_HARNESS=claude-code",
          "AGENT_CLI_PATH=/old/global/agent",
          "",
        ].join("\n"),
      );

      await persistActiveHarness(dir, "opencode");
      const { env } = await readProjectEnv(dir);
      expect(env.AGENT_HARNESS).toBe("opencode");
      expect(env.AGENT_CLI_PATH).toBe("");
      expect(process.env.AGENT_CLI_PATH).toBeUndefined();
      const raw = await readFile(join(dir, ".devintern-pm", ".env"), "utf8");
      expect(raw).toContain("AGENT_HARNESS=opencode");
      expect(raw.split("\n")).toContain("AGENT_CLI_PATH=");
    });

    test("rejects an empty or whitespace harness name without writing", async () => {
      const dir = await writeEnv(
        "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\nAGENT_HARNESS=claude-code\n",
      );
      await expect(persistActiveHarness(dir, "")).rejects.toThrow(/must not be empty/);
      await expect(persistActiveHarness(dir, "   ")).rejects.toThrow(/must not be empty/);
      const { env } = await readProjectEnv(dir);
      expect(env.AGENT_HARNESS).toBe("claude-code");
    });

    test("clears a process-only AGENT_CLI_PATH that is absent from .env", async () => {
      const opencodeCli = writeExecutable("opencode");
      process.env.OPENCODE_CLI_PATH = opencodeCli;
      process.env.AGENT_CLI_PATH = "/process/only/agent";

      const dir = await writeEnv(
        [
          "TASK_TRACKER=markdown",
          "MARKDOWN_TASKS_DIR=./tasks",
          "AGENT_HARNESS=claude-code",
          "",
        ].join("\n"),
      );

      await persistActiveHarness(dir, "opencode");
      expect(process.env.AGENT_CLI_PATH).toBeUndefined();
      const { env } = await readProjectEnv(dir);
      expect(env.AGENT_HARNESS).toBe("opencode");
      expect(env.AGENT_CLI_PATH).toBeUndefined();
      const raw = await readFile(join(dir, ".devintern-pm", ".env"), "utf8");
      expect(raw).not.toContain("AGENT_CLI_PATH");
    });

    test("rejects an unknown harness without writing", async () => {
      const dir = await writeEnv(
        "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\nAGENT_HARNESS=claude-code\n",
      );
      await expect(persistActiveHarness(dir, "not-a-real-harness")).rejects.toThrow(
        /Unknown agent harness/,
      );
      const { env } = await readProjectEnv(dir);
      expect(env.AGENT_HARNESS).toBe("claude-code");
    });

    test("rejects a harness whose CLI is not installed without writing", async () => {
      const dir = await writeEnv(
        "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\nAGENT_HARNESS=claude-code\n",
      );
      // Point opencode at a missing path so install/path checks fail.
      process.env.OPENCODE_CLI_PATH = join(tmpdir(), "definitely-missing-opencode-cli");
      await expect(persistActiveHarness(dir, "opencode")).rejects.toThrow(
        /not installed|not found/i,
      );
      const { env } = await readProjectEnv(dir);
      expect(env.AGENT_HARNESS).toBe("claude-code");
    });
  });
});
