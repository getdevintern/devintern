import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AsanaTaskTrackerClient } from "../src/lib/trackers/asana/asana-task-tracker-client";
import { AzureDevOpsTaskTrackerClient } from "../src/lib/trackers/azure-devops/azure-devops-task-tracker-client";
import { GitLabTaskTrackerClient } from "../src/lib/trackers/gitlab/gitlab-task-tracker-client";
import {
  MarkdownTaskTrackerClient,
  markdownDependencyKey,
} from "../src/lib/trackers/markdown/markdown-task-tracker-client";
import {
  TrelloTaskTrackerClient,
  trelloDependencyKey,
} from "../src/lib/trackers/trello/trello-task-tracker-client";
import { extractDependsOn } from "../src/lib/utils/general";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchSpy = ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

/** Route mocked fetches by URL substring; unmatched URLs fail the test. */
function mockFetch(
  routes: Array<[string | RegExp, () => Response]>,
  urls: string[] = [],
): FetchSpy {
  return spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    for (const [pattern, respond] of routes) {
      if (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)) return respond();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch);
}

describe("GitLab getBlockers", () => {
  let fetchSpy: FetchSpy | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  test("returns is_blocked_by links, keyed by iid in the project and by reference elsewhere", async () => {
    const urls: string[] = [];
    fetchSpy = mockFetch(
      [
        [
          "/issues/20/links",
          () =>
            jsonResponse([
              {
                iid: 12,
                project_id: 7,
                state: "opened",
                link_type: "is_blocked_by",
                references: { full: "acme/webapp#12" },
              },
              {
                iid: 11,
                project_id: 7,
                state: "closed",
                link_type: "is_blocked_by",
                references: { full: "Acme/WebApp#11" },
              },
              {
                iid: 5,
                project_id: 9,
                state: "opened",
                link_type: "is_blocked_by",
                references: { full: "acme/api#5" },
              },
              // The ticket blocks #30: not one of its blockers.
              { iid: 30, project_id: 7, state: "opened", link_type: "blocks" },
              { iid: 40, project_id: 7, state: "opened", link_type: "relates_to" },
            ]),
        ],
      ],
      urls,
    );

    const client = new GitLabTaskTrackerClient("tok", "acme/webapp", {
      baseUrl: "https://gitlab.example",
    });
    expect(await client.getBlockers("#20")).toEqual([
      { key: "12", done: false, status: "opened" },
      { key: "11", done: true, status: "closed" },
      { key: "acme/api#5", done: false, status: "opened" },
    ]);
    expect(urls).toEqual(["https://gitlab.example/api/v4/projects/acme%2Fwebapp/issues/20/links"]);
  });

  test("a numeric project id matches same-project blockers by project_id", async () => {
    fetchSpy = mockFetch([
      [
        "/links",
        () =>
          jsonResponse([
            {
              iid: 3,
              project_id: 42,
              state: "opened",
              link_type: "is_blocked_by",
              references: { full: "acme/webapp#3" },
            },
          ]),
      ],
    ]);
    const client = new GitLabTaskTrackerClient("tok", "42");
    expect(await client.getBlockers("20")).toEqual([{ key: "3", done: false, status: "opened" }]);
  });

  test("GitLab Free (only relates_to links) reports no blockers", async () => {
    fetchSpy = mockFetch([
      [
        "/links",
        () =>
          jsonResponse([
            { iid: 12, project_id: 7, state: "opened", link_type: "relates_to" },
            { iid: 13, project_id: 7, state: "closed", link_type: "relates_to" },
          ]),
      ],
    ]);
    const client = new GitLabTaskTrackerClient("tok", "acme/webapp");
    expect(await client.getBlockers("20")).toEqual([]);
  });

  test("API failures throw", async () => {
    fetchSpy = mockFetch([["/links", () => jsonResponse({ message: "boom" }, 500)]]);
    const client = new GitLabTaskTrackerClient("tok", "acme/webapp");
    await expect(client.getBlockers("20")).rejects.toThrow(/GitLab API error \(500\)/);
  });
});

