import { afterEach, describe, expect, test } from "bun:test";
import { LinearClient } from "./src/clients/linear.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type GraphQLCall = { query: string; variables?: Record<string, unknown> };

function mockGraphQL(handler: (call: GraphQLCall) => unknown): GraphQLCall[] {
  const calls: GraphQLCall[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as GraphQLCall;
    calls.push(call);
    return new Response(JSON.stringify({ data: handler(call) }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const issueNode = {
  id: "uuid-1",
  identifier: "ENG-42",
  url: "https://linear.app/acme/issue/ENG-42",
  title: "Fix login bug",
  description: "Steps to reproduce...",
  priority: 2,
  priorityLabel: "High",
  estimate: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  state: { id: "state-1", name: "Todo", type: "unstarted" },
  assignee: { name: "Ada" },
  creator: { name: "Grace" },
  team: { id: "team-1", key: "ENG" },
  labels: { nodes: [{ name: "bug" }] },
  attachments: {
    nodes: [
      { id: "att-1", title: "screenshot.png", url: "https://uploads.linear.app/x/screenshot.png" },
    ],
  },
};

describe("LinearClient.getIssueByIdentifier", () => {
  test("returns normalized issue detail with flattened labels and attachments", async () => {
    mockGraphQL(() => ({ issues: { nodes: [issueNode] } }));

    const client = new LinearClient({ apiKey: "key" });
    const issue = await client.getIssueByIdentifier("ENG-42");

    expect(issue?.identifier).toBe("ENG-42");
    expect(issue?.title).toBe("Fix login bug");
    expect(issue?.state?.name).toBe("Todo");
    expect(issue?.labels).toEqual([{ name: "bug" }]);
    expect(issue?.attachments[0]?.url).toContain("uploads.linear.app");
  });

  test("returns undefined when no issue matches", async () => {
    mockGraphQL(() => ({ issues: { nodes: [] } }));

    const client = new LinearClient({ apiKey: "key" });
    expect(await client.getIssueByIdentifier("ENG-999")).toBeUndefined();
  });
});

describe("LinearClient.searchIssues", () => {
  test("passes JSON query through as IssueFilter", async () => {
    const calls = mockGraphQL(() => ({ issues: { nodes: [issueNode] } }));

    const client = new LinearClient({ apiKey: "key" });
    const result = await client.searchIssues('{"state":{"name":{"eq":"Todo"}}}');

    expect(calls[0]?.variables?.filter).toEqual({ state: { name: { eq: "Todo" } } });
    expect(result.total).toBe(1);
    expect(result.issues[0]?.identifier).toBe("ENG-42");
  });

  test("wraps plain text query in a title filter", async () => {
    const calls = mockGraphQL(() => ({ issues: { nodes: [] } }));

    const client = new LinearClient({ apiKey: "key" });
    await client.searchIssues("login bug");

    expect(calls[0]?.variables?.filter).toEqual({
      title: { containsIgnoreCase: "login bug" },
    });
  });

  test("throws a descriptive error on invalid filter JSON", async () => {
    mockGraphQL(() => ({ issues: { nodes: [] } }));

    const client = new LinearClient({ apiKey: "key" });
    await expect(client.searchIssues('{"state":')).rejects.toThrow(
      "Invalid Linear IssueFilter JSON",
    );
  });
});

describe("LinearClient comments and state", () => {
  test("createComment sends CommentCreate mutation and returns id", async () => {
    const calls = mockGraphQL((call) => {
      if (call.query.includes("CommentCreate")) {
        return { commentCreate: { success: true, comment: { id: "comment-1" } } };
      }
      throw new Error("unexpected query");
    });

    const client = new LinearClient({ apiKey: "key" });
    const id = await client.createComment("uuid-1", "Hello **world**");

    expect(id).toBe("comment-1");
    expect(calls[0]?.variables?.input).toEqual({ issueId: "uuid-1", body: "Hello **world**" });
  });

  test("updateComment throws when unsuccessful", async () => {
    mockGraphQL(() => ({ commentUpdate: { success: false } }));

    const client = new LinearClient({ apiKey: "key" });
    await expect(client.updateComment("comment-1", "new body")).rejects.toThrow(
      "Failed to update Linear comment",
    );
  });

  test("getWorkflowStates caches per team", async () => {
    const calls = mockGraphQL(() => ({
      team: { states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted" }] } },
    }));

    const client = new LinearClient({ apiKey: "key" });
    await client.getWorkflowStates("team-1");
    const states = await client.getWorkflowStates("team-1");

    expect(states[0]?.name).toBe("Todo");
    expect(calls.length).toBe(1);
  });

  test("updateIssueState sends stateId patch", async () => {
    const calls = mockGraphQL(() => ({ issueUpdate: { success: true } }));

    const client = new LinearClient({ apiKey: "key" });
    await client.updateIssueState("uuid-1", "state-2");

    expect(calls[0]?.variables?.input).toEqual({ stateId: "state-2" });
  });

  test("updateIssueEstimate sends estimate patch", async () => {
    const calls = mockGraphQL(() => ({ issueUpdate: { success: true } }));

    const client = new LinearClient({ apiKey: "key" });
    await client.updateIssueEstimate("uuid-1", 5);

    expect(calls[0]?.variables?.input).toEqual({ estimate: 5 });
  });

  test("getIssueComments sorts oldest first", async () => {
    mockGraphQL(() => ({
      issue: {
        comments: {
          nodes: [
            {
              id: "c2",
              body: "later",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
            {
              id: "c1",
              body: "earlier",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    }));

    const client = new LinearClient({ apiKey: "key" });
    const comments = await client.getIssueComments("uuid-1");

    expect(comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
