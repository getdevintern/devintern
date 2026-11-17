import { expect, test } from "bun:test";

import type { RunRecord } from "@/lib/api";
import { groupRunAttempts } from "@/lib/run-groups";

function run(id: number, overrides: Partial<RunRecord> = {}): RunRecord {
  return { id, origin: "local", status: "deferred", startedAt: id, taskKey: "t", ...overrides };
}

test("collapses attempts at the same task, even when interleaved, at the newest position", () => {
  const groups = groupRunAttempts([
    run(5, { taskKey: "a" }),
    run(4, { taskKey: "b" }),
    run(3, { taskKey: "a" }),
    run(2, { taskKey: "a" }),
  ]);

  expect(groups.map((g) => g.latest.id)).toEqual([5, 4]);
  expect(groups[0]?.earlier.map((r) => r.id)).toEqual([3, 2]);
  expect(groups[1]?.earlier).toEqual([]);
});

test("separate scheduled occurrences stay separate; a retried occurrence groups", () => {
  const groups = groupRunAttempts([
    run(3, { origin: "scheduled", automationId: "tidy", taskKey: "occ-2" }),
    run(2, { origin: "scheduled", automationId: "tidy", taskKey: "occ-1" }),
    run(1, { origin: "scheduled", automationId: "tidy", taskKey: "occ-1" }),
  ]);

  expect(groups.map((g) => [g.latest.id, g.earlier.length])).toEqual([
    [3, 0],
    [2, 1],
  ]);
});

test("same key in a different repo or origin is different work", () => {
  const groups = groupRunAttempts([
    run(3, { repo: "x" }),
    run(2, { repo: "y" }),
    run(1, { repo: "x", origin: "estimate" }),
  ]);

  expect(groups).toHaveLength(3);
});

test("PR runs group by PR; runs without task or PR stand alone", () => {
  const groups = groupRunAttempts([
    run(4, { origin: "conflict_resolution", taskKey: undefined, repo: "r", prNumber: 9 }),
    run(3, { origin: "conflict_resolution", taskKey: undefined, repo: "r", prNumber: 9 }),
    run(2, { taskKey: undefined }),
    run(1, { taskKey: undefined }),
  ]);

  expect(groups.map((g) => [g.latest.id, g.earlier.length])).toEqual([
    [4, 1],
    [2, 0],
    [1, 0],
  ]);
});

test("a repo recorded as owner/name and as bare name is the same repo", () => {
  const groups = groupRunAttempts([run(2, { repo: "acme/widgets" }), run(1, { repo: "widgets" })]);

  expect(groups).toHaveLength(1);
});
