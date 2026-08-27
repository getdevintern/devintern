import { describe, expect, test } from "bun:test";

import { GitHubTaskTrackerClient } from "../src/lib/trackers/github/github-task-tracker-client";
import { GitLabTaskTrackerClient } from "../src/lib/trackers/gitlab/gitlab-task-tracker-client";
import { supportsIssueCreation } from "../src/lib/tracker-capabilities";
import { defaultTrackerPort } from "../src/lib/automations/docs-drift-guard/ports";
import type { GitHubClient } from "@devintern/task-trackers";

describe("normalized issue-creation capability", () => {
  test("GitHub and GitLab support issue creation; others do not", () => {
    expect(supportsIssueCreation()).toEqual(["github", "gitlab"]);
  });

  test("GitHub adapter creates issues through the shared client", async () => {
    const adapter = new GitHubTaskTrackerClient("tok", "acme", "webapp");
    (adapter as unknown as { githubClient: Partial<GitHubClient> }).githubClient = {
      createIssue: async (title, body, labels) => {
        expect(title).toBe("[docs-drift] fix the guide");
        expect(body).toContain("devintern-docs-drift: abc");
        expect(labels).toBeUndefined();
        return {
          number: 42,
          html_url: "https://github.com/acme/webapp/issues/42",
          title,
          body,
        };
      },
    };
    const result = await adapter.createIssue({
      title: "[docs-drift] fix the guide",
      body: "devintern-docs-drift: abc",
    });
    expect(result).toEqual({
      key: "42",
      url: "https://github.com/acme/webapp/issues/42",
    });
  });

  test("GitLab adapter creates issues through the shared client", async () => {
    const adapter = new GitLabTaskTrackerClient("tok", "acme/webapp", {
      baseUrl: "https://gitlab.example.com",
    });
    (adapter as unknown as { gitlabClient: Record<string, unknown> }).gitlabClient = {
      createIssue: async (title: string, description: string) => {
        expect(title).toBe("[docs-drift] fix the guide");
        expect(description).toContain("drift");
        return {
          id: 9,
          iid: 17,
          project_id: 1,
          title,
          description,
          web_url: "https://gitlab.example.com/acme/webapp/-/issues/17",
        };
      },
    };
    const result = await adapter.createIssue({
      title: "[docs-drift] fix the guide",
      body: "drift",
    });
    expect(result).toEqual({
      key: "17",
      url: "https://gitlab.example.com/acme/webapp/-/issues/17",
    });
  });

  test("default tracker port refuses clients without the capability", async () => {
    const refusing = {
      async searchTasks() {
        return { tasks: [], total: 0 };
      },
    } as never;
    const port = defaultTrackerPort(refusing);
    await expect(port.create({ title: "t", body: "b" })).rejects.toThrow("cannot create tickets");
  });

  test("default tracker port search failures do not block publication", async () => {
    const failing = {
      async searchTasks() {
        throw new Error("search exploded");
      },
      async createIssue() {
        return { key: "7" };
      },
    } as never;
    const port = defaultTrackerPort(failing);
    const existing = await port.findOpenWithMarker("devintern-docs-drift: x");
    expect(existing).toEqual([]);
    await expect(port.create({ title: "t", body: "b" })).resolves.toEqual({ key: "7" });
  });
});
