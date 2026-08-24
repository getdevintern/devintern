import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_GITLAB_BASE_URL, GitLabClient } from "./src/clients/gitlab.ts";
import { parseGitLabProject, sanitizeGitlabBaseUrl } from "./src/config/load-tracker-config.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type CapturedRequest = { url: string; method: string; body?: unknown };

function mockFetch(
  handler: (req: CapturedRequest) => {
    status?: number;
    json?: unknown;
    headers?: Record<string, string>;
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
    return new Response(JSON.stringify(result.json ?? {}), {
      status: result.status ?? 200,
      headers: result.headers,
    });
  }) as typeof fetch;
  return calls;
}

function makeClient(overrides?: Partial<{ baseUrl: string }>): GitLabClient {
  return new GitLabClient({
    token: "glpat-tok",
    projectPath: "acme/team/webapp",
    baseUrl: overrides?.baseUrl,
  });
}

describe("GitLabClient", () => {
  test("defaults to gitlab.com and encodes subgroup paths", async () => {
    const calls = mockFetch(() => ({ json: [] }));

    await makeClient().getProjects();

    expect(calls[0].url).toContain(`${DEFAULT_GITLAB_BASE_URL}/api/v4`);
    await makeClient().getIssue(7);
    expect(calls[1].url).toContain("/projects/acme%2Fteam%2Fwebapp/issues/7");
  });

  test("normalizes custom base URLs with trailing slashes", () => {
    const client = new GitLabClient({
      token: "t",
      projectPath: "a/b",
      baseUrl: "https://gitlab.example.com/",
    });
    // @ts-expect-error accessing private field for assertion
    expect(client.baseUrl).toBe("https://gitlab.example.com");
  });

  test("sends PRIVATE-TOKEN header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 1, username: "tester", name: "Tester" }), {
        status: 200,
      });
    }) as typeof fetch;

    await makeClient().getCurrentUser();

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("PRIVATE-TOKEN")).toBe("glpat-tok");
    expect(calls[0].url).toBe("https://gitlab.com/api/v4/user");
  });

  test("createIssue posts title/description and comma-joined labels", async () => {
    const calls = mockFetch(() => ({
      json: { iid: 12, web_url: "https://gitlab.com/acme/team/webapp/-/issues/12" },
    }));

    const issue = await makeClient().createIssue("Add auth", "Implement OAuth", [
      "enhancement",
      "backend",
    ]);

    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      title: "Add auth",
      description: "Implement OAuth",
      labels: "enhancement,backend",
    });
    expect(issue.iid).toBe(12);
  });

  test("createIssue omits blank descriptions instead of sending empty string", async () => {
    const calls = mockFetch(() => ({ json: { iid: 13, web_url: "u" } }));

    await makeClient().createIssue("Title", "", []);

    expect(calls[0].body).toEqual({ title: "Title" });
  });

  test("updateIssue maps state to state_event values", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().updateIssue(5, { state: "closed" });
    expect(calls[0].body).toEqual({ state_event: "close" });

    await makeClient().updateIssue(5, { state: "opened" });
    expect(calls[1].body).toEqual({ state_event: "reopen" });
  });

  test("addLabels uses add_labels so existing labels are kept", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().addLabels(9, ["In Progress"]);

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toEqual({ add_labels: "In Progress" });
  });

  test("addLabels is a no-op for an empty list", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().addLabels(9, []);

    expect(calls).toHaveLength(0);
  });

  test("removeLabel deletes via remove_labels and swallows 404", async () => {
    mockFetch(() => ({ json: {} }));
    await expect(makeClient().removeLabel(7, "gone")).resolves.toBeUndefined();

    mockFetch(() => ({ status: 404, json: { message: "404 Not Found" } }));
    await expect(makeClient().removeLabel(7, "gone")).resolves.toBeUndefined();
  });

  test("listIssueComments filters system notes", async () => {
    mockFetch(() => ({
      json: [
        {
          id: 1,
          body: "changed the description",
          system: true,
          author: null,
          created_at: "",
          updated_at: "",
        },
        {
          id: 2,
          body: "Looks good",
          system: false,
          author: { username: "alice" },
          created_at: "",
          updated_at: "",
        },
      ],
    }));

    const comments = await makeClient().listIssueComments(3);

    expect(comments.map((c) => c.id)).toEqual([2]);
  });

  test("updateIssueComment patches a note by id", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().updateIssueComment(99, "updated");

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/projects/acme%2Fteam%2Fwebapp/notes/99");
    expect(calls[0].body).toEqual({ body: "updated" });
  });

  test("searchIssues translates qualifiers into list params", async () => {
    const calls = mockFetch(() => ({ json: [], headers: { "x-total": "42" } }));

    const result = await makeClient().searchIssues('is:open label:"needs review" login flow');

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v4/projects/acme%2Fteam%2Fwebapp/issues");
    expect(url.searchParams.get("state")).toBe("opened");
    expect(url.searchParams.get("labels")).toBe("needs review");
    expect(url.searchParams.get("search")).toBe("login flow");
    expect(result.total).toBe(42);
  });

  test("searchIssues resolves assignee:@me through /user", async () => {
    const calls = mockFetch((req) => {
      if (req.url.includes("/api/v4/user")) {
        return { json: { id: 1, username: "tester", name: "Tester" } };
      }
      return { json: [] };
    });

    await makeClient().searchIssues("assignee:@me");

    const issuesCall = calls.find((c) => c.url.includes("/issues"));
    expect(new URL(issuesCall!.url).searchParams.get("assignee_username")).toBe("tester");
  });

  test("searchIssues maps updated:>= to updated_after", async () => {
    const calls = mockFetch(() => ({ json: [] }));

    await makeClient().searchIssues("updated:>=2026-01-31T00:00:00Z");

    expect(new URL(calls[0].url).searchParams.get("updated_after")).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });

  test("searchIssues falls back to result length when x-total is absent", async () => {
    mockFetch(() => ({ json: [{ iid: 1 }, { iid: 2 }] }));

    const result = await makeClient().searchIssues("");

    expect(result.total).toBe(2);
  });

  test("getLabels paginates until a short page", async () => {
    const calls = mockFetch((req) => {
      const page = new URL(req.url).searchParams.get("page");
      if (page === "1") {
        return {
          json: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            name: `label-${i}`,
            description: null,
          })),
        };
      }
      return { json: [{ id: 100, name: "label-100", description: "last" }] };
    });

    const result = await makeClient().getLabels();

    expect(result.labels).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(result.labels[100]?.name).toBe("label-100");
    expect(calls).toHaveLength(2);
  });
});

