import { describe, expect, test } from "bun:test";
import {
  GitHubTaskTrackerClient,
  parseGitHubIssueReference,
} from "../src/lib/trackers/github/github-task-tracker-client";
import type { GitHubClient, GitHubIssue } from "@devintern/task-trackers";

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 123,
    html_url: "https://github.com/acme/webapp/issues/123",
    title: "Fix login bug",
    body: "Steps in https://example.com/spec",
    state: "open",
    labels: [{ name: "bug" }],
    assignee: { login: "ada" },
    user: { login: "grace" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

/** Inject a stubbed GitHubClient into the adapter (bypasses HTTP). */
function makeAdapter(
  stub: Partial<GitHubClient>,
  options?: { statusLabels?: string[] },
): GitHubTaskTrackerClient {
  const adapter = new GitHubTaskTrackerClient("tok", "acme", "webapp", options);
  (adapter as unknown as { githubClient: Partial<GitHubClient> }).githubClient = stub;
  return adapter;
}

describe("parseGitHubIssueReference", () => {
  test("accepts bare numbers and #-prefixed numbers", () => {
    expect(parseGitHubIssueReference("123")).toBe("123");
    expect(parseGitHubIssueReference("#123")).toBe("123");
  });

  test("accepts owner/repo#123 references", () => {
    expect(parseGitHubIssueReference("acme/webapp#123")).toBe("123");
  });

  test("extracts number from issue URLs", () => {
    expect(parseGitHubIssueReference("https://github.com/acme/webapp/issues/123")).toBe("123");
  });

  test("returns null for non-issue values", () => {
    expect(parseGitHubIssueReference("PROJ-123")).toBeNull();
    expect(parseGitHubIssueReference("./task.md")).toBeNull();
    expect(parseGitHubIssueReference("https://github.com/acme/webapp/pull/9")).toBeNull();
  });
});

describe("GitHubTaskTrackerClient.getTask", () => {
  test("normalizes issue into Task", async () => {
    const adapter = makeAdapter({ getIssue: async () => makeIssue() });

    const task = await adapter.getTask("123");

    expect(task.key).toBe("123");
    expect(task.summary).toBe("Fix login bug");
    expect(task.status).toBe("open");
    expect(task.assignee).toBe("ada");
    expect(task.reporter).toBe("grace");
    expect(task.labels).toEqual(["bug"]);
  });

  test("rejects invalid issue references", async () => {
    const adapter = makeAdapter({});
    await expect(adapter.getTask("not-a-number")).rejects.toThrow("Invalid GitHub issue reference");
  });
});

describe("GitHubTaskTrackerClient.transitionStatus", () => {
  test("closes the issue for closed/done statuses", async () => {
    const updates: unknown[] = [];
    const adapter = makeAdapter({
      updateIssue: async (_n: number, patch: unknown) => {
        updates.push(patch);
        return makeIssue();
      },
    });

    await adapter.transitionStatus("123", "Done");

    expect(updates).toEqual([{ state: "closed" }]);
  });

  test("adds target label and removes other status labels", async () => {
    const added: string[][] = [];
    const removed: string[] = [];
    const adapter = makeAdapter(
      {
        getLabels: async () => [
          { name: "To Do", description: null },
          { name: "In Progress", description: null },
          { name: "bug", description: null },
        ],
        getIssue: async () => makeIssue({ labels: [{ name: "To Do" }, { name: "bug" }] }),
        addLabels: async (_n: number, labels: string[]) => {
          added.push(labels);
        },
        removeLabel: async (_n: number, label: string) => {
          removed.push(label);
        },
      },
      { statusLabels: ["To Do", "In Progress", "In Review"] },
    );

    await adapter.transitionStatus("123", "in progress");

    expect(added).toEqual([["In Progress"]]);
    expect(removed).toEqual(["To Do"]);
  });

  test("lists repo labels when target label is missing", async () => {
    const adapter = makeAdapter({
      getLabels: async () => [
        { name: "bug", description: null },
        { name: "enhancement", description: null },
      ],
    });

    await expect(adapter.transitionStatus("123", "In Progress")).rejects.toThrow(
      "Available labels: bug, enhancement",
    );
  });

  test("reopens a closed issue when moving to an open status", async () => {
    const updates: unknown[] = [];
    const adapter = makeAdapter({
      getLabels: async () => [{ name: "To Do", description: null }],
      getIssue: async () => makeIssue({ state: "closed", labels: [] }),
      addLabels: async () => {},
      updateIssue: async (_n: number, patch: unknown) => {
        updates.push(patch);
        return makeIssue();
      },
    });

    await adapter.transitionStatus("123", "To Do");

    expect(updates).toEqual([{ state: "open" }]);
  });
});

describe("GitHubTaskTrackerClient.getComments", () => {
  test("filters devintern automation comments", async () => {
    const adapter = makeAdapter({
      listIssueComments: async () => [
        {
          id: 1,
          body: "Human question",
          user: { login: "ada" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          body: "Implementation Completed by @devintern/code\n\nDetails",
          user: { login: "bot" },
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const comments = await adapter.getComments("123");

    expect(comments.length).toBe(1);
    expect(comments[0].author).toBe("ada");
  });
});

describe("GitHubTaskTrackerClient estimation", () => {
  test("has no estimation field", async () => {
    const adapter = makeAdapter({});
    expect(await adapter.discoverEstimationField()).toBeNull();
    await expect(adapter.updateEstimation("123", "any", 5)).rejects.toThrow("no estimation field");
  });

  test("findEstimationComment locates prior estimation comment", async () => {
    const adapter = makeAdapter({
      listIssueComments: async () => [
        {
          id: 42,
          body: "### 🤖 Automated Story Points Estimation\n\n**Story Points:** 3",
          user: { login: "bot" },
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
        },
      ],
    });

    const found = await adapter.findEstimationComment("123");
    expect(found).toEqual({ commentId: "42", created: "2026-01-03T00:00:00Z" });
  });
});
