import { expect, test } from "bun:test";

import type { RunOrigin } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";

test.each([
  ["task", "Tracker task"],
  ["pr_mention", "PR mention"],
  ["conflict_resolution", "Conflict resolution"],
  ["scheduled", "Scheduled automation"],
] satisfies [RunOrigin, string][])("labels the %s run origin", (origin, label) => {
  expect(formatRunOrigin(origin)).toBe(label);
});