describe("sanitizeGitlabBaseUrl", () => {
  test("defaults to gitlab.com when unset or blank", () => {
    expect(sanitizeGitlabBaseUrl(undefined)).toBe(DEFAULT_GITLAB_BASE_URL);
    expect(sanitizeGitlabBaseUrl("  ")).toBe(DEFAULT_GITLAB_BASE_URL);
  });

  test("adds https:// when the protocol is missing and strips trailing slashes", () => {
    expect(sanitizeGitlabBaseUrl("gitlab.example.com")).toBe("https://gitlab.example.com");
    expect(sanitizeGitlabBaseUrl("http://gitlab.internal:8080///")).toBe(
      "http://gitlab.internal:8080",
    );
    expect(sanitizeGitlabBaseUrl("https://gitlab.example.com/")).toBe("https://gitlab.example.com");
  });
});

describe("parseGitLabProject", () => {
  test("accepts group/repo and subgroup paths", () => {
    expect(parseGitLabProject("acme/my-app")).toBe("acme/my-app");
    expect(parseGitLabProject("acme/team/my-app")).toBe("acme/team/my-app");
  });

  test("accepts numeric project IDs", () => {
    expect(parseGitLabProject("42179")).toBe("42179");
  });

  test("strips origins, slashes, and /-/ suffixes from pasted URLs", () => {
    expect(parseGitLabProject("https://gitlab.com/acme/my-app")).toBe("acme/my-app");
    expect(parseGitLabProject("https://gitlab.internal/acme/team/my-app/-/issues")).toBe(
      "acme/team/my-app",
    );
    expect(parseGitLabProject("/acme/my-app/")).toBe("acme/my-app");
  });

  test("throws on empty values and bare namespaces", () => {
    expect(() => parseGitLabProject("")).toThrow(/Invalid GITLAB_PROJECT/);
    expect(() => parseGitLabProject("just-a-name")).toThrow(/Invalid GITLAB_PROJECT/);
    expect(() => parseGitLabProject("https://gitlab.com")).toThrow(/Invalid GITLAB_PROJECT/);
  });
});
