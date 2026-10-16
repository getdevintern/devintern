import { expect, test } from "bun:test";
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
