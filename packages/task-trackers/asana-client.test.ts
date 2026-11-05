import { afterEach, describe, expect, test } from "bun:test";
import { AsanaClient, parseAsanaTaskFilters } from "./src/clients/asana.ts";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.ASANA_API_BASE_URL;
const originalE2eFlag = process.env.DEVINTERN_E2E_FAKE_ASANA;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("ASANA_API_BASE_URL", originalBaseUrl);
  restoreEnv("DEVINTERN_E2E_FAKE_ASANA", originalE2eFlag);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

type AsanaModule = typeof import("./src/clients/asana.ts");

let importCounter = 0;

/**
 * Evaluate the Asana client module against the current environment.
 *
 * A unique query string forces Bun to re-run module evaluation, which lets a
 * test distinguish spawn-time variables (snapshotted on import) from `.env`
 * values applied later.
 */
async function importAsanaModule(): Promise<AsanaModule> {
  importCounter += 1;
  return (await import(`./src/clients/asana.ts?env=${importCounter}`)) as AsanaModule;
}

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

describe("AsanaClient endpoint override", () => {
  test("constructor baseUrl is used for REST requests", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    const client = new AsanaClient({
      apiToken: "pat",
      baseUrl: "http://127.0.0.1:1/api/1.0",
    });
    await client.getTaskDetail("123456");

    expect(calls[0].url).toStartWith("http://127.0.0.1:1/api/1.0/tasks/123456?opt_fields=");
  });

  test("trims whitespace and strips trailing slashes from an explicit baseUrl", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    const client = new AsanaClient({
      apiToken: "pat",
      baseUrl: "  http://127.0.0.1:1/api/1.0/  ",
    });
    await client.getTaskDetail("123456");

    expect(calls[0].url).toStartWith("http://127.0.0.1:1/api/1.0/tasks/123456?opt_fields=");
    expect(calls[0].url).not.toContain("//tasks");
  });

  test("treats an empty explicit baseUrl as absent", async () => {
    delete process.env.ASANA_API_BASE_URL;
    const calls = mockFetch(() => ({ json: {} }));

    await new AsanaClient({ apiToken: "pat", baseUrl: "   " }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("https://app.asana.com/api/1.0/tasks/123456?opt_fields=");
  });

  test("rejects an invalid explicit baseUrl", () => {
    expect(() => new AsanaClient({ apiToken: "pat", baseUrl: "not a url" })).toThrow(
      'Invalid Asana baseUrl "not a url"',
    );
  });

  test("ASANA_API_BASE_URL overrides the endpoint behind the E2E flag", async () => {
    process.env.DEVINTERN_E2E_FAKE_ASANA = "1";
    process.env.ASANA_API_BASE_URL = "http://127.0.0.1:2/api/1.0";
    const { AsanaClient: FlaggedClient } = await importAsanaModule();
    const calls = mockFetch(() => ({ json: {} }));

    await new FlaggedClient({ apiToken: "pat" }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("http://127.0.0.1:2/api/1.0/tasks/123456?opt_fields=");
  });

  test("ignores ASANA_API_BASE_URL unless the E2E flag is set", async () => {
    delete process.env.DEVINTERN_E2E_FAKE_ASANA;
    process.env.ASANA_API_BASE_URL = "https://attacker.example/api/1.0";
    const { AsanaClient: UnflaggedClient } = await importAsanaModule();
    const calls = mockFetch(() => ({ json: {} }));

    await new UnflaggedClient({ apiToken: "pat" }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("https://app.asana.com/api/1.0/tasks/123456?opt_fields=");
  });

  test("ignores override values that appear after the module is loaded", async () => {
    delete process.env.DEVINTERN_E2E_FAKE_ASANA;
    delete process.env.ASANA_API_BASE_URL;
    const { AsanaClient: LoadedClient } = await importAsanaModule();

    // Model a project `.env` loader (dotenv or loadEnvFromConfigDir) mutating
    // process.env after the CLI imports its clients.
    process.env.DEVINTERN_E2E_FAKE_ASANA = "1";
    process.env.ASANA_API_BASE_URL = "http://127.0.0.1:2/api/1.0";
    const calls = mockFetch(() => ({ json: {} }));

    await new LoadedClient({ apiToken: "pat" }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("https://app.asana.com/api/1.0/tasks/123456?opt_fields=");
  });

  test("rejects a non-loopback ASANA_API_BASE_URL when the E2E flag is set", async () => {
    process.env.DEVINTERN_E2E_FAKE_ASANA = "1";
    process.env.ASANA_API_BASE_URL = "https://attacker.example/api/1.0";
    const { AsanaClient: FlaggedClient } = await importAsanaModule();

    expect(() => new FlaggedClient({ apiToken: "pat" })).toThrow(
      "ASANA_API_BASE_URL may only point at a loopback fake server",
    );
  });

  test("treats an empty ASANA_API_BASE_URL placeholder as absent", async () => {
    process.env.DEVINTERN_E2E_FAKE_ASANA = "1";
    process.env.ASANA_API_BASE_URL = "   ";
    const { AsanaClient: FlaggedClient } = await importAsanaModule();
    const calls = mockFetch(() => ({ json: {} }));

    await new FlaggedClient({ apiToken: "pat" }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("https://app.asana.com/api/1.0/tasks/123456?opt_fields=");
  });

  test("strips trailing slashes from ASANA_API_BASE_URL", async () => {
    process.env.DEVINTERN_E2E_FAKE_ASANA = "1";
    process.env.ASANA_API_BASE_URL = "http://127.0.0.1:2/api/1.0//";
    const { AsanaClient: FlaggedClient } = await importAsanaModule();
    const calls = mockFetch(() => ({ json: {} }));

    await new FlaggedClient({ apiToken: "pat" }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("http://127.0.0.1:2/api/1.0/tasks/123456?opt_fields=");
    expect(calls[0].url).not.toContain("/api/1.0//tasks");
  });

  test("keeps the production base URL when no override is set", async () => {
    delete process.env.ASANA_API_BASE_URL;
    delete process.env.DEVINTERN_E2E_FAKE_ASANA;
    const { AsanaClient: PlainClient } = await importAsanaModule();
    const calls = mockFetch(() => ({ json: {} }));

    await new PlainClient({ apiToken: "pat" }).getTaskDetail("123456");

    expect(calls[0].url).toStartWith("https://app.asana.com/api/1.0/tasks/123456?opt_fields=");
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
  test("detail and search requests ask for memberships and tags", async () => {
    const calls = mockFetch(() => ({ json: [] }));

    await makeClient().getTaskDetail("123456");
    await makeClient().searchTasks({ projectGid: "12345" });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // Section selection and label assertions depend on these fields; the
      // fake projects onto opt_fields, so dropping one fails the e2e lifecycle.
      expect(call.url).toContain("memberships.project.gid");
      expect(call.url).toContain("memberships.section.name");
      expect(call.url).toContain("tags.gid");
      expect(call.url).toContain("tags.name");
    }
  });

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
