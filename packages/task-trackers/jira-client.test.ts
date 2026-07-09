import { describe, expect, test } from "bun:test";
import { JiraClient } from "./src/clients/jira.ts";

describe("JiraClient constructor", () => {
  test("accepts legacy baseUrl/email/token signature", () => {
    const client = new JiraClient("https://acme.atlassian.net/", "user@example.com", "token");
    expect(client.baseUrl).toBe("https://acme.atlassian.net");
  });

  test("accepts domain config object from @devintern/pm", () => {
    const client = new JiraClient({
      domain: "https://acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      defaultProjectKey: "ACME",
      verbose: false,
    });

    expect(client.baseUrl).toBe("https://acme.atlassian.net");
  });

  test("accepts baseUrl config object", () => {
    const client = new JiraClient({
      baseUrl: "https://acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
    });

    expect(client.baseUrl).toBe("https://acme.atlassian.net");
  });

  test("throws when api token is empty", () => {
    expect(
      () =>
        new JiraClient({
          baseUrl: "https://acme.atlassian.net",
          email: "user@example.com",
          apiToken: "",
        }),
    ).toThrow("API token is required");
  });
});

describe("JiraClient REST helpers", () => {
  test("createStory posts ADF issue payload to Jira REST API", async () => {
    const client = new JiraClient({
      domain: "acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      defaultProjectKey: "ACME",
      verbose: false,
    });

    let capturedMethod = "";
    let capturedUrl = "";
    let capturedBody: unknown;

    client.jiraApiCall = async (method: string, url: string, body?: unknown) => {
      capturedMethod = method;
      capturedUrl = url;
      capturedBody = body;
      return { key: "ACME-1", id: "10001" };
    };

    const result = await client.createStory("Login feature", "## Scope\nAdd OAuth", "Story");

    expect(result).toEqual({
      key: "ACME-1",
      id: "10001",
      url: "https://acme.atlassian.net/browse/ACME-1",
    });
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe("/rest/api/3/issue");
    expect(capturedBody).toMatchObject({
      fields: {
        project: { key: "ACME" },
        summary: "Login feature",
        issuetype: { name: "Story" },
      },
    });
  });

  test("createStory requires defaultProjectKey when projectKey is omitted", async () => {
    const client = new JiraClient({
      baseUrl: "https://acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      verbose: false,
    });

    await expect(client.createStory("Task", "Body", "Task")).rejects.toThrow(
      /defaultProjectKey is required/,
    );
  });

  test("getIssueDetails flattens ADF description to plain text", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    client.jiraApiCall = async () => ({
      key: "ACME-2",
      fields: {
        summary: "Improve docs",
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Update README" }],
            },
          ],
        },
        issuetype: { name: "Task" },
        status: { name: "To Do" },
      },
    });

    const details = await client.getIssueDetails("ACME-2");
    expect(details).toEqual({
      key: "ACME-2",
      summary: "Improve docs",
      description: "Update README",
      issueType: "Task",
      status: "To Do",
      url: "https://acme.atlassian.net/browse/ACME-2",
    });
  });

  test("linkToEpic updates parent field via REST API", async () => {
    const client = new JiraClient({
      domain: "acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      defaultProjectKey: "ACME",
      verbose: false,
    });

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    client.jiraApiCall = async (method, url, body) => {
      calls.push({ method, url, body });
      return null;
    };

    await client.linkToEpic("ACME-10", "ACME-1");

    expect(calls).toEqual([
      {
        method: "PUT",
        url: "/rest/api/3/issue/ACME-10",
        body: {
          fields: {
            parent: { key: "ACME-1" },
          },
        },
      },
    ]);
  });

  test("uses combined email:token credential for auth header", async () => {
    const client = new JiraClient(
      "https://acme.atlassian.net",
      "ignored@example.com",
      "user@example.com:combined-token",
    );

    const originalFetch = globalThis.fetch;
    let authHeader = "";

    globalThis.fetch = async (_url, init) => {
      authHeader = String(init?.headers?.Authorization ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      await client.jiraApiCall("GET", "/rest/api/3/myself");
      const decoded = Buffer.from(authHeader.replace("Basic ", ""), "base64").toString("utf8");
      expect(decoded).toBe("user@example.com:combined-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getIssueComments returns comments from API", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    client.jiraApiCall = async (method, url) => {
      expect(method).toBe("GET");
      expect(url).toBe("/rest/api/3/issue/ACME-5/comment?expand=renderedBody");
      return {
        comments: [
          {
            id: "10",
            body: "Looks good",
            author: { displayName: "Reviewer" },
            created: "2024-01-01",
            updated: "2024-01-01",
          },
        ],
      };
    };

    const comments = await client.getIssueComments("ACME-5");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe("10");
  });

  test("getIssueComments returns empty array on API error", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");
    client.jiraApiCall = async () => {
      throw new Error("network failure");
    };

    const comments = await client.getIssueComments("ACME-5");
    expect(comments).toEqual([]);
  });

  test("postComment posts plain text as ADF", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    let capturedBody: unknown;
    client.jiraApiCall = async (method, url, body) => {
      capturedBody = body;
      expect(method).toBe("POST");
      expect(url).toBe("/rest/api/3/issue/ACME-6/comment");
      return { id: "20" };
    };

    await client.postComment("ACME-6", "Ship it");

    expect(capturedBody).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Ship it" }],
          },
        ],
      },
    });
  });

  test("transitionIssue selects matching transition and posts it", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    client.jiraApiCall = async (method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith("/transitions") && method === "GET") {
        return {
          transitions: [
            { id: "11", to: { name: "In Progress" } },
            { id: "21", to: { name: "Done" } },
          ],
        };
      }
      return null;
    };

    await client.transitionIssue("ACME-7", "done");

    expect(calls).toEqual([
      { method: "GET", url: "/rest/api/3/issue/ACME-7/transitions" },
      {
        method: "POST",
        url: "/rest/api/3/issue/ACME-7/transitions",
        body: { transition: { id: "21" } },
      },
    ]);
  });

  test("searchIssues returns parsed issue list", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    client.jiraApiCall = async (method, url) => {
      expect(method).toBe("GET");
      expect(url).toContain("/rest/api/3/search/jql?");
      expect(url).toContain(encodeURIComponent("project = ACME"));
      return {
        issues: [{ key: "ACME-1" }, { key: "ACME-2" }],
        total: 2,
      };
    };

    const result = await client.searchIssues("project = ACME");
    expect(result).toEqual({
      issues: [{ key: "ACME-1" }, { key: "ACME-2" }],
      total: 2,
    });
  });

  test("updateStoryPoints sets field via PUT", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    let capturedBody: unknown;
    client.jiraApiCall = async (method, url, body) => {
      if (method === "GET" && url === "/rest/api/3/field") {
        return [{ id: "customfield_10016", name: "Story Points" }];
      }
      capturedBody = body;
      expect(method).toBe("PUT");
      expect(url).toBe("/rest/api/3/issue/ACME-8");
      return null;
    };

    await client.updateStoryPoints("ACME-8", "customfield_10016", 5);

    expect(capturedBody).toEqual({
      fields: { customfield_10016: 5 },
    });
  });

  test("discoverStoryPointsField prefers editable field from editmeta", async () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");

    client.jiraApiCall = async (method, url) => {
      if (method === "GET" && url === "/rest/api/3/field") {
        return [
          { id: "customfield_10016", name: "Story Points" },
          { id: "customfield_10020", name: "Story Point Estimate" },
        ];
      }
      if (method === "GET" && url === "/rest/api/3/issue/ACME-9/editmeta") {
        return {
          fields: {
            customfield_10020: { required: false },
          },
        };
      }
      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const fieldId = await client.discoverStoryPointsField("ACME-9");
    expect(fieldId).toBe("customfield_10020");
  });
});

describe("JiraClient verbose logging", () => {
  test("defaults to quiet (verbose=false)", () => {
    const client = new JiraClient("https://acme.atlassian.net", "user@example.com", "token");
    expect((client as any).verbose).toBe(false);
  });

  test("verbose=true logs API calls", async () => {
    const client = new JiraClient({
      domain: "acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      defaultProjectKey: "ACME",
      verbose: true,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ key: "ACME-1", id: "10001" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    try {
      await client.createStory("Test", "Body", "Story");
      expect(logs.some((l) => l.includes("JIRA API Call"))).toBe(true);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    }
  });

  test("verbose=false suppresses API call logs", async () => {
    const client = new JiraClient({
      domain: "acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      defaultProjectKey: "ACME",
      verbose: false,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    client.jiraApiCall = async () => ({ key: "ACME-1" });

    try {
      await client.createStory("Test", "Body", "Story");
      expect(logs).toEqual([]);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});
