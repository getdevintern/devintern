/**
 * `getBlockers` for GitLab, Azure DevOps, Asana (native blockers) and Trello,
 * markdown (`Depends on:` description lines). The gate that consumes these is
 * covered in `tracker-dependencies.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AsanaTaskTrackerClient } from "../src/lib/trackers/asana/asana-task-tracker-client";
import { AzureDevOpsTaskTrackerClient } from "../src/lib/trackers/azure-devops/azure-devops-task-tracker-client";
import { GitLabTaskTrackerClient } from "../src/lib/trackers/gitlab/gitlab-task-tracker-client";
import {
  MarkdownTaskTrackerClient,
  toMarkdownTaskKey,
} from "../src/lib/trackers/markdown/markdown-task-tracker-client";
import {
  TrelloTaskTrackerClient,
  toTrelloCardKey,
} from "../src/lib/trackers/trello/trello-task-tracker-client";
import { trackerBlockerFacts } from "../src/lib/dependencies/tracker-facts";
import { extractDependsOn } from "../src/lib/utils/general";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchRoute = (url: string) => Response | undefined;

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
let requested: string[] = [];

/** Answer fetches from the first matching route; unmatched URLs fail the test. */
function mockFetch(...routes: FetchRoute[]): void {
  requested = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    for (const route of routes) {
      const response = route(url);
      if (response) return response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch);
}

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe("GitLab getBlockers", () => {
  const link = (overrides: Record<string, unknown>) => ({
    id: 1000,
    project_id: 7,
    title: "x",
    ...overrides,
  });

  test("returns is_blocked_by links (Premium) keyed like polled tasks", async () => {
    mockFetch((url) =>
      url.endsWith("/issues/20/links")
        ? jsonResponse([
            link({
              iid: 12,
              state: "opened",
              link_type: "is_blocked_by",
              references: { full: "acme/webapp#12" },
            }),
            // No `references`: the project comes from the web URL.
            link({
              iid: 11,
              state: "closed",
              link_type: "is_blocked_by",
              web_url: "https://gitlab.com/acme/webapp/-/issues/11",
            }),
            link({
              iid: 5,
              project_id: 8,
              state: "opened",
              link_type: "is_blocked_by",
              references: { full: "acme/api#5" },
            }),
            // Issue 20 blocks 30: not a blocker of 20.
            link({ iid: 30, state: "opened", link_type: "blocks" }),
            link({ iid: 40, state: "opened", link_type: "relates_to" }),
          ])
        : undefined,
    );

    const client = new GitLabTaskTrackerClient("tok", "acme/webapp");
    expect(await client.getBlockers("#20")).toEqual([
      { key: "12", done: false, status: "opened" },
      { key: "11", done: true, status: "closed" },
      { key: "acme/api#5", done: false, status: "opened" },
    ]);
    expect(requested).toEqual(["https://gitlab.com/api/v4/projects/acme%2Fwebapp/issues/20/links"]);
  });

  test("GitLab Free (only relates_to links) reports no blockers", async () => {
    mockFetch((url) =>
      url.endsWith("/issues/20/links")
        ? jsonResponse([
            link({ iid: 12, state: "opened", link_type: "relates_to" }),
            link({ iid: 13, state: "opened", link_type: "relates_to" }),
          ])
        : undefined,
    );
    const client = new GitLabTaskTrackerClient("tok", "acme/webapp");
    expect(await client.getBlockers("20")).toEqual([]);
  });

  test("a numeric project id compares by project_id", async () => {
    mockFetch((url) =>
      url.includes("/projects/7/issues/20/links")
        ? jsonResponse([
            link({
              iid: 12,
              state: "opened",
              link_type: "is_blocked_by",
              references: { full: "acme/webapp#12" },
            }),
            link({
              iid: 5,
              project_id: 8,
              state: "closed",
              link_type: "is_blocked_by",
              references: { full: "acme/api#5" },
            }),
          ])
        : undefined,
    );
    const client = new GitLabTaskTrackerClient("tok", "7", { baseUrl: "https://git.example" });
    expect(await client.getBlockers("20")).toEqual([
      { key: "12", done: false, status: "opened" },
      { key: "acme/api#5", done: true, status: "closed" },
    ]);
  });

  test("API failures throw (the gate keeps the ticket waiting)", async () => {
    mockFetch(() => jsonResponse({ message: "boom" }, 500));
    const client = new GitLabTaskTrackerClient("tok", "acme/webapp");
    await expect(client.getBlockers("20")).rejects.toThrow(/GitLab API error \(500\)/);
  });
});

