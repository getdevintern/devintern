import { describe, expect, test } from "bun:test";
import {
  GitLabTaskTrackerClient,
  parseGitLabIssueReference,
} from "../src/lib/trackers/gitlab/gitlab-task-tracker-client";
import type { GitLabClient, GitLabIssue } from "@devintern/task-trackers";

function makeIssue(overrides: Partial<GitLabIssue> = {}): GitLabIssue {
  return {
    id: 9001,
    iid: 123,
    project_id: 42,
    title: "Fix login bug",
    description: "Steps in https://example.com/spec",
    state: "opened",
    labels: ["bug"],
    author: { username: "grace" },
    assignees: [{ username: "ada" }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    web_url: "https://gitlab.com/acme/team/webapp/-/issues/123",
    ...overrides,
  };
}

/** Inject a stubbed GitLabClient into the adapter (bypasses HTTP). */
function makeAdapter(
  stub: Partial<GitLabClient>,
  options?: { statusLabels?: string[] },
): GitLabTaskTrackerClient {
  const adapter = new GitLabTaskTrackerClient("tok", "acme/team/webapp", options);
  (adapter as unknown as { gitlabClient: Partial<GitLabClient> }).gitlabClient = stub;
  return adapter;
}

describe("parseGitLabIssueReference", () => {
  test("accepts bare numbers and #-prefixed numbers", () => {
    expect(parseGitLabIssueReference("123")).toBe("123");
    expect(parseGitLabIssueReference("#123")).toBe("123");
  });

  test("accepts group/sub/repo#123 references with subgroups", () => {
    expect(parseGitLabIssueReference("acme/team/webapp#123")).toBe("123");
    expect(parseGitLabIssueReference("acme/webapp#7")).toBe("7");
  });

  test("extracts the iid from issue URLs with and without /-/", () => {
    expect(parseGitLabIssueReference("https://gitlab.com/acme/team/webapp/-/issues/123")).toBe(
      "123",
    );
    expect(parseGitLabIssueReference("https://gitlab.internal:8443/acme/webapp/issues/9")).toBe(
      "9",
    );
  });

  test("returns null for non-issue values", () => {
    expect(parseGitLabIssueReference("PROJ-123")).toBeNull();
    expect(parseGitLabIssueReference("./task.md")).toBeNull();
    expect(
      parseGitLabIssueReference("https://gitlab.com/acme/webapp/-/merge_requests/9"),
    ).toBeNull();
    expect(parseGitLabIssueReference("https://github.com/acme/webapp/pull/9")).toBeNull();
  });
});

describe("GitLabTaskTrackerClient.getTask", () => {
  test("normalizes issue into Task", async () => {
    const adapter = makeAdapter({ getIssue: async () => makeIssue() });

    const task = await adapter.getTask("123");

    expect(task.key).toBe("123");
    expect(task.summary).toBe("Fix login bug");
    expect(task.status).toBe("opened");
    expect(task.assignee).toBe("ada");
    expect(task.reporter).toBe("grace");
    expect(task.labels).toEqual(["bug"]);
  });

  test("rejects invalid issue references", async () => {
    const adapter = makeAdapter({});
    await expect(adapter.getTask("not-a-number")).rejects.toThrow("Invalid GitLab issue reference");
  });
});

describe("GitLabTaskTrackerClient.transitionStatus", () => {
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
        getLabels: async () => ({
          labels: [
            { id: 1, name: "To Do", description: null },
            { id: 2, name: "In Progress", description: null },
            { id: 3, name: "bug", description: null },
          ],
          truncated: false,
        }),
        getIssue: async () => makeIssue({ labels: ["To Do", "bug"] }),
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

  test("lists project labels when target label is missing", async () => {
    const adapter = makeAdapter({
      getLabels: async () => ({
        labels: [
          { id: 1, name: "bug", description: null },
          { id: 2, name: "enhancement", description: null },
        ],
        truncated: false,
      }),
    });

    await expect(adapter.transitionStatus("123", "In Progress")).rejects.toThrow(
      "Available labels: bug, enhancement",
    );
  });

  test("exhausts truncated catalog when status label is beyond the soft cap", async () => {
    const caps: Array<number | undefined> = [];
    const added: string[][] = [];
    const adapter = makeAdapter(
      {
        getLabels: async (maxLabels?: number) => {
          caps.push(maxLabels);
          if (maxLabels === Number.POSITIVE_INFINITY) {
            return {
              labels: [
                { id: 1, name: "bug", description: null },
                { id: 2, name: "In Progress", description: null },
              ],
              truncated: false,
            };
          }
          return {
            labels: [{ id: 1, name: "bug", description: null }],
            truncated: true,
          };
        },
        getIssue: async () => makeIssue({ labels: ["bug"] }),
        addLabels: async (_n: number, labels: string[]) => {
          added.push(labels);
        },
        removeLabel: async () => {},
      },
      { statusLabels: ["To Do", "In Progress"] },
    );

    await adapter.transitionStatus("123", "In Progress");

    expect(caps).toEqual([undefined, Number.POSITIVE_INFINITY]);
    expect(added).toEqual([["In Progress"]]);
  });

  test("reopens a closed issue when moving to an open status", async () => {
    const updates: unknown[] = [];
    const adapter = makeAdapter({
      getLabels: async () => ({
        labels: [{ id: 1, name: "To Do", description: null }],
        truncated: false,
      }),
      getIssue: async () => makeIssue({ state: "closed", labels: [] }),
      addLabels: async () => {},
      updateIssue: async (_n: number, patch: unknown) => {
        updates.push(patch);
        return makeIssue();
      },
    });

    await adapter.transitionStatus("123", "To Do");

    expect(updates).toEqual([{ state: "opened" }]);
  });
});

describe("GitLabTaskTrackerClient.getComments", () => {
  test("filters devintern automation comments and maps usernames", async () => {
    const adapter = makeAdapter({
      listIssueComments: async () => [
        {
          id: 1,
          body: "Human question",
          author: { username: "ada" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2,
          body: "Implementation Completed by @devintern/code\n\nDetails",
          author: { username: "bot" },
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

describe("GitLabTaskTrackerClient estimation", () => {
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
          author: { username: "bot" },
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
        },
      ],
    });

    const found = await adapter.findEstimationComment("123");
    expect(found).toEqual({ commentId: "42", created: "2026-01-03T00:00:00Z" });
  });
});
