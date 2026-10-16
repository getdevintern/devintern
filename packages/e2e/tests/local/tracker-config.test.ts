import { expect, test } from "bun:test";
import { resolveGitHubTrackerConfig } from "../../helpers/tracker-config";

test("tracker config requires an explicit repository and token", () => {
  expect(() =>
    resolveGitHubTrackerConfig({
      E2E_TRACKER_REPOSITORY: "org/fixture",
      GITHUB_TOKEN: "production-token",
      E2E_GITHUB_TOKEN: "code-host-token",
    }),
  ).toThrow("E2E_TRACKER_TOKEN");
  expect(() => resolveGitHubTrackerConfig({ E2E_TRACKER_TOKEN: "tracker-token" })).toThrow(
    "E2E_TRACKER_REPOSITORY",
  );
});

test("tracker config rejects malformed repositories and trims status labels", () => {
  expect(() =>
    resolveGitHubTrackerConfig({
      E2E_TRACKER_REPOSITORY: "https://github.com/org/repo",
      E2E_TRACKER_TOKEN: "tracker-token",
    }),
  ).toThrow("E2E_TRACKER_REPOSITORY");
  expect(
    resolveGitHubTrackerConfig({
      E2E_TRACKER_REPOSITORY: "org/fixture",
      E2E_TRACKER_TOKEN: " tracker-token ",
      E2E_TRACKER_STATUS_LABELS: " In Progress, In Review ,",
    }),
  ).toEqual({
    repository: "org/fixture",
    token: "tracker-token",
    statusLabels: ["In Progress", "In Review"],
  });
});