describe("Azure DevOps getBlockers", () => {
  const org = "https://dev.azure.com/acme";
  const relations = (id: number, rel: string) => ({
    rel,
    url: `${org}/_apis/wit/workItems/${id}`,
    attributes: { isLocked: false, name: rel },
  });
  const workItem20 = (url: string) =>
    url.startsWith(`${org}/_apis/wit/workitems/20?`)
      ? jsonResponse({
          id: 20,
          relations: [
            relations(12, "System.LinkTypes.Dependency-Reverse"),
            relations(11, "System.LinkTypes.Dependency-Reverse"),
            relations(99, "System.LinkTypes.Dependency-Reverse"),
            // 20 is the predecessor of 30: not a blocker of 20.
            relations(30, "System.LinkTypes.Dependency-Forward"),
            relations(40, "System.LinkTypes.Related"),
            { rel: "Hyperlink", url: "https://example.com" },
          ],
        })
      : undefined;
  const batch = (url: string) =>
    url.startsWith(`${org}/_apis/wit/workitems?ids=12,11,99&`)
      ? jsonResponse({
          count: 3,
          value: [
            {
              id: 12,
              fields: {
                "System.State": "Active",
                "System.WorkItemType": "User Story",
                "System.TeamProject": "Shop",
              },
            },
            {
              id: 11,
              fields: {
                "System.State": "Closed",
                "System.WorkItemType": "User Story",
                "System.TeamProject": "Shop",
              },
            },
            // Deleted or unreadable (errorPolicy=omit).
            null,
          ],
        })
      : undefined;

  test("returns predecessors with done from the state category", async () => {
    mockFetch(workItem20, batch, (url) =>
      url.startsWith(`${org}/Shop/_apis/wit/workitemtypes/User%20Story/states?`)
        ? jsonResponse({
            value: [
              { name: "New", category: "Proposed" },
              { name: "Active", category: "InProgress" },
              { name: "Closed", category: "Completed" },
              { name: "Removed", category: "Removed" },
            ],
          })
        : undefined,
    );

    const client = new AzureDevOpsTaskTrackerClient("acme", "pat", "Shop");
    expect(await client.getBlockers("20")).toEqual([
      { key: "12", done: false, status: "Active" },
      { key: "11", done: true, status: "Closed" },
      { key: "99" },
    ]);
    // The type's states are read once, not per predecessor.
    expect(requested.filter((url) => url.includes("/states?"))).toHaveLength(1);
    expect(requested[0]).toContain("$expand=relations");
  });

  test("falls back to default finished state names when states cannot be read", async () => {
    mockFetch(workItem20, batch, (url) =>
      url.includes("/states?") ? jsonResponse({ message: "forbidden" }, 403) : undefined,
    );
    const client = new AzureDevOpsTaskTrackerClient("acme", "pat", "Shop");
    expect(await client.getBlockers("20")).toEqual([
      { key: "12", done: false, status: "Active" },
      { key: "11", done: true, status: "Closed" },
      { key: "99" },
    ]);
  });

  test("a work item without predecessors has no blockers", async () => {
    mockFetch((url) =>
      url.startsWith(`${org}/_apis/wit/workitems/5?`)
        ? jsonResponse({ id: 5, relations: [relations(6, "System.LinkTypes.Related")] })
        : undefined,
    );
    const client = new AzureDevOpsTaskTrackerClient("acme", "pat", "Shop");
    expect(await client.getBlockers("5")).toEqual([]);
    expect(requested).toHaveLength(1);
  });
});

describe("Asana getBlockers", () => {
  test("returns dependencies across pages with their completion", async () => {
    mockFetch((url) => {
      if (!url.includes("/tasks/1200000000000020/dependencies?")) return undefined;
      return url.includes("offset=")
        ? jsonResponse({
            data: [{ gid: "1200000000000013", name: "c", completed: false }],
            next_page: null,
          })
        : jsonResponse({
            data: [
              { gid: "1200000000000011", name: "a", completed: true },
              { gid: "1200000000000012", name: "b", completed: false },
            ],
            next_page: { offset: "page2" },
          });
    });
    const client = new AsanaTaskTrackerClient("tok");
    expect(await client.getBlockers("1200000000000020")).toEqual([
      { key: "1200000000000011", done: true, status: "completed" },
      { key: "1200000000000012", done: false, status: "incomplete" },
      { key: "1200000000000013", done: false, status: "incomplete" },
    ]);
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("offset=page2");
  });

  test("a plan without dependencies (402) reports no blockers", async () => {
    mockFetch(() =>
      jsonResponse({ errors: [{ message: "Dependencies are a premium feature" }] }, 402),
    );
    const client = new AsanaTaskTrackerClient("tok");
    expect(await client.getBlockers("1200000000000020")).toEqual([]);
  });

  test("other API failures throw", async () => {
    mockFetch(() => jsonResponse({ errors: [{ message: "Not authorized" }] }, 401));
    const client = new AsanaTaskTrackerClient("tok");
    await expect(client.getBlockers("1200000000000020")).rejects.toThrow(/Asana API error \(401\)/);
  });
});

