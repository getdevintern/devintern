import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildTrackerSettings,
  TrackerScenario,
  TRACKER_STATUS_SETTINGS,
  TRACKER_UNRELATED_LABEL,
} from "../../helpers/tracker-scenario";
import type { TrackerFixture, TrackerTicket } from "../../providers/tracker";
import { GitHub } from "../../providers/github";

const stubTracker: TrackerFixture = {
  type: "github",
  openState: "open",
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

/** Scenario with a fixed expected ticket and a tracker whose reads are injected. */
function probingScenario(tracker: TrackerFixture, expectedKey: string): TrackerScenario {
  const scenario = new TrackerScenario(new GitHub("org/fixture", "token"), tracker);
  scenario.ticket = { key: expectedKey };
  return scenario;
}

/** Scenario exposing the protected branch-reconciliation hooks for testing. */
class ExposedTrackerScenario extends TrackerScenario {
  pointAt(key: string): void {
    this.useTaskKey(key);
  }

  sync(): void {
    this.syncRecordedBranch();
  }
}

function exposedScenario(): ExposedTrackerScenario {
  return new ExposedTrackerScenario(new GitHub("org/fixture", "token"), stubTracker);
}

test("syncRecordedBranch adopts the CLI's attempt branch and releases the deterministic ref", () => {
  const scenario = exposedScenario();
  try {
    scenario.ticket = { key: "2" };
    scenario.pointAt("2");
    const db = new Database(scenario.env.WEBHOOK_QUEUE_DB);
    db.run("CREATE TABLE runs (id INTEGER PRIMARY KEY, task_key TEXT, branch TEXT)");
    db.run("INSERT INTO runs (task_key, branch) VALUES ('2', 'feature/2-attempt-2')");
    db.close();

    expect(scenario.head).toBe("feature/2");
    scenario.sync();
    expect(scenario.head).toBe("feature/2-attempt-2");
    expect(scenario.ownedBranches.has("feature/2")).toBe(false);
    expect(scenario.ownedBranches.has("feature/2-attempt-2")).toBe(true);
  } finally {
    scenario.dispose();
  }
});

test("syncRecordedBranch releases the derived head when the run recorded no branch", () => {
  const scenario = exposedScenario();
  try {
    scenario.ticket = { key: "2" };
    scenario.pointAt("2");
    scenario.sync();
    expect(scenario.head).toBe("feature/2");
    expect(scenario.ownedBranches.has("feature/2")).toBe(false);
    expect(scenario.ownedBranches.has(scenario.base)).toBe(true);
  } finally {
    scenario.dispose();
  }
});

test("waitForSelectedTickets confirms indexing without hiding an extra search hit", async () => {
  const reads: string[] = [];
  // Read at call time so the scenario's real random marker is used.
  let selector = "";
  const tracker: TrackerFixture = {
    ...stubTracker,
    findTickets: async (): Promise<TrackerTicket[]> => [
      { key: "2", url: "u2" },
      { key: "3", url: "u3" },
    ],
    getTicket: async (key) => {
      reads.push(key);
      return {
        state: "open",
        labels: [],
        body: key === "2" ? selector : "outside the selector",
      };
    },
  };
  const scenario = probingScenario(tracker, "2");
  selector = scenario.descriptionMarker;
  try {
    expect(await scenario.waitForSelectedTickets({ deadlineMs: 0, sleep: async () => {} })).toEqual(
      [
        { key: "2", url: "u2" },
        { key: "3", url: "u3" },
      ],
    );
    // The expected body confirms indexing; raw results expose extra matches.
    expect(reads).toEqual(["2"]);
  } finally {
    scenario.dispose();
  }
});

test("waitForSelectedTickets rejects a fuzzy search hit whose body lacks the selector", async () => {
  let reads = 0;
  const tracker: TrackerFixture = {
    ...stubTracker,
    findTickets: async (): Promise<TrackerTicket[]> => [{ key: "2", url: "u2" }],
    getTicket: async () => {
      reads++;
      return { state: "open", labels: [], body: "tokenized differently, no raw marker" };
    },
  };
  const scenario = probingScenario(tracker, "2");
  try {
    await expect(
      scenario.waitForSelectedTickets({ deadlineMs: 0, sleep: async () => {} }),
    ).rejects.toThrow("never matched selector");
    expect(reads).toBe(1);
  } finally {
    scenario.dispose();
  }
});

test("waitForSelectedTickets backs off its polling with a cap", async () => {
  const delays: number[] = [];
  let now = 0;
  const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
  let polls = 0;
  const tracker: TrackerFixture = {
    ...stubTracker,
    findTickets: async () => {
      polls++;
      return [];
    },
  };
  const scenario = probingScenario(tracker, "2");
  try {
    await expect(
      scenario.waitForSelectedTickets({
        deadlineMs: 100,
        initialDelayMs: 10,
        maxDelayMs: 40,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        },
      }),
    ).rejects.toThrow("never matched selector");
    expect(delays).toEqual([10, 20, 40, 40]);
    expect(polls).toBe(4);
  } finally {
    nowSpy.mockRestore();
    scenario.dispose();
  }
});
