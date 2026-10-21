import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunRecord } from "@/lib/api";
import { activityDescription, activityLane, activityLanes } from "@/lib/task-activity";
import { StepBoard } from "@/views/TaskActivityView";

const run: RunRecord = {
  id: 1,
  origin: "task",
  taskKey: "TASK-1",
  status: "in_progress",
  startedAt: 100,
  step: "implement",
  stepStartedAt: 1000,
  stepActive: true,
};

test("activity distinguishes actual executing steps, gaps, and terminal runs", () => {
  expect(activityDescription(run, 61000)).toBe("Running Implementation · 1m 0s");
  expect(activityDescription({ ...run, status: "failed" })).toBe(
    "Last recorded step: Implementation",
  );
  expect(activityDescription({ ...run, stepActive: false })).toBe(
    "Between steps · last: Implementation",
  );
  expect(activityDescription({ ...run, step: undefined })).toBe("Step unavailable for this run");
});

test("custom pipelines and untracked origins keep accurate separate lanes", () => {
  const custom = { ...run, step: "security-audit" };
  const legacy = { ...run, step: undefined, origin: "scheduled" as const };
  expect(activityLane(custom)).toBe("security-audit");
  expect(activityLane(legacy)).toBe("unknown");
  expect(activityLanes([custom, legacy])).toContain("security-audit");
  const html = renderToStaticMarkup(
    createElement(StepBoard, {
      runs: [custom, { ...legacy, id: 2 }],
      selectedId: 1,
      onSelect: () => {},
    }),
  );
  expect(html).toContain("security-audit");
  expect(html).toContain("Step unavailable");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("Inspect TASK-1, run 1");
});
