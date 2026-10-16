import { expect, test } from "bun:test";
import {
  buildTrackerSettings,
  TrackerScenario,
  TRACKER_STATUS_SETTINGS,
  TRACKER_UNRELATED_LABEL,
} from "../../helpers/tracker-scenario";
import type { TrackerFixture } from "../../providers/tracker";
import { GitHub } from "../../providers/github";

const stubTracker: TrackerFixture = {
  type: "github",
  environment: () => ({ TASK_TRACKER: "github", GITHUB_REPO: "org/fixture" }),
  projectKey: () => "org/fixture",
  ensureLabels: async () => {},
  createTicket: async () => ({ key: "1" }),
  addComment: async () => "1",
  closeTicket: async () => {},
  deleteComment: async () => {},
  getTicket: async () => ({ state: "open", labels: [], body: "" }),
  listComments: async () => [],
  findTickets: async () => [],
};

test("buildTrackerSettings scopes statuses to the tracker and project key", () => {
  expect(buildTrackerSettings("github", "org/fixture", { prStatus: "In Review" })).toEqual({
    github: { projects: { "org/fixture": { prStatus: "In Review" } } },
  });
  expect(buildTrackerSettings("gitlab", "root/repo", { todoStatus: "To Do" })).toEqual({
    gitlab: { projects: { "root/repo": { todoStatus: "To Do" } } },
  });
});

test("tracker scenario derives default statuses, labels and unique selectors", () => {
  const scenario = new TrackerScenario(new GitHub("org/fixture", "token"), stubTracker);
  try {
    expect(scenario.statuses).toEqual(TRACKER_STATUS_SETTINGS);
    expect(scenario.seedLabels).toEqual([TRACKER_UNRELATED_LABEL]);
    expect(scenario.descriptionMarker).toStartWith("E2EDESCRIPTIONMARKER");
    expect(scenario.decoyMarker).toStartWith("E2EDECOY");
    expect(scenario.descriptionMarker).not.toBe(scenario.decoyMarker);
    expect(scenario.descriptionMarker).toMatch(/^[A-Za-z0-9]+$/);
    expect(() => scenario.requireTicketKey()).toThrow("not been provisioned");
  } finally {
    scenario.dispose();
  }
});

test("tracker scenario honors explicit status and seed-label overrides", () => {
  const scenario = new TrackerScenario(new GitHub("org/fixture", "token"), stubTracker, {
    statuses: { todoStatus: "Backlog", inProgressStatus: "Doing", prStatus: "Review" },
    seedLabels: ["keep-me"],
  });
  try {
    expect(scenario.statuses).toEqual({
      todoStatus: "Backlog",
      inProgressStatus: "Doing",
      prStatus: "Review",
    });
    expect(scenario.seedLabels).toEqual(["keep-me"]);
  } finally {
    scenario.dispose();
  }
});
