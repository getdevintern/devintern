import { afterEach, describe, expect, test } from "bun:test";
import { AzureDevOpsClient } from "./src/clients/azure-devops.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type CapturedRequest = { url: string; method: string; body?: unknown };

function mockFetch(handler: (req: CapturedRequest) => unknown) {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    return new Response(JSON.stringify(handler(req)), { status: 200 });
  }) as typeof fetch;
  return calls;
}

function makeClient(): AzureDevOpsClient {
  return new AzureDevOpsClient({ organization: "myorg", pat: "pat", defaultProject: "MyProject" });
}

describe("AzureDevOpsClient.queryWorkItems", () => {
  test("posts WIQL scoped to the project and batch-fetches titles", async () => {
    const calls = mockFetch((req) => {
      if (req.url.includes("/wiql")) {
        return { workItems: [{ id: 1 }, { id: 2 }] };
      }
      return {
        value: [
          { id: 1, fields: { "System.Title": "First" } },
          { id: 2, fields: { "System.Title": "Second" } },
        ],
      };
    });

    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'";
    const result = await makeClient().queryWorkItems(wiql);

    expect(calls[0].url).toContain("/MyProject/_apis/wit/wiql");
    expect(calls[0].url).toContain("$top=100");
    expect(calls[0].body).toEqual({ query: wiql });
    expect(calls[1].url).toContain("ids=1,2");
    expect(result.total).toBe(2);
    expect(result.workItems[0]).toMatchObject({ id: 1, title: "First" });
  });

  test("returns empty result without a batch fetch when no matches", async () => {
    const calls = mockFetch(() => ({ workItems: [] }));

    const result = await makeClient().queryWorkItems("SELECT [System.Id] FROM WorkItems");

    expect(result).toEqual({ workItems: [], total: 0 });
    expect(calls.length).toBe(1);
  });

  test("chunks title fetches at 200 IDs", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));
    const calls = mockFetch((req) => {
      if (req.url.includes("/wiql")) return { workItems: ids };
      const idCount = req.url.match(/ids=([\d,]+)/)?.[1]?.split(",").length ?? 0;
      return {
        value: Array.from({ length: idCount }, (_, i) => ({ id: i, fields: {} })),
      };
    });

    await makeClient().queryWorkItems("SELECT [System.Id] FROM WorkItems");

    const batchCalls = calls.filter((c) => c.url.includes("ids="));
    expect(batchCalls.length).toBe(2);
  });
});

describe("AzureDevOpsClient work item detail and fields", () => {
  test("getWorkItemDetail expands all fields and relations", async () => {
    const calls = mockFetch(() => ({
      id: 42,
      fields: { "System.Title": "Fix bug", "System.State": "New" },
      relations: [{ rel: "AttachedFile", url: "https://x/attachments/1" }],
    }));

    const detail = await makeClient().getWorkItemDetail("42");

    expect(calls[0].url).toContain("$expand=all");
    expect(detail.fields["System.Title"]).toBe("Fix bug");
    expect(detail.relations.length).toBe(1);
    expect(detail.url).toContain("/MyProject/_workitems/edit/42");
  });

  test("updateWorkItemState sends a JSON patch for System.State", async () => {
    const calls = mockFetch(() => ({}));

    await makeClient().updateWorkItemState(42, "Active");

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toEqual([{ op: "add", path: "/fields/System.State", value: "Active" }]);
  });

  test("updateWorkItemField targets arbitrary field paths", async () => {
    const calls = mockFetch(() => ({}));

    await makeClient().updateWorkItemField(42, "Microsoft.VSTS.Scheduling.StoryPoints", 5);

    expect(calls[0].body).toEqual([
      { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: 5 },
    ]);
  });
});

describe("AzureDevOpsClient comments", () => {
  test("getComments sorts oldest first", async () => {
    mockFetch(() => ({
      comments: [
        { id: 2, text: "later", createdDate: "2026-01-02T00:00:00Z" },
        { id: 1, text: "earlier", createdDate: "2026-01-01T00:00:00Z" },
      ],
    }));

    const comments = await makeClient().getComments(42);
    expect(comments.map((c) => c.id)).toEqual([1, 2]);
  });

  test("addComment posts to the preview comments API and returns id", async () => {
    const calls = mockFetch(() => ({ id: 7 }));

    const id = await makeClient().addComment(42, "<p>done</p>");

    expect(calls[0].url).toContain("/MyProject/_apis/wit/workItems/42/comments");
    expect(calls[0].url).toContain("api-version=7.1-preview.3");
    expect(calls[0].body).toEqual({ text: "<p>done</p>" });
    expect(id).toBe(7);
  });

  test("updateComment patches an existing comment", async () => {
    const calls = mockFetch(() => ({}));

    await makeClient().updateComment(42, 7, "<p>updated</p>");

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/workItems/42/comments/7");
  });
});
