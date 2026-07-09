import { describe, expect, test } from "bun:test";
import {
  LinearTaskTrackerClient,
  parseLinearIssueReference,
} from "../src/lib/trackers/linear/linear-task-tracker-client";
import type { LinearClient, LinearIssueDetail } from "@devintern/task-trackers";

function makeIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    id: "uuid-1",
    identifier: "ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
    title: "Fix login bug",
    description: "Steps in https://example.com/spec",
    priorityLabel: "High",
    estimate: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    assignee: { name: "Ada" },
    creator: { name: "Grace" },
    team: { id: "team-1", key: "ENG" },
    labels: [{ name: "bug" }],
    attachments: [],
    ...overrides,
  };
}

/** Inject a stubbed LinearClient into the adapter (bypasses GraphQL). */
function makeAdapter(stub: Partial<LinearClient>): LinearTaskTrackerClient {
  const adapter = new LinearTaskTrackerClient("lin_api_test");
  (adapter as unknown as { linearClient: Partial<LinearClient> }).linearClient = stub;
  return adapter;
}

describe("parseLinearIssueReference", () => {
  test("accepts bare identifiers and uppercases them", () => {
    expect(parseLinearIssueReference("eng-42")).toBe("ENG-42");
    expect(parseLinearIssueReference("ENG-42")).toBe("ENG-42");
  });

  test("extracts identifier from linear.app issue URLs", () => {
    expect(parseLinearIssueReference("https://linear.app/acme/issue/ENG-42/fix-login-bug")).toBe(
      "ENG-42",
    );
    expect(parseLinearIssueReference("https://linear.app/acme/issue/eng-42")).toBe("ENG-42");
  });

  test("returns null for non-Linear values", () => {
    expect(parseLinearIssueReference("./tasks/feature.md")).toBeNull();
    expect(parseLinearIssueReference("4uWKPOTv")).toBeNull();
    expect(parseLinearIssueReference("123")).toBeNull();
  });
});

describe("LinearTaskTrackerClient.getTask", () => {
  test("normalizes issue detail into Task", async () => {
    const adapter = makeAdapter({
      getIssueByIdentifier: async () => makeIssue(),
    });

    const task = await adapter.getTask("ENG-42");

    expect(task.key).toBe("ENG-42");
    expect(task.summary).toBe("Fix login bug");
    expect(task.status).toBe("Todo");
    expect(task.priority).toBe("High");
    expect(task.assignee).toBe("Ada");
    expect(task.reporter).toBe("Grace");
    expect(task.labels).toEqual(["bug"]);
  });

  test("throws TaskNotFoundError for unknown issue", async () => {
    const adapter = makeAdapter({ getIssueByIdentifier: async () => undefined });
    await expect(adapter.getTask("ENG-999")).rejects.toThrow("Task not found: ENG-999");
  });
});

describe("LinearTaskTrackerClient.transitionStatus", () => {
  test("moves issue to case-insensitively matched state", async () => {
    let movedTo = "";
    const adapter = makeAdapter({
      getIssueByIdentifier: async () => makeIssue(),
      getWorkflowStates: async () => [
        { id: "s1", name: "Todo", type: "unstarted" },
        { id: "s2", name: "In Progress", type: "started" },
      ],
      updateIssueState: async (_id: string, stateId: string) => {
        movedTo = stateId;
      },
    });

    await adapter.transitionStatus("ENG-42", "in progress");
    expect(movedTo).toBe("s2");
  });

  test("lists available states when target not found", async () => {
    const adapter = makeAdapter({
      getIssueByIdentifier: async () => makeIssue(),
      getWorkflowStates: async () => [
        { id: "s1", name: "Todo", type: "unstarted" },
        { id: "s2", name: "Done", type: "completed" },
      ],
    });

    await expect(adapter.transitionStatus("ENG-42", "Nonexistent")).rejects.toThrow(
      "Available states: Todo, Done",
    );
  });
});

describe("LinearTaskTrackerClient.getComments", () => {
  test("filters out devintern automation comments", async () => {
    const adapter = makeAdapter({
      getIssueIdByIdentifier: async () => "uuid-1",
      getIssueComments: async () => [
        {
          id: "c1",
          body: "Human question about scope",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          user: { name: "Ada" },
        },
        {
          id: "c2",
          body: "Implementation Completed by @devintern/code\n\nDetails",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          user: { name: "Bot" },
        },
      ],
    });

    const comments = await adapter.getComments("ENG-42");

    expect(comments.length).toBe(1);
    expect(comments[0].author).toBe("Ada");
  });
});

describe("LinearTaskTrackerClient estimation", () => {
  test("discoverEstimationField returns native estimate field", async () => {
    const adapter = makeAdapter({});
    expect(await adapter.discoverEstimationField()).toBe("estimate");
  });

  test("updateEstimation sets the native estimate", async () => {
    let estimateSet = 0;
    const adapter = makeAdapter({
      getIssueIdByIdentifier: async () => "uuid-1",
      updateIssueEstimate: async (_id: string, estimate: number) => {
        estimateSet = estimate;
      },
    });

    await adapter.updateEstimation("ENG-42", "estimate", 5);
    expect(estimateSet).toBe(5);
  });

  test("findEstimationComment locates prior automated estimation", async () => {
    const adapter = makeAdapter({
      getIssueIdByIdentifier: async () => "uuid-1",
      getIssueComments: async () => [
        {
          id: "c9",
          body: "### 🤖 Automated Story Points Estimation\n\n**Story Points:** 3",
          createdAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });

    const found = await adapter.findEstimationComment("ENG-42");
    expect(found).toEqual({ commentId: "c9", created: "2026-01-03T00:00:00.000Z" });
  });
});

describe("LinearTaskTrackerClient.extractLinkedResources", () => {
  test("collects description URLs and attachment links", async () => {
    const adapter = makeAdapter({});
    const issue = makeIssue({
      attachments: [{ id: "a1", title: "Design", url: "https://figma.com/file/xyz" }],
    });
    const task = {
      key: "ENG-42",
      summary: "t",
      issueType: "Issue",
      status: "",
      reporter: "",
      created: "",
      updated: "",
      labels: [],
      components: [],
      fixVersions: [],
      raw: issue,
    };

    const resources = adapter.extractLinkedResources(task);

    expect(resources.some((r) => r.url === "https://example.com/spec")).toBe(true);
    expect(resources.some((r) => r.url === "https://figma.com/file/xyz")).toBe(true);
  });
});