describe("Depends on: parsing per tracker key format", () => {
  test("the default still accepts only ad-hoc and Jira-style keys", () => {
    expect(extractDependsOn("Depends on: local-a, PROJ-12, add-login, AbCd1234")).toEqual([
      "local-a",
      "PROJ-12",
    ]);
  });

  test("Trello accepts card URLs, ids, and short links, not plain words", () => {
    const description = [
      "Depends on: https://trello.com/c/Xy12Zw34/5-orders-api, 5f1e2d3c4b5a69788796a5b4",
      "Depends on: Ab3dEfGh and database, Frontend, DATABASE, PROJ-12",
      "Depends on: DynamoDB migration and LinkedIn approval",
      "Depends on: [https://trello.com/c/Qq9wErTy](https://trello.com/c/Qq9wErTy)",
    ].join("\n");
    expect(extractDependsOn(description, toTrelloCardKey)).toEqual([
      "Xy12Zw34",
      "5f1e2d3c4b5a69788796a5b4",
      "Ab3dEfGh",
      "Qq9wErTy",
    ]);
  });

  test("markdown accepts file-name keys with a hyphen or digit", () => {
    expect(
      extractDependsOn(
        "**Depends on**: `api-schema`, Orders-API.md and task2 — the database part",
        toMarkdownTaskKey,
      ),
    ).toEqual(["api-schema", "orders-api", "task2"]);
    expect(
      extractDependsOn("Depends on: the orders API being deployed", toMarkdownTaskKey),
    ).toEqual([]);
  });
});