describe("Azure DevOps getBlockers", () => {
  let fetchSpy: FetchSpy | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  const base = "https://dev.azure.com/acme";
  const relation = (rel: string, id: number) => ({
    rel,
    url: `${base}/_apis/wit/workItems/${id}`,
  });

  test("returns predecessors with their state category", async () => {
    const urls: string[] = [];
    fetchSpy = mockFetch(
      [
        [
          "/workitems/20?",
          () =>
            jsonResponse({
              id: 20,
              relations: [
                relation("System.LinkTypes.Dependency-Reverse", 12),
                relation("System.LinkTypes.Dependency-Reverse", 11),
                relation("System.LinkTypes.Dependency-Reverse", 13),
                relation("System.LinkTypes.Dependency-Reverse", 99),
                // A successor and a related item are not blockers.
                relation("System.LinkTypes.Dependency-Forward", 30),
                relation("System.LinkTypes.Related", 40),
              ],
            }),
        ],
        [
          "/workitems?ids=",
          () =>
            jsonResponse({
              value: [
                {
                  id: 12,
                  fields: {
                    "System.State": "Active",
                    "System.WorkItemType": "User Story",
                    "System.TeamProject": "Web",
                  },
                },
                {
                  id: 11,
                  fields: {
                    "System.State": "Closed",
                    "System.WorkItemType": "User Story",
                    "System.TeamProject": "Web",
                  },
                },
                {
                  id: 13,
                  fields: {
                    "System.State": "Removed",
                    "System.WorkItemType": "User Story",
                    "System.TeamProject": "Web",
                  },
                },
                // 99 cannot be read by this token (errorPolicy=omit).
                null,
              ],
            }),
        ],
        [
          "/Web/_apis/wit/workitemtypes/User%20Story/states",
          () =>
            jsonResponse({
              value: [
                { name: "New", category: "Proposed" },
                { name: "Active", category: "InProgress" },
                { name: "Resolved", category: "Resolved" },
                { name: "Closed", category: "Completed" },
                { name: "Removed", category: "Removed" },
              ],
            }),
        ],
      ],
      urls,
    );

    const client = new AzureDevOpsTaskTrackerClient("acme", "pat", "Web");
    expect(await client.getBlockers("20")).toEqual([
      { key: "12", done: false, status: "Active" },
      { key: "11", done: true, status: "Closed" },
      { key: "13", done: true, status: "Removed" },
      { key: "99" },
    ]);
    // One relations read, one batch read, and the type's states read once.
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(`${base}/_apis/wit/workitems/20?$expand=relations&api-version=7.0`);
    expect(urls[1]).toContain("ids=12,11,13,99");
  });

  test("a work item without predecessors has no blockers and reads nothing else", async () => {
    const urls: string[] = [];
    fetchSpy = mockFetch(
      [
        [
          "/workitems/20?",
          () =>
            jsonResponse({
              id: 20,
              relations: [relation("System.LinkTypes.Hierarchy-Reverse", 1)],
            }),
        ],
      ],
      urls,
    );
    const client = new AzureDevOpsTaskTrackerClient("acme", "pat", "Web");
    expect(await client.getBlockers("20")).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  test("API failures throw", async () => {
    fetchSpy = mockFetch([["/workitems/20?", () => jsonResponse({ message: "boom" }, 500)]]);
    const client = new AzureDevOpsTaskTrackerClient("acme", "pat", "Web");
    await expect(client.getBlockers("20")).rejects.toThrow(/Azure DevOps API error \(500\)/);
  });
});

describe("Asana getBlockers", () => {
  let fetchSpy: FetchSpy | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  test("returns task dependencies with their completion", async () => {
    const urls: string[] = [];
    fetchSpy = mockFetch(
      [
        [
          "/tasks/1200000000000020/dependencies",
          () =>
            jsonResponse({
              data: [
                { gid: "1200000000000012", completed: false },
                { gid: "1200000000000011", completed: true },
                { gid: "1200000000000013" },
              ],
            }),
        ],
      ],
      urls,
    );
    const client = new AsanaTaskTrackerClient("tok");
    expect(await client.getBlockers("1200000000000020")).toEqual([
      { key: "1200000000000012", done: false, status: "incomplete" },
      { key: "1200000000000011", done: true, status: "completed" },
      { key: "1200000000000013" },
    ]);
    expect(urls[0]).toContain("/tasks/1200000000000020/dependencies?opt_fields=gid,completed");
  });

  test("a plan without dependencies (402) reports no blockers, warning once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      fetchSpy = mockFetch([
        ["/dependencies", () => jsonResponse({ errors: [{ message: "premium" }] }, 402)],
      ]);
      const client = new AsanaTaskTrackerClient("tok");
      expect(await client.getBlockers("1200000000000020")).toEqual([]);
      expect(await client.getBlockers("1200000000000021")).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("other API failures throw", async () => {
    fetchSpy = mockFetch([["/dependencies", () => jsonResponse({ errors: [] }, 500)]]);
    const client = new AsanaTaskTrackerClient("tok");
    await expect(client.getBlockers("1200000000000020")).rejects.toThrow(/Asana API error \(500\)/);
  });
});

describe("Depends on: with a tracker key format", () => {
  test("Trello keys: short links, card URLs, and card ids; plain words are prose", () => {
    expect(
      extractDependsOn(
        "Depends on: aB3dE5fG, https://trello.com/c/Xy7Zq2Wv/12-login-api and 5f1a2b3c4d5e6f7a8b9c0d1e",
        trelloDependencyKey,
      ),
    ).toEqual(["aB3dE5fG", "Xy7Zq2Wv", "5f1a2b3c4d5e6f7a8b9c0d1e"]);
    expect(extractDependsOn("Depends on: database Database", trelloDependencyKey)).toEqual([]);
    expect(extractDependsOn("Depends on: PROJ-12", trelloDependencyKey)).toEqual([]);
  });

  test("markdown keys: slugs with a hyphen or digit, lowercased; prose is ignored", () => {
    expect(
      extractDependsOn("Depends on: add-login, Task-12.md and step2", markdownDependencyKey),
    ).toEqual(["add-login", "task-12", "step2"]);
    expect(extractDependsOn("Depends on: the orders API", markdownDependencyKey)).toEqual([]);
  });

  test("the default format is unchanged", () => {
    expect(extractDependsOn("Depends on: PROJ-12, local-a, aB3dE5fG")).toEqual([
      "PROJ-12",
      "local-a",
    ]);
  });
});

describe("Trello getBlockers", () => {
  let fetchSpy: FetchSpy | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  const card = (desc: string) =>
    jsonResponse({
      id: "5f0000000000000000000020",
      shortLink: "Self0020",
      name: "Card",
      desc,
      url: "https://trello.com/c/Self0020",
    });
  const status = (
    id: string,
    shortLink: string,
    extra: { closed?: boolean; dueComplete?: boolean; list?: string },
  ) =>
    jsonResponse({
      id,
      shortLink,
      closed: extra.closed ?? false,
      dueComplete: extra.dueComplete ?? false,
      list: extra.list ? { name: extra.list } : null,
    });

  test("reads cards named on a Depends on: line with their done state", async () => {
    fetchSpy = mockFetch([
      // Status lookups ask for `fields=id,shortLink,closed,dueComplete`; the
      // card itself is fetched without it.
      [
        /\/cards\/Abc1defg\?.*closed/,
        () => status("5f0000000000000000000001", "Abc1defg", { list: "Doing" }),
      ],
      [
        /\/cards\/Abc2defg\?.*closed/,
        () => status("5f0000000000000000000002", "Abc2defg", { list: "Done" }),
      ],
      [
        /\/cards\/5f0000000000000000000003\?.*closed/,
        () => status("5f0000000000000000000003", "Abc3defg", { closed: true, list: "Doing" }),
      ],
      [
        /\/cards\/Abc4defg\?.*closed/,
        () => status("5f0000000000000000000004", "Abc4defg", { dueComplete: true }),
      ],
      [/\/cards\/Gone9xyz\?.*closed/, () => jsonResponse({ message: "not found" }, 404)],
      [
        /\/cards\/Self0020\?/,
        () =>
          card(
            "Build the page.\n\n**Depends on:** Abc1defg, https://trello.com/c/Abc2defg/7-api, " +
              "5f0000000000000000000003, Abc4defg, Gone9xyz and Self0020",
          ),
      ],
    ]);

    const client = new TrelloTaskTrackerClient("key", "tok");
    expect(await client.getBlockers("Self0020")).toEqual([
      { key: "Abc1defg", done: false, status: "Doing" },
      { key: "Abc2defg", done: true, status: "Done" },
      { key: "Abc3defg", done: true, status: "archived" },
      { key: "Abc4defg", done: true },
      { key: "Gone9xyz", status: "not found" },
    ]);
  });

  test("a card without a Depends on: line has no blockers", async () => {
    fetchSpy = mockFetch([[/\/cards\/Self0020\?/, () => card("Just a card.")]]);
    const client = new TrelloTaskTrackerClient("key", "tok");
    expect(await client.getBlockers("Self0020")).toEqual([]);
  });
});

describe("Markdown getBlockers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "md-blockers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string) => writeFileSync(join(dir, name), content);

  test("resolves Depends on: keys in the tasks directory", async () => {
    write("add-api.md", "---\nstatus: In Progress\n---\n# Add API\n");
    write("add-schema.md", "---\nstatus: Done\n---\n# Add schema\n");
    write("other.md", "---\nkey: login-copy\nstatus: todo\n---\n# Copy\n");
    write(
      "add-login.md",
      "---\nstatus: todo\n---\n# Add login\n\nDepends on: add-api, add-schema, login-copy, missing-task, add-login\n",
    );

    const client = new MarkdownTaskTrackerClient({ tasksDirectory: dir });
    await client.searchTasks("status=todo");
    expect(await client.getBlockers("add-login")).toEqual([
      { key: "add-api", done: false, status: "In Progress" },
      { key: "add-schema", done: true, status: "Done" },
      { key: "login-copy", done: false, status: "todo" },
      { key: "missing-task", status: "not found" },
    ]);
  });

  test("a task without a Depends on: line has no blockers", async () => {
    write("solo-task.md", "# Solo\n\nNo dependencies here.\n");
    const client = new MarkdownTaskTrackerClient({ tasksDirectory: dir });
    expect(await client.getBlockers("solo-task")).toEqual([]);
  });
});
