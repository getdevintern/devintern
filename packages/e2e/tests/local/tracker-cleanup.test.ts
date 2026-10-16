import { expect, test } from "bun:test";
import type { TrackerFixture } from "../../providers/tracker";
import { throwCleanupFailures } from "../../helpers/cleanup";
import { collectTrackerCleanupFailures } from "../../helpers/tracker-scenario";

function stubTracker(fail: (operation: string, id: string) => boolean = () => false) {
  const closed: string[] = [];
  const deleted: string[] = [];
  const tracker: TrackerFixture = {
    type: "github",
    openState: "open",
    environment: () => ({ TASK_TRACKER: "github", GITHUB_REPO: "org/fixture" }),
    projectKey: () => "org/fixture",
    ensureLabels: async () => {},
    createTicket: async () => ({ key: "42" }),
    addComment: async () => "7",
    closeTicket: async (key) => {
      if (fail("closeTicket", key)) throw new Error("close failed");
      closed.push(key);
    },
    deleteComment: async (id) => {
      if (fail("deleteComment", id)) throw new Error("delete failed");
      deleted.push(id);
    },
    getTicket: async () => ({ state: "open", labels: [], body: "" }),
    listComments: async () => [],
    findTickets: async () => [],
  };
  return { tracker, closed, deleted };
}

test("tracker cleanup attempts every owned resource and tags failures with ids", async () => {
  const { tracker, closed, deleted } = stubTracker(
    (operation, id) =>
      (operation === "deleteComment" && id === "c2") || operation === "closeTicket",
  );
  const failures = await collectTrackerCleanupFailures(tracker, {
    ticketKeys: ["42", "43"],
    commentIds: ["c1", "c2"],
  });
  // c2's delete failed but both closes were still attempted, and c1 was removed.
  expect(deleted).toEqual(["c1"]);
  expect(closed).toEqual([]);
  expect(failures.map((failure) => failure.resource)).toEqual([
    "comment:c2",
    "ticket:42",
    "ticket:43",
  ]);
});

test("tracker cleanup closes the ticket and deletes comments when all operations succeed", async () => {
  const { tracker, closed, deleted } = stubTracker();
  const failures = await collectTrackerCleanupFailures(tracker, {
    ticketKeys: ["42"],
    commentIds: ["c1"],
  });
  expect(failures).toEqual([]);
  expect(closed).toEqual(["42"]);
  expect(deleted).toEqual(["c1"]);
});

test("tracker cleanup handles partial setup with no ticket or comments", async () => {
  const { tracker, closed, deleted } = stubTracker();
  expect(await collectTrackerCleanupFailures(tracker, { ticketKeys: [], commentIds: [] })).toEqual(
    [],
  );
  expect(closed).toEqual([]);
  expect(deleted).toEqual([]);
});

test("cleanup failure message names the failed resource ids", () => {
  expect(() =>
    throwCleanupFailures("Tracker cleanup failed", [
      { resource: "comment:9", error: new Error("x") },
      { resource: "ticket:42", error: new Error("y") },
    ]),
  ).toThrow(/comment:9, ticket:42/);
  expect(() => throwCleanupFailures("clean", [])).not.toThrow();
});