describe("Trello getBlockers", () => {
  test("reads the card's Depends on: line and each card's list or archive state", async () => {
    mockFetch(
      (url) =>
        url.includes("/cards/TaRg3t01?")
          ? jsonResponse({
              id: "a".repeat(24),
              shortLink: "TaRg3t01",
              name: "Checkout",
              desc: [
                "Build checkout.",
                "",
                "Depends on: https://trello.com/c/Xy12Zw34/5-orders-api, Ab12Cd34, 5f1e2d3c4b5a69788796a5b4, Gh56Ij78, Zz99Zz99",
              ].join("\n"),
              idList: "l1",
              idBoard: "b1",
              labels: [],
              idMembers: [],
              dateLastActivity: "",
              shortUrl: "",
              url: "",
            })
          : undefined,
      (url) =>
        url.includes("/cards/Xy12Zw34?")
          ? jsonResponse({
              id: "x",
              shortLink: "Xy12Zw34",
              closed: false,
              list: { name: "In Progress" },
            })
          : undefined,
      (url) =>
        url.includes("/cards/Ab12Cd34?")
          ? jsonResponse({ id: "y", shortLink: "Ab12Cd34", closed: false, list: { name: "Done" } })
          : undefined,
      // A card id resolves to the card's short link, the key polled cards use.
      (url) =>
        url.includes("/cards/5f1e2d3c4b5a69788796a5b4?")
          ? jsonResponse({
              id: "5f1e2d3c4b5a69788796a5b4",
              shortLink: "Mn34Op56",
              closed: true,
              list: { name: "To Do" },
            })
          : undefined,
      (url) =>
        url.includes("/cards/Gh56Ij78?")
          ? new Response("The requested resource was not found.", { status: 404 })
          : undefined,
      (url) =>
        url.includes("/cards/Zz99Zz99?") ? new Response("invalid id", { status: 400 }) : undefined,
    );

    const client = new TrelloTaskTrackerClient("key", "token");
    expect(await client.getBlockers("TaRg3t01")).toEqual([
      { key: "Xy12Zw34", done: false, status: "In Progress" },
      { key: "Ab12Cd34", done: true, status: "Done" },
      { key: "Mn34Op56", done: true, status: "archived" },
      { key: "Gh56Ij78", status: "not found" },
      { key: "Zz99Zz99", status: "not found" },
    ]);
    const lookup = requested.find((url) => url.includes("/cards/Xy12Zw34?"))!;
    expect(decodeURIComponent(lookup)).toContain("fields=id,shortLink,closed");
  });

  test("a card without a Depends on: line has no blockers", async () => {
    mockFetch(() =>
      jsonResponse({ id: "a", shortLink: "TaRg3t01", desc: "Depends on the API team" }),
    );
    const client = new TrelloTaskTrackerClient("key", "token");
    expect(await client.getBlockers("TaRg3t01")).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  test("Trello failures other than not-found throw", async () => {
    mockFetch(
      (url) =>
        url.includes("/cards/TaRg3t01?")
          ? jsonResponse({ id: "a", shortLink: "TaRg3t01", desc: "Depends on: Xy12Zw34" })
          : undefined,
      () => new Response("unauthorized permission requested", { status: 401 }),
    );
    const client = new TrelloTaskTrackerClient("key", "token");
    await expect(client.getBlockers("TaRg3t01")).rejects.toThrow(/Trello API error \(401\)/);
  });
});

describe("markdown getBlockers", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `md-blockers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function task(name: string, frontmatter: Record<string, string>, body: string): void {
    const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
    writeFileSync(join(dir, `${name}.md`), `---\n${lines.join("\n")}\n---\n\n${body}\n`);
  }

  test("reads the task's Depends on: line and each blocker's status", async () => {
    task("api-schema", { status: "done" }, "# API schema");
    task("orders-api", { status: "in progress" }, "# Orders API");
    // Keyed by frontmatter, not the file name.
    task("payments", { key: "pay-1", status: "Cancelled" }, "# Payments");
    task(
      "checkout",
      { status: "todo" },
      "# Checkout\n\nDepends on: api-schema, orders-api.md, pay-1, ghost-12, local-add-login and third-party, v2 — the rest is prose",
    );

    const client = new MarkdownTaskTrackerClient({ tasksDirectory: dir, cwd: dir });
    expect(await client.getBlockers("checkout")).toEqual([
      { key: "api-schema", done: true, status: "done" },
      { key: "orders-api", done: false, status: "in progress" },
      { key: "pay-1", done: true, status: "Cancelled" },
      // Unresolved but key-shaped: kept, waits for a local run or the file.
      { key: "ghost-12", status: "not found" },
      { key: "local-add-login", status: "not found" },
      // Unresolved prose (`third-party`, `v2`) is not a blocker.
    ]);
  });

  test("finds a mixed-case blocker file name with no key: frontmatter", async () => {
    task("Orders-API", { status: "done" }, "# Orders API");
    task("Api_Schema", { status: "todo" }, "# API schema");
    task("checkout", { status: "todo" }, "# Checkout\n\nDepends on: Orders-API, api-schema");
    const client = new MarkdownTaskTrackerClient({ tasksDirectory: dir, cwd: dir });
    expect((await client.getTask("Orders-API")).key).toBe("orders-api");
    expect(await client.getBlockers("checkout")).toEqual([
      { key: "orders-api", done: true, status: "done" },
      { key: "api-schema", done: false, status: "todo" },
    ]);
  });

  test("a missing Jira-style blocker keeps its case so local facts match it", async () => {
    // `proj-7` has a task file, so the uppercase token resolves to it.
    task("proj-7", { status: "done" }, "# Proj 7");
    task(
      "checkout",
      { status: "todo" },
      "# Checkout\n\nDepends on: PROJ-12, proj-12, PROJ-7, local-Add-Login",
    );
    const client = new MarkdownTaskTrackerClient({ tasksDirectory: dir, cwd: dir });
    const blockers = await client.getBlockers("checkout");
    expect(blockers).toEqual([
      { key: "PROJ-12", status: "not found" },
      { key: "proj-7", done: true, status: "done" },
      // Ad-hoc keys are generated lowercase.
      { key: "local-add-login", status: "not found" },
    ]);
    // The worker's merged PR for PROJ-12 releases the ticket.
    expect(
      trackerBlockerFacts(blockers, [{ key: "PROJ-12", work: "done" }]).map((f) => f.work),
    ).toEqual(["done", "done", "open"]);
  });

  test("a Depends on: line inside frontmatter is not read", async () => {
    task("api-schema", { status: "todo" }, "# API schema");
    task("checkout", { status: "todo", note: "Depends on: api-schema" }, "# Checkout");
    const client = new MarkdownTaskTrackerClient({ tasksDirectory: dir, cwd: dir });
    expect(await client.getBlockers("checkout")).toEqual([]);
  });
});
