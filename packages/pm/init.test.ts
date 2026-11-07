import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrackerConfig } from "@devintern/task-trackers";
import { initializeProject } from "./lib/init";

let tempDir: string;
let projectDir: string;
let workspaceDir: string;
let originalCwd: string;
let originalWorkspaceDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;

  tempDir = mkdtempSync(join(tmpdir(), "pm-init-noninteractive-test-"));
  projectDir = join(tempDir, "project");
  workspaceDir = join(tempDir, "workspace");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalWorkspaceDir === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
  else process.env.DEVINTERN_WORKSPACE_DIR = originalWorkspaceDir;
  rmSync(tempDir, { recursive: true, force: true });
});

function readProjectEnv(): string {
  return readFileSync(join(projectDir, ".devintern-pm", ".env"), "utf8");
}

function writeCodeEnv(content: string): void {
  mkdirSync(join(projectDir, ".devintern-code"), { recursive: true });
  writeFileSync(join(projectDir, ".devintern-code", ".env"), content, "utf8");
}

describe("initializeProject (non-interactive scaffold)", () => {
  test("migrates a workspace-only tracker and its credentials", async () => {
    const workspaceEnv = [
      "TASK_TRACKER=linear",
      "LINEAR_API_KEY=lin_api_workspace",
      "GITHUB_REPO=acme/other-repo",
    ].join("\n");
    writeFileSync(join(workspaceDir, ".env"), workspaceEnv, "utf8");

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^TASK_TRACKER=linear$/m);
    expect(env).toMatch(/^LINEAR_API_KEY=lin_api_workspace$/m);
    // Placeholders for other trackers are commented out, not active.
    expect(env).not.toMatch(/^JIRA_BASE_URL=/m);
    expect(env).not.toMatch(/^GITHUB_REPO=acme\/other-repo$/m);
    // The workspace file is read-only input.
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toBe(workspaceEnv);
  });

  test("project .devintern-code wins over workspace credentials", async () => {
    writeCodeEnv(
      ["TASK_TRACKER=github", "GITHUB_TOKEN=ghp_code", "GITHUB_REPO=acme/my-app"].join("\n"),
    );
    writeFileSync(
      join(workspaceDir, ".env"),
      "TASK_TRACKER=linear\nLINEAR_API_KEY=lin_api_workspace\n",
      "utf8",
    );

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^TASK_TRACKER=github$/m);
    expect(env).toMatch(/^GITHUB_TOKEN=ghp_code$/m);
    expect(env).toMatch(/^GITHUB_REPO=acme\/my-app$/m);
    expect(env).not.toContain("lin_api_workspace");
  });

  test("folds a legacy GITHUB_OWNER into GITHUB_REPO", async () => {
    // Clear inherited tracker/env selection so the loader reads only fixtures.
    const envKeys = [
      "DEVINTERN_WORKER_SUBPROCESS",
      "TASK_TRACKER",
      "GITHUB_OWNER",
      "GITHUB_TOKEN",
      "GITHUB_REPO",
    ] as const;
    const saved = new Map<string, string | undefined>();
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    try {
      writeCodeEnv(
        [
          "TASK_TRACKER=github",
          "GITHUB_TOKEN=ghp_legacy",
          "GITHUB_REPO=my-repo",
          "GITHUB_OWNER=acme",
        ].join("\n"),
      );

      await initializeProject();

      const env = readProjectEnv();
      expect(env).toMatch(/^GITHUB_REPO=acme\/my-repo$/m);
      expect(env).not.toMatch(/^GITHUB_REPO=my-repo$/m);

      const config = await loadTrackerConfig(".devintern-pm", projectDir, {
        workspaceEnvFallback: true,
      });
      expect(config.github?.repository).toBe("acme/my-repo");
    } finally {
      for (const key of envKeys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("preserves regex replacement patterns in migrated values", async () => {
    writeCodeEnv(
      [
        "TASK_TRACKER=linear",
        "LINEAR_API_KEY=lin$&SUFFIX",
        "AGENT_HARNESS=opencode$$",
        "AGENT_CLI_PATH=/opt/$&/agent",
      ].join("\n"),
    );

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^LINEAR_API_KEY=lin\$&SUFFIX$/m);
    expect(env).toMatch(/^AGENT_HARNESS=opencode\$\$$/m);
    expect(env).toMatch(/^AGENT_CLI_PATH=\/opt\/\$&\//m);
  });

  test("migrates AGENT_HARNESS and AGENT_CLI_PATH", async () => {
    writeCodeEnv(
      [
        "TASK_TRACKER=jira",
        "JIRA_BASE_URL=https://acme.atlassian.net",
        "JIRA_EMAIL=dev@acme.com",
        "JIRA_API_TOKEN=token",
        "JIRA_DEFAULT_PROJECT_KEY=PROJ",
        "AGENT_HARNESS=opencode",
        "AGENT_CLI_PATH=/custom/agent",
      ].join("\n"),
    );

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^AGENT_HARNESS=opencode$/m);
    expect(env).toMatch(/^AGENT_CLI_PATH=\/custom\/agent$/m);
  });

  test("activates commented template keys for the selected tracker", async () => {
    writeCodeEnv("TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=docs/tasks\n");

    await initializeProject();

    expect(readProjectEnv()).toMatch(/^MARKDOWN_TASKS_DIR=docs\/tasks$/m);
  });

  test("uses workspace.toml when the workspace .env has credentials only", async () => {
    writeFileSync(join(workspaceDir, ".env"), "LINEAR_API_KEY=lin_api_workspace\n", "utf8");
    writeFileSync(join(workspaceDir, "workspace.toml"), '[defaults]\ntracker = "linear"\n', "utf8");

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^TASK_TRACKER=linear$/m);
    expect(env).toMatch(/^LINEAR_API_KEY=lin_api_workspace$/m);
  });

  test("workspace.toml tracker wins over a stale workspace .env tracker", async () => {
    writeFileSync(
      join(workspaceDir, ".env"),
      [
        "TASK_TRACKER=jira",
        "JIRA_BASE_URL=https://stale.atlassian.net",
        "JIRA_EMAIL=stale@example.com",
        "JIRA_API_TOKEN=stale-token",
        "JIRA_DEFAULT_PROJECT_KEY=STALE",
        "LINEAR_API_KEY=lin_api_workspace",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(workspaceDir, "workspace.toml"), '[defaults]\ntracker = "linear"\n', "utf8");

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^TASK_TRACKER=linear$/m);
    expect(env).toMatch(/^LINEAR_API_KEY=lin_api_workspace$/m);
    expect(env).not.toMatch(/^JIRA_BASE_URL=https:\/\/stale\.atlassian\.net$/m);
  });

  test("runtime after init never resolves another repo's destination", async () => {
    // The invoking shell can carry worker markers and a tracker selection;
    // clear them so the loader under test reads only the fixture files.
    const envKeys = [
      "DEVINTERN_WORKER_SUBPROCESS",
      "TASK_TRACKER",
      "GITHUB_OWNER",
      "GITHUB_TOKEN",
      "GITHUB_REPO",
      "MARKDOWN_TASKS_DIR",
    ] as const;
    const saved = new Map<string, string | undefined>();
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    try {
      writeFileSync(
        join(workspaceDir, ".env"),
        [
          "TASK_TRACKER=github",
          "GITHUB_TOKEN=ghp_workspace",
          "GITHUB_REPO=acme/repo-a",
          "MARKDOWN_TASKS_DIR=docs/repo-a",
        ].join("\n"),
        "utf8",
      );

      await initializeProject();
      expect(readProjectEnv()).toMatch(/^# GITHUB_REPO=/m);

      // Repo B has no destination of its own yet: fail instead of inheriting
      // repo A's repository from the shared workspace file.
      await expect(
        loadTrackerConfig(".devintern-pm", projectDir, { workspaceEnvFallback: true }),
      ).rejects.toThrow(/Missing required environment variables: GITHUB_REPO/);

      writeFileSync(
        join(projectDir, ".devintern-pm", ".env"),
        `${readProjectEnv()}GITHUB_REPO=acme/repo-b\n`,
        "utf8",
      );
      const config = await loadTrackerConfig(".devintern-pm", projectDir, {
        workspaceEnvFallback: true,
      });
      expect(config.github?.repository).toBe("acme/repo-b");
    } finally {
      for (const key of envKeys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("does not inherit repo-scoped workspace values", async () => {
    writeFileSync(
      join(workspaceDir, ".env"),
      ["TASK_TRACKER=github", "GITHUB_TOKEN=ghp_workspace", "GITHUB_REPO=acme/repo-a"].join("\n"),
      "utf8",
    );

    await initializeProject();

    const env = readProjectEnv();
    expect(env).toMatch(/^GITHUB_TOKEN=ghp_workspace$/m);
    expect(env).not.toMatch(/^GITHUB_REPO=acme\/repo-a$/m);
    expect(env).toMatch(/^# GITHUB_REPO=/m);
  });

  test("ignores an unreadable workspace env file", async () => {
    mkdirSync(join(workspaceDir, ".env"));

    await initializeProject();

    // Nothing could be resolved, so even TASK_TRACKER stays commented out for
    // the workspace layer to fill later.
    expect(readProjectEnv()).toMatch(/^# TASK_TRACKER=jira$/m);
  });

  test("scaffolding before the workspace is configured still picks it up later", async () => {
    const envKeys = [
      "DEVINTERN_WORKER_SUBPROCESS",
      "DEVINTERN_WORKSPACE_REPO",
      "DEVINTERN_WORKSPACE_TEAM",
      "TASK_TRACKER",
      "LINEAR_API_KEY",
      "LINEAR_DEFAULT_TEAM_KEY",
      "JIRA_BASE_URL",
      "JIRA_DEFAULT_PROJECT_KEY",
    ] as const;
    const saved = new Map<string, string | undefined>();
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    try {
      // No .devintern-code and an empty workspace: nothing to migrate.
      await initializeProject();

      const scaffold = readProjectEnv();
      // No active placeholder may shadow the workspace layer later.
      expect(scaffold).toMatch(/^# TASK_TRACKER=jira$/m);
      expect(scaffold).not.toMatch(/^JIRA_BASE_URL=/m);
      expect(scaffold).not.toMatch(/^JIRA_DEFAULT_PROJECT_KEY=/m);
      expect(scaffold).toMatch(/^# JIRA_BASE_URL=https:\/\/your-org\.atlassian\.net$/m);

      // Configure the workspace afterwards.
      writeFileSync(join(workspaceDir, ".env"), "LINEAR_API_KEY=lin_api_ws\n", "utf8");
      writeFileSync(
        join(workspaceDir, "workspace.toml"),
        '[defaults]\ntracker = "linear"\n',
        "utf8",
      );

      const config = await loadTrackerConfig(".devintern-pm", projectDir, {
        workspaceEnvFallback: true,
      });
      expect(config.backend.type).toBe("linear");
      expect(config.linear?.apiKey).toBe("lin_api_ws");
    } finally {
      for (const key of envKeys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
