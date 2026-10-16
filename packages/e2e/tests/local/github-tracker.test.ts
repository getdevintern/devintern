import { expect, test } from "bun:test";
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
