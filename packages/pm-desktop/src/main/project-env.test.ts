import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listConfiguredTrackersForProject,
  persistActiveProject,
  persistActiveTracker,
  readProjectEnv,
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
});
