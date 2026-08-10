import { afterEach, describe, expect, test } from "bun:test";
import { GitHubClient } from "./src/clients/github.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type CapturedRequest = { url: string; method: string; body?: unknown };

function mockFetch(handler: (req: CapturedRequest) => { status?: number; json?: unknown }) {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const result = handler(req);
    return new Response(JSON.stringify(result.json ?? {}), { status: result.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

function makeClient(): GitHubClient {
  return new GitHubClient({ token: "tok", owner: "acme", repo: "webapp" });
}

describe("GitHubClient.searchIssues", () => {
  test("prepends repo and is:issue scope to the query", async () => {
    const calls = mockFetch(() => ({
      json: { total_count: 1, items: [{ number: 5, html_url: "u", title: "t", body: null }] },
    }));

    const result = await makeClient().searchIssues("is:open label:bug");

    expect(decodeURIComponent(calls[0].url)).toContain(
      "repo:acme/webapp is:issue is:open label:bug",
    );
    expect(result.total).toBe(1);
    expect(result.issues[0].number).toBe(5);
  });

  test("does not double-scope when query already has repo:", async () => {
    const calls = mockFetch(() => ({ json: { total_count: 0, items: [] } }));

    await makeClient().searchIssues("repo:other/repo is:open");

    const url = decodeURIComponent(calls[0].url);
    expect(url).toContain("repo:other/repo is:open");
    expect(url).not.toContain("acme/webapp");
  });

  test("filters pull requests out of results", async () => {
    mockFetch(() => ({
      json: {
        total_count: 2,
        items: [
          { number: 1, html_url: "u", title: "issue", body: null },
          { number: 2, html_url: "u", title: "pr", body: null, pull_request: {} },
        ],
      },
    }));

    const result = await makeClient().searchIssues("is:open");
    expect(result.issues.map((i) => i.number)).toEqual([1]);
  });
});

describe("GitHubClient comments", () => {
  test("listIssueComments hits the comments endpoint", async () => {
    const calls = mockFetch(() => ({ json: [] }));

    await makeClient().listIssueComments(7);

    expect(calls[0].url).toContain("/repos/acme/webapp/issues/7/comments");
  });

  test("createIssueComment posts markdown body", async () => {
    const calls = mockFetch(() => ({ json: { id: 99 } }));

    const comment = await makeClient().createIssueComment(7, "**done**");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ body: "**done**" });
    expect(comment.id).toBe(99);
  });

  test("updateIssueComment patches by comment id", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().updateIssueComment(99, "updated");

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/issues/comments/99");
  });
});

describe("GitHubClient.removeLabel", () => {
  test("deletes the label with URL encoding", async () => {
    const calls = mockFetch(() => ({ json: {} }));

    await makeClient().removeLabel(7, "In Progress");

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("/issues/7/labels/In%20Progress");
  });

  test("swallows 404 for missing labels", async () => {
    mockFetch(() => ({ status: 404, json: { message: "Not Found" } }));

    await expect(makeClient().removeLabel(7, "gone")).resolves.toBeUndefined();
  });
});

describe("GitHubClient.getLabels", () => {
  test("paginates until a short page", async () => {
    const calls = mockFetch((req) => {
      const page = new URL(req.url).searchParams.get("page");
      if (page === "1") {
        return {
          json: Array.from({ length: 100 }, (_, i) => ({
            name: `label-${i}`,
            description: null,
          })),
        };
      }
      return { json: [{ name: "label-100", description: "last" }] };
    });

    const result = await makeClient().getLabels();

    expect(result.labels).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(result.labels[0]?.name).toBe("label-0");
    expect(result.labels[100]?.name).toBe("label-100");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("page")).toBe("1");
    expect(new URL(calls[1]!.url).searchParams.get("page")).toBe("2");
  });

  test("sets truncated when soft cap stops paging", async () => {
    const calls = mockFetch((req) => {
      const page = new URL(req.url).searchParams.get("page");
      return {
        json: Array.from({ length: 100 }, (_, i) => ({
          name: `label-${(Number(page) - 1) * 100 + i}`,
          description: null,
        })),
      };
    });

    const result = await makeClient().getLabels(150);
    expect(result.labels).toHaveLength(150);
    expect(result.truncated).toBe(true);
    // Full page at/past the cap probes one sentinel page before truncating.
    expect(calls).toHaveLength(3);
  });

  test("sets truncated when a short final page overshoots the soft cap", async () => {
    mockFetch((req) => {
      const page = new URL(req.url).searchParams.get("page");
      if (page === "1") {
        return {
          json: Array.from({ length: 100 }, (_, i) => ({
            name: `label-${i}`,
            description: null,
          })),
        };
      }
      // Fewer than per_page, but still enough to push past maxLabels=150.
      return {
        json: Array.from({ length: 80 }, (_, i) => ({
          name: `label-${100 + i}`,
          description: null,
        })),
      };
    });

    const result = await makeClient().getLabels(150);
    expect(result.labels).toHaveLength(150);
    expect(result.truncated).toBe(true);
    expect(result.labels[149]?.name).toBe("label-149");
  });

  test("does not set truncated when exact soft cap is the full catalog", async () => {
    const calls = mockFetch((req) => {
      const page = Number(new URL(req.url).searchParams.get("page"));
      if (page <= 2) {
        return {
          json: Array.from({ length: 100 }, (_, i) => ({
            name: `label-${(page - 1) * 100 + i}`,
            description: null,
          })),
        };
      }
      return { json: [] };
    });

    const result = await makeClient().getLabels(200);
    expect(result.labels).toHaveLength(200);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[2]!.url).searchParams.get("page")).toBe("3");
  });
});
