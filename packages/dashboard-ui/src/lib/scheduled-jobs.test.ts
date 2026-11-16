import { expect, test } from "bun:test";

import { runMatchesFilter, scheduledJobRunsUrl } from "@/lib/api";
import type { RunRecord } from "@/lib/api";
import { CONFLICT_RESOLUTION_JOB_ID, runFilterForJobId } from "@/lib/scheduled-jobs";

test("run filters mirror the worker's job ids", () => {
  expect(runFilterForJobId("nightly")).toEqual({ automationId: "nightly" });
  expect(runFilterForJobId("estimation:groom")).toEqual({
    automationId: "groom",
    origin: "estimate",
  });
  expect(runFilterForJobId(CONFLICT_RESOLUTION_JOB_ID)).toEqual({ origin: "conflict_resolution" });
});

test("run filter builds the runs URL and matches runs client-side", () => {
  expect(scheduledJobRunsUrl({ automationId: "groom", origin: "estimate" }, 5)).toBe(
    "/api/runs?limit=5&automationId=groom&origin=estimate",
  );
  const run: RunRecord = {
    id: 1,
    origin: "scheduled",
    status: "succeeded",
    startedAt: 0,
    automationId: "groom",
  };
  expect(runMatchesFilter(run, { automationId: "groom" })).toBe(true);
  expect(runMatchesFilter(run, { automationId: "groom", origin: "estimate" })).toBe(false);
});
