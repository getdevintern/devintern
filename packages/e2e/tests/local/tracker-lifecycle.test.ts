import { expect, test } from "bun:test";
import {
  assertImplementationComment,
  assertTicketState,
  assertTrackerLifecycle,
  IMPLEMENTATION_COMMENT_MARKER,
  pullsCreatedByRun,
} from "../../helpers/tracker-lifecycle";
import type { TrackerScenario } from "../../helpers/tracker-scenario";
import type { PullRequest } from "../../providers/github";
import type { TrackerFixture } from "../../providers/tracker";

const statuses = {
  todoStatus: "e2e: To Do",
  inProgressStatus: "e2e: In Progress",
  prStatus: "e2e: In Review",
};

/**
 * A GitLab-shaped stub: it reports the provider-native `opened` state and a
 * comment body without the stripped summary delimiters. The shared assertion
 * must accept both, which is exactly what the live GitLab scenario exercises.
 */
function gitlabLikeTracker(): TrackerFixture {
  return {
    type: "gitlab",
    openState: "opened",
    environment: () => ({ TASK_TRACKER: "gitlab" }),
    projectKey: () => "root/fixture",
    ensureLabels: async () => {},
    createTicket: async () => ({ key: "1" }),
    addComment: async () => "1:1",
    closeTicket: async () => {},
    deleteComment: async () => {},
    getTicket: async () => ({ state: "opened", labels: [], body: "" }),
    listComments: async () => [],
    findTickets: async () => [],
  };
}

test("shared ticket assertion accepts a provider-native GitLab open state", () => {
  const tracker = gitlabLikeTracker();
  expect(() =>
    assertTicketState({
      ticket: {
        state: "opened",
        labels: [statuses.prStatus, "e2e: keep"],
        body: "E2EDESCRIPTIONMARKERabc123",
      },
      openState: tracker.openState,
      descriptionMarker: "E2EDESCRIPTIONMARKERabc123",
      statuses,
      seedLabels: ["e2e: keep"],
    }),
  ).not.toThrow();
});

test("shared ticket assertion fails when the fixture does not supply the native state", () => {
  const tracker = gitlabLikeTracker();
  expect(() =>
    assertTicketState({
      ticket: { state: "open", labels: [statuses.prStatus], body: "marker" },
      openState: tracker.openState,
      descriptionMarker: "marker",
      statuses,
      seedLabels: [],
    }),
  ).toThrow();
});

test("shared comment assertion accepts the summary body that survives extraction", () => {
  const body = [
    IMPLEMENTATION_COMMENT_MARKER,
    "Task: Expand the greeting",
    "",
    "## What changed",
    'Updated src/greeting.ts to export "Hello, world!".',
  ].join("\n");
  expect(() => assertImplementationComment([{ id: "1", body }])).not.toThrow();
});

test("shared comment assertion rejects raw-marker-only or absent summaries", () => {
  expect(() =>
    assertImplementationComment([{ id: "1", body: "<!-- devintern:summary:start -->" }]),
  ).toThrow();
  expect(() =>
    assertImplementationComment([{ id: "1", body: IMPLEMENTATION_COMMENT_MARKER }]),
  ).toThrow();
});

const scenarioBase = "e2e/base-scenario-uuid";

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    state: "open",
    title: "[2] Expand the greeting",
    body: "Task 2: Expand the greeting\n\nHello, world!",
    head: { ref: "feature/2", sha: "deadbeef" },
    base: { ref: scenarioBase },
    ...overrides,
  };
}

/** A deterministic-key PR a foreign run on the shared code host could leave. */
function foreignDecoyPull(baseRef: string): PullRequest {
  return pullRequest({
    number: 7,
    title: "[1] Expand the greeting (decoy)",
    body: "Task 1: Expand the greeting (decoy)",
    head: { ref: "feature/1", sha: "cafebabe" },
    base: { ref: baseRef },
  });
}

/**
 * Minimal scenario double that satisfies every read {@link assertTrackerLifecycle}
 * performs, so the decoy PR check runs without a live code host.
 */
function fakeScenario(decoyPulls: PullRequest[]): TrackerScenario {
  const descriptionMarker = "E2EDESCRIPTIONMARKERabc";
  const decoyMarker = "E2EDECOYabc";
  const commentMarker = "E2ECOMMENTMARKERabc";
  const implementationBody = [
    IMPLEMENTATION_COMMENT_MARKER,
    "Task: Expand the greeting",
    "",
    "## What changed",
    "Updated src/greeting.ts",
  ].join("\n");

  return {
    base: scenarioBase,
    head: "feature/2",
    title: "Expand the greeting",
    statuses,
    seedLabels: ["e2e: keep"],
    descriptionMarker,
    decoyMarker,
    commentMarker,
    tracker: { type: "gitlab", openState: "opened" },
    decoyTicket: { key: "1" },
    requireTicketKey: () => "2",
    getTicket: async (key: string) =>
      key === "2"
        ? { state: "opened", labels: [statuses.prStatus, "e2e: keep"], body: descriptionMarker }
        : { state: "opened", labels: [], body: decoyMarker },
    listComments: async () => [
      { id: "1", body: implementationBody },
      { id: "2", body: commentMarker },
    ],
    runRecords: () => [
      { task_key: "2", tracker: "gitlab", status: "succeeded", pr_url: "u", outcome_reason: null },
    ],
    waitForSelectedTickets: async () => [{ key: "2" }],
    git: async () => "src/greeting.ts",
    github: {
      waitForPull: async () => pullRequest(),
      request: async () => [{ filename: "src/greeting.ts" }],
      pulls: async () => decoyPulls,
    },
  } as unknown as TrackerScenario;
}

test("pullsCreatedByRun keeps only PRs targeting the scenario's base ref", () => {
  const ours = pullRequest();
  const foreign = foreignDecoyPull("e2e/base-someone-else");
  expect(pullsCreatedByRun([ours, foreign], scenarioBase)).toEqual([ours]);
});

test("assertTrackerLifecycle tolerates a foreign decoy PR on the shared code host", async () => {
  await expect(
    assertTrackerLifecycle(fakeScenario([foreignDecoyPull("e2e/base-someone-else")])),
  ).resolves.toBeUndefined();
});

test("assertTrackerLifecycle still fails when this run created a decoy PR", async () => {
  await expect(
    assertTrackerLifecycle(fakeScenario([foreignDecoyPull(scenarioBase)])),
  ).rejects.toThrow();
});
