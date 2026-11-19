import { expect, test } from "bun:test";

import type { RunStageRecord } from "@/lib/api";
import { visibleStages } from "./Timeline";

function stage(overrides: Partial<RunStageRecord>): RunStageRecord {
  return {
    id: 1,
    runId: 1,
    stage: "outcome",
    status: "succeeded",
    createdAt: 0,
    ...overrides,
  };
}

test("hides a succeeded outcome stage that has nothing to say", () => {
  const implementation = stage({ id: 1, stage: "implementation", summary: "implemented" });
  const outcome = stage({ id: 2 });
  expect(visibleStages([implementation, outcome])).toEqual([implementation]);
});

test("keeps outcome stages that carry a summary or a non-success status", () => {
  const withSummary = stage({ id: 2, summary: "merged" });
  const failed = stage({ id: 3, status: "failed" });
  expect(visibleStages([withSummary, failed])).toEqual([withSummary, failed]);
});

test("keeps an empty outcome when it is the only stage", () => {
  const only = stage({ id: 1 });
  expect(visibleStages([only])).toEqual([only]);
});
