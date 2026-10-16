import { expect, test } from "bun:test";
import {
  assertImplementationComment,
  assertTicketState,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";
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
