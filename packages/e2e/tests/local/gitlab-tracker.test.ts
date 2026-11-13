import { expect, spyOn, test } from "bun:test";
import { GitLab } from "../../providers/gitlab";
import { GitLabTracker } from "../../providers/gitlab-tracker";

const gitlab = new GitLab("http://127.0.0.1:8929", "token");
const project = {
  id: 7,
  path_with_namespace: "root/e2e-00000000-0000-0000-0000-000000000000",
  http_url_to_repo: "http://127.0.0.1:8929/root/e2e-00000000-0000-0000-0000-000000000000.git",
};

test("GitLab tracker rejects invalid configuration before any request", () => {
  expect(() => new GitLabTracker(gitlab, project, "  ", gitlab.baseUrl)).toThrow("token");
  expect(() => new GitLabTracker(gitlab, { ...project, id: 0 }, "token", gitlab.baseUrl)).toThrow(
    "project id",
  );
  expect(
    () =>
      new GitLabTracker(
        gitlab,
        { ...project, path_with_namespace: "single" },
        "token",
        gitlab.baseUrl,
      ),
  ).toThrow("project path");
});

test("GitLab tracker exposes explicit environment and project key", () => {
  expect(new GitLabTracker(gitlab, project, "token", gitlab.baseUrl).environment()).toEqual({
    TASK_TRACKER: "gitlab",
    GITLAB_TOKEN: "token",
    GITLAB_PROJECT: "root/e2e-00000000-0000-0000-0000-000000000000",
    GITLAB_BASE_URL: "http://127.0.0.1:8929",
  });
  const withLabels = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl, [
    "To Do",
    "In Review",
  ]);
  expect(withLabels.environment()).toEqual({
    TASK_TRACKER: "gitlab",
    GITLAB_TOKEN: "token",
    GITLAB_PROJECT: "root/e2e-00000000-0000-0000-0000-000000000000",
    GITLAB_BASE_URL: "http://127.0.0.1:8929",
    GITLAB_STATUS_LABELS: "To Do,In Review",
  });
  expect(withLabels.projectKey()).toBe("root/e2e-00000000-0000-0000-0000-000000000000");
});

test("GitLab tracker rejects malformed ids and comment handles before interpolating a URL", async () => {
  const tracker = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl);
  await expect(tracker.getTicket("not-a-number")).rejects.toThrow("Invalid GitLab issue id");
  await expect(tracker.closeTicket("#7")).rejects.toThrow("Invalid GitLab issue id");
  await expect(tracker.deleteComment("7")).rejects.toThrow("Invalid GitLab comment handle");
  await expect(tracker.deleteComment("7:")).rejects.toThrow("Invalid GitLab comment handle");
});

test("GitLab tracker findTickets scopes the open-state search and encodes the query", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json([{ iid: 2, web_url: "http://127.0.0.1:8929/root/e2e/-/issues/2" }]),
  );
  try {
    const tracker = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl);
    const query = "E2EDESCRIPTIONMARKERabc & more";
    expect(await tracker.findTickets(query)).toEqual([
      { key: "2", url: "http://127.0.0.1:8929/root/e2e/-/issues/2" },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v4/projects/7/issues");
    expect(parsed.searchParams.get("state")).toBe("opened");
    expect(parsed.searchParams.get("search")).toBe(query);
    expect(parsed.searchParams.get("per_page")).toBe("100");
    // Encoded on the wire so the ampersand cannot open a second parameter.
    expect(String(url)).toContain(`search=${encodeURIComponent(query)}`);
    expect(init?.method ?? "GET").toBe("GET");
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitLab tracker ensureLabels treats an existing label (409) as idempotent", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ name: "To Do" }, { status: 201 }))
    .mockResolvedValueOnce(new Response("Label already exists", { status: 409 }));
  try {
    const tracker = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl);
    await tracker.ensureLabels(["To Do", "To Do"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8929/api/v4/projects/7/labels");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "To Do", color: "#ededed" });
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitLab tracker ensureLabels surfaces a non-conflict failure", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response("boom", { status: 500 }),
  );
  try {
    const tracker = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl);
    await expect(tracker.ensureLabels(["To Do"])).rejects.toThrow("HTTP 500");
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitLab tracker listComments drops system notes and strings ids", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json([
      { id: 1, body: "opened", system: true },
      { id: 2, body: "Please keep the change minimal." },
      { id: 3, body: "assigned", system: true },
    ]),
  );
  try {
    const tracker = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl);
    expect(await tracker.listComments("2")).toEqual([
      { id: "2", body: "Please keep the change minimal." },
    ]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v4/projects/7/issues/2/notes");
    expect(url.searchParams.get("per_page")).toBe("100");
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitLab tracker cleanup deletes the project by default and can retain a hosted project", async () => {
  const deleteProject = spyOn(gitlab, "deleteProject").mockResolvedValue();
  try {
    await new GitLabTracker(gitlab, project, "token", gitlab.baseUrl).cleanup();
    expect(deleteProject).toHaveBeenCalledTimes(1);

    await new GitLabTracker(gitlab, project, "token", gitlab.baseUrl, [], {
      deleteProject: false,
    }).cleanup();
    expect(deleteProject).toHaveBeenCalledTimes(1);
  } finally {
    deleteProject.mockRestore();
  }
});

test("GitLab tracker getTicket maps provider state, labels and body", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      iid: 2,
      web_url: "http://127.0.0.1:8929/root/e2e/-/issues/2",
      description: "E2EDESCRIPTIONMARKERabc",
      state: "opened",
      labels: ["e2e: In Review"],
    }),
  );
  try {
    const tracker = new GitLabTracker(gitlab, project, "token", gitlab.baseUrl);
    expect(await tracker.getTicket("2")).toEqual({
      state: "opened",
      labels: ["e2e: In Review"],
      body: "E2EDESCRIPTIONMARKERabc",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://127.0.0.1:8929/api/v4/projects/7/issues/2",
    );
  } finally {
    fetchMock.mockRestore();
  }
});
