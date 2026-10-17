import { expect, spyOn, test } from "bun:test";
import { GitHub } from "../../providers/github";
import { GitHubTracker } from "../../providers/github-tracker";

test("GitHub tracker rejects invalid configuration before any request", () => {
  expect(() => new GitHubTracker("not-a-repo", "token")).toThrow(
    "Invalid GitHub tracker repository",
  );
  expect(() => new GitHubTracker("org/repo", "  ")).toThrow("token");
});

test("GitHub tracker exposes explicit environment and project key", () => {
  expect(new GitHubTracker("org/fixture", "token").environment()).toEqual({
    TASK_TRACKER: "github",
    GITHUB_REPO: "org/fixture",
  });
  const withLabels = new GitHubTracker("org/fixture", "token", ["In Progress", "In Review"]);
  expect(withLabels.environment()).toEqual({
    TASK_TRACKER: "github",
    GITHUB_REPO: "org/fixture",
    GITHUB_STATUS_LABELS: "In Progress,In Review",
  });
  expect(withLabels.projectKey()).toBe("org/fixture");
});

test("GitHub tracker rejects non-numeric ids before interpolating a URL", async () => {
  const tracker = new GitHubTracker("org/fixture", "token");
  await expect(tracker.addComment("not-a-number", "body")).rejects.toThrow(
    "Invalid GitHub ticket id",
  );
  await expect(tracker.closeTicket("#42")).rejects.toThrow("Invalid GitHub ticket id");
  await expect(tracker.deleteComment("../1")).rejects.toThrow("Invalid GitHub comment id");
});

test("GitHub searchIssues scopes to the fixture repository unless a repo qualifier is present", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ items: [] }));
  try {
    await new GitHub("org/fixture", "token").searchIssues("E2EDESCRIPTIONMARKERabc");
    const scoped = new URL(String(fetchMock.mock.calls[0][0]));
    expect(scoped.pathname).toBe("/search/issues");
    expect(scoped.searchParams.get("q")).toBe("repo:org/fixture is:issue E2EDESCRIPTIONMARKERabc");
    expect(scoped.searchParams.get("per_page")).toBe("100");
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub searchIssues leaves an explicit repo qualifier untouched", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ items: [] }));
  try {
    await new GitHub("org/fixture", "token").searchIssues("repo:other/repo label:bug");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("q")).toBe(
      "repo:other/repo label:bug",
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub tracker ensureLabels treats an existing label (422 already_exists) as idempotent", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ name: "To Do" }, { status: 201 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          message: "Validation Failed",
          errors: [{ resource: "Label", code: "already_exists", field: "name" }],
        },
        { status: 422 },
      ),
    );
  try {
    const tracker = new GitHubTracker("org/fixture", "token");
    await tracker.ensureLabels(["To Do", "To Do"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/org/fixture/labels");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "To Do", color: "ededed" });
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub tracker ensureLabels surfaces a 422 that is not a duplicate label", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json(
      { message: "Validation Failed", errors: [{ code: "invalid", field: "color" }] },
      { status: 422 },
    ),
  );
  try {
    await expect(new GitHubTracker("org/fixture", "token").ensureLabels(["To Do"])).rejects.toThrow(
      "HTTP 422",
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub tracker ensureLabels surfaces a non-validation failure", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response("nope", { status: 500 }),
  );
  try {
    await expect(new GitHubTracker("org/fixture", "token").ensureLabels(["To Do"])).rejects.toThrow(
      "HTTP 500",
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub tracker findTickets drops pull-request search hits and maps issue numbers", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      items: [
        { number: 2, html_url: "https://github.com/org/fixture/issues/2" },
        { number: 9, html_url: "https://github.com/org/fixture/pull/9", pull_request: {} },
      ],
    }),
  );
  try {
    const tracker = new GitHubTracker("org/fixture", "token");
    expect(await tracker.findTickets("marker")).toEqual([
      { key: "2", url: "https://github.com/org/fixture/issues/2" },
    ]);
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub tracker getTicket and listComments map the REST payloads", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        number: 2,
        html_url: "https://github.com/org/fixture/issues/2",
        body: "E2EDESCRIPTIONMARKERabc",
        state: "open",
        labels: [{ name: "e2e: In Review" }, "e2e: keep"],
      }),
    )
    .mockResolvedValueOnce(
      Response.json([{ id: 11, body: "Please keep the change minimal.", user: { login: "x" } }]),
    );
  try {
    const tracker = new GitHubTracker("org/fixture", "token");
    expect(await tracker.getTicket("2")).toEqual({
      state: "open",
      labels: ["e2e: In Review", "e2e: keep"],
      body: "E2EDESCRIPTIONMARKERabc",
    });
    expect(await tracker.listComments("2")).toEqual([
      { id: "11", body: "Please keep the change minimal." },
    ]);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("per_page")).toBe("100");
  } finally {
    fetchMock.mockRestore();
  }
});
