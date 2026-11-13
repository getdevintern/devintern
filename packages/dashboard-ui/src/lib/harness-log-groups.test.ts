import { expect, test } from "bun:test";

import type { HarnessLogFile } from "@/lib/api";
import { groupHarnessLogs } from "@/lib/harness-log-groups";

/** Minimal harness-log fixture; only the fields grouping reads are meaningful. */
function log(
  name: string,
  startedAt: number | null,
  extra: Partial<HarnessLogFile> = {},
): HarnessLogFile {
  return {
    name,
    size: 1,
    modifiedAt: startedAt ?? 0,
    startedAt,
    origin: "task",
    taskKey: "DEV-1",
    ...extra,
  };
}

test("sorts a single run oldest first without group headers", () => {
  const late = log("late.log", 300, { runId: 10, attempt: 1, label: "implementation" });
  const early = log("early.log", 100, { runId: 10, attempt: 1, label: "clarity" });

  const result = groupHarnessLogs([late, early]);

  expect(result.grouped).toBe(false);
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]?.label).toBe("Attempt 1");
  expect(result.groups[0]?.logs.map((file) => file.name)).toEqual(["early.log", "late.log"]);
});

test("groups retries by attempt, oldest group and log first", () => {
  const attempt2Late = log("a2-late.log", 400, { runId: 11, attempt: 2, label: "implementation" });
  const attempt1Late = log("a1-late.log", 200, { runId: 10, attempt: 1, label: "implementation" });
  const attempt2Early = log("a2-early.log", 300, { runId: 11, attempt: 2, label: "clarity" });
  const attempt1Early = log("a1-early.log", 100, { runId: 10, attempt: 1, label: "clarity" });

  const result = groupHarnessLogs([attempt2Late, attempt1Late, attempt2Early, attempt1Early]);

  expect(result.grouped).toBe(true);
  expect(result.groups.map((group) => group.label)).toEqual(["Attempt 1", "Attempt 2"]);
  expect(result.groups.map((group) => group.runId)).toEqual([10, 11]);
  expect(result.groups[0]?.logs.map((file) => file.name)).toEqual(["a1-early.log", "a1-late.log"]);
  expect(result.groups[1]?.logs.map((file) => file.name)).toEqual(["a2-early.log", "a2-late.log"]);
});

test("puts logs without a run id in their own group and triggers grouping", () => {
  const runLog = log("run.log", 200, { runId: 10, attempt: 1 });
  const orphan = log("orphan.log", 100, { label: "setup" });

  const result = groupHarnessLogs([runLog, orphan]);

  expect(result.grouped).toBe(true);
  expect(result.groups.map((group) => group.label)).toEqual(["Unattributed logs", "Attempt 1"]);
  expect(result.groups[0]?.runId).toBeUndefined();
});

test("labels a run without a known attempt as Run", () => {
  const result = groupHarnessLogs([log("run.log", 100, { runId: 10 })]);

  expect(result.groups[0]?.label).toBe("Run");
  expect(result.groups[0]?.attempt).toBeUndefined();
});

test("falls back to modifiedAt when startedAt is missing", () => {
  const older = log("older.log", null, { runId: 10, attempt: 1 });
  older.modifiedAt = 100;
  const newer = log("newer.log", 200, { runId: 10, attempt: 1 });

  const result = groupHarnessLogs([newer, older]);

  expect(result.groups[0]?.logs.map((file) => file.name)).toEqual(["older.log", "newer.log"]);
});

test("empty input yields no groups", () => {
  expect(groupHarnessLogs([])).toEqual({ grouped: false, groups: [] });
});
