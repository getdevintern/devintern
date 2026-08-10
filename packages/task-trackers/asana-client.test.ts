import { afterEach, describe, expect, test } from "bun:test";
import { AsanaClient, parseAsanaTaskFilters } from "./src/clients/asana.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type CapturedRequest = { url: string; method: string; body?: unknown };

function mockFetch(
  handler: (req: CapturedRequest) => {
    status?: number;
    json?: unknown;
    next_page?: { offset?: string } | null;
  },
) {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const result = handler(req);
    return new Response(
      JSON.stringify({ data: result.json ?? {}, next_page: result.next_page ?? undefined }),
      {
        status: result.status ?? 200,
      },
    );
  }) as typeof fetch;
  return calls;
}

function makeClient(): AsanaClient {
  return new AsanaClient({ apiToken: "pat" });
}

describe("parseAsanaTaskFilters", () => {
  test("parses key:value pairs and free text", () => {
    const filters = parseAsanaTaskFilters(
      'project:12345 section:"To Do" completed:false login bug',
    );
    expect(filters).toEqual({
      projectGid: "12345",
      sectionName: "To Do",
      completed: false,
      text: "login bug",
    });
  });

  test("parses assignee and defaults", () => {
    expect(parseAsanaTaskFilters("assignee:Ada completed:true")).toEqual({
      assignee: "Ada",
      completed: true,
    });
    expect(parseAsanaTaskFilters("just some text")).toEqual({ text: "just some text" });
  });
});

describe("AsanaClient.searchTasks", () => {
  const tasks = [
    {
      gid: "1",
      name: "Fix login bug",
      permalink_url: "u",
      completed: false,
      memberships: [{ section: { gid: "s1", name: "To Do" } }],
    },
    {
      gid: "2",
      name: "Write docs",
      permalink_url: "u",
      completed: true,
      memberships: [{ section: { gid: "s2", name: "Done" } }],
    },
  ];

  test("lists project tasks and filters client-side", async () => {
    const calls = mockFetch(() => ({ json: tasks }));

    const result = await makeClient().searchTasks({
      projectGid: "12345",
      completed: false,
      sectionName: "to do",
    });

    expect(calls[0].url).toContain("/projects/12345/tasks");
    expect(calls[0].url).toContain("limit=100");
    expect(result.total).toBe(1);
    expect(result.tasks[0].gid).toBe("1");
  });

  test("filters by name text", async () => {
    mockFetch(() => ({ json: tasks }));

    const result = await makeClient().searchTasks({ projectGid: "12345", text: "docs" });
    expect(result.tasks.map((t) => t.gid)).toEqual(["2"]);
  });

  test("throws without a project gid", async () => {
    await expect(makeClient().searchTasks({})).rejects.toThrow(
      "Asana task search requires a project",
    );
  });
});

describe("AsanaClient stories", () => {
  test("getStories filters to comments and sorts oldest first", async () => {
    mockFetch(() => ({
      json: [
        { gid: "b", resource_subtype: "comment_added", text: "later", created_at: "2026-01-02" },
        { gid: "s", resource_subtype: "section_changed", text: "moved", created_at: "2026-01-01" },
        { gid: "a", resource_subtype: "comment_added", text: "earlier", created_at: "2026-01-01" },
      ],
    }));

    const stories = await makeClient().getStories("1");
    expect(stories.map((s) => s.gid)).toEqual(["a", "b"]);
  });

  test("createStory falls back to plain text on xml_parsing_error", async () => {
    const calls = mockFetch((req) => {
      if ((req.body as { data?: { html_text?: string } })?.data?.html_text) {
        return { status: 400, json: { message: "xml_parsing_error: bad tag" } };
      }
      return { json: { gid: "story-1" } };
    });

    // Simulate the error body shape Asana returns
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init?.method || "GET", body });
      if (body?.data?.html_text) {
        return new Response("xml_parsing_error: bad tag", { status: 400 });
      }
      return new Response(JSON.stringify({ data: { gid: "story-1" } }), { status: 200 });
    }) as typeof fetch;

    const gid = await makeClient().createStory("1", "**bold**");

    expect(gid).toBe("story-1");
    const lastCall = calls[calls.length - 1];
    expect((lastCall.body as { data: { text: string } }).data.text).toBe("**bold**");
  });

  test("updateStory puts to the story endpoint", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().updateStory("story-9", "updated");

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/stories/story-9");
  });
});

describe("AsanaClient sections and fields", () => {
  test("moveTaskToSection posts addTask", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().moveTaskToSection("sec-1", "task-1");

    expect(calls[0].url).toContain("/sections/sec-1/addTask");
    expect(calls[0].body).toEqual({ data: { task: "task-1" } });
  });

  test("setCompleted puts completed flag", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().setCompleted("task-1", true);

    expect(calls[0].body).toEqual({ data: { completed: true } });
  });

  test("updateCustomField targets the field gid", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().updateCustomField("task-1", "field-7", 5);

    expect(calls[0].body).toEqual({ data: { custom_fields: { "field-7": 5 } } });
  });
});

describe("AsanaClient tags", () => {
  test("resolveWorkspaceGid uses project workspace when provided", async () => {
    const calls = mockFetch(() => ({ json: { workspace: { gid: "ws-9" } } }));

    const workspaceGid = await makeClient().resolveWorkspaceGid("proj-1");

    expect(calls[0].url).toContain("/projects/proj-1");
    expect(calls[0].url).toContain("opt_fields=workspace.gid");
    expect(workspaceGid).toBe("ws-9");
  });

  test("resolveWorkspaceGid falls back to first workspace", async () => {
    mockFetch(() => ({ json: [{ gid: "ws-1" }, { gid: "ws-2" }] }));

    expect(await makeClient().resolveWorkspaceGid()).toBe("ws-1");
  });

  test("getTags paginates until exhausted", async () => {
    let page = 0;
    const calls = mockFetch(() => {
      page += 1;
      if (page === 1) {
        return {
          json: Array.from({ length: 100 }, (_, i) => ({ gid: `t${i}`, name: `n${i}` })),
          next_page: { offset: "cursor-2" },
        };
      }
      return {
        json: [{ gid: "t100", name: "n100" }],
        next_page: null,
      };
    });

    const result = await makeClient().getTags("ws-1");

    expect(calls.length).toBe(2);
    expect(calls[1].url).toContain("offset=cursor-2");
    expect(result.tags.length).toBe(101);
    expect(result.truncated).toBe(false);
  });

  test("getTags reports truncated at soft cap", async () => {
    mockFetch(() => ({
      json: Array.from({ length: 100 }, (_, i) => ({ gid: `t${i}`, name: `n${i}` })),
      next_page: { offset: "more" },
    }));

    const result = await makeClient().getTags("ws-1", 100);
    expect(result.tags.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  test("addTagToTask posts tag gid", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().addTagToTask("task-1", "tag-9");

    expect(calls[0].url).toContain("/tasks/task-1/addTag");
    expect(calls[0].body).toEqual({ data: { tag: "tag-9" } });
  });
});
