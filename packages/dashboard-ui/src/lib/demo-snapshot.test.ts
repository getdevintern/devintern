import { expect, test } from "bun:test";

import type { RunRecord } from "@/lib/api";
import {
  filterRecordedRuns,
  isRunDetailUrl,
  isRunListUrl,
  parseSnapshotMeta,
  pruneUnrecordedLineage,
  rebaseTimestamps,
  snapshotFile,
} from "@/lib/demo-snapshot";

test("maps API URLs to stable, static-host-safe snapshot files", () => {
  expect(snapshotFile("/api/overview")).toBe("data/api/overview.json");
  expect(snapshotFile("/api/runs/30")).toBe("data/api/runs/30.json");
  expect(snapshotFile("/api/agent-prs?state=merged")).toBe("data/api/agent-prs.state-merged.json");
  // Params are sorted, and the viewer's time zone never selects a recording.
  expect(snapshotFile("/api/stats?window=7d&tz=Europe%2FBerlin")).toBe(
    "data/api/stats.window-7d.json",
  );
  expect(snapshotFile("/api/x?b=2&a=1")).toBe(snapshotFile("/api/x?a=1&b=2"));
  expect(snapshotFile("/api/runs/3/harness-logs/" + encodeURIComponent("2026 a:b.log"))).toBe(
    "data/api/runs/3/harness-logs/2026_a_b.log.json",
  );
  expect(snapshotFile("/api/runs/3/artifacts/abc/file?download=1")).toBe(
    "data/api/runs/3/artifacts/abc/file.bin",
  );
});

test("refuses URLs outside /api, including ones that climb out of it", () => {
  expect(snapshotFile("/assets/index.js")).toBeNull();
  expect(snapshotFile("/api/%2E%2E/%2E%2E/etc/passwd")).toBeNull();
  expect(snapshotFile("/api/runs/.../x")).toBe("data/api/runs/___/x.json");
});

test("detects the run list URL", () => {
  expect(isRunListUrl("/api/runs?limit=5")).toBe(true);
  expect(isRunListUrl("/api/runs/5")).toBe(false);
});

function run(id: number, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    origin: "task",
    status: "succeeded",
    startedAt: id,
    taskKey: `T-${id}`,
    ...overrides,
  };
}

test("answers run list queries with the server's filters and paging", () => {
  const all = [
    run(5, { status: "failed" }),
    run(4, { origin: "scheduled", automationId: "triage" }),
    run(3),
    run(2, { origin: "scheduled", automationId: "triage" }),
    run(1, { taskKey: "T-3" }),
  ];
  expect(filterRecordedRuns(all, "/api/runs").runs.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
  expect(filterRecordedRuns(all, "/api/runs?status=failed")).toEqual({ runs: [all[0]!], total: 1 });
  expect(
    filterRecordedRuns(all, "/api/runs?automationId=triage&origin=scheduled").runs.map((r) => r.id),
  ).toEqual([4, 2]);
  expect(filterRecordedRuns(all, "/api/runs?taskKey=T-3").runs.map((r) => r.id)).toEqual([3, 1]);
  const page = filterRecordedRuns(all, "/api/runs?limit=2&offset=2");
  expect(page.runs.map((r) => r.id)).toEqual([3, 2]);
  expect(page.total).toBe(5);
});

test("moves epoch-ms and ISO timestamps exactly and date keys by whole weeks", () => {
  const day = 86_400_000;
  const recordedAt = Date.parse("2026-11-20T10:00:00.000Z");
  const shift = 9 * day + 3_600_000; // rounds to one week for date-only keys
  const body = {
    generatedAt: recordedAt,
    durationMs: 1_440_000,
    pid: 4242,
    worker: { startedAt: "2026-11-20T09:00:00.000Z" },
    runsPerWeek: [{ weekStart: "2026-11-16", count: 3 }],
    label: "not a date",
  };
  expect(rebaseTimestamps(body, shift)).toEqual({
    generatedAt: recordedAt + shift,
    durationMs: 1_440_000,
    pid: 4242,
    worker: { startedAt: "2026-11-29T10:00:00.000Z" },
    runsPerWeek: [{ weekStart: "2026-11-23", count: 3 }],
    label: "not a date",
  });
});

test("leaves date-only keys alone while the shift is under half a week", () => {
  expect(rebaseTimestamps({ day: "2026-11-16" }, 2 * 86_400_000)).toEqual({ day: "2026-11-16" });
});

test("parses snapshot metadata", () => {
  expect(parseSnapshotMeta({ exportedAt: 5 })).toEqual({ exportedAt: 5 });
  expect(parseSnapshotMeta({ exportedAt: "5" })).toBeNull();
  expect(parseSnapshotMeta(null)).toBeNull();
});

test("recognizes run detail URLs", () => {
  expect(isRunDetailUrl("/api/runs/30")).toBe(true);
  expect(isRunDetailUrl("/api/runs/30/artifacts")).toBe(false);
  expect(isRunDetailUrl("/api/runs")).toBe(false);
});

test("keeps recorded lineage inside the recording", () => {
  const detail = {
    run: { id: 2 },
    lineage: {
      parent: { runId: 99, origin: "scheduled", status: "succeeded", relation: "delegated" },
      spawned: [
        { kind: "delegated_task", id: 1, taskKey: "local-a", latestRunId: 3 },
        { kind: "delegated_task", id: 2, taskKey: "local-b", latestRunId: 98 },
        { kind: "tracker_issue", key: "DEV-1" },
        { kind: "follow_up_run", runId: 97, origin: "ci_fix", status: "failed", startedAt: 1 },
        { kind: "follow_up_run", runId: 3, origin: "ci_fix", status: "failed", startedAt: 1 },
      ],
    },
  };
  const pruned = pruneUnrecordedLineage(detail, new Set([2, 3])) as typeof detail;
  expect(pruned.lineage.parent).toBeNull();
  expect(JSON.parse(JSON.stringify(pruned.lineage.spawned))).toEqual([
    { kind: "delegated_task", id: 1, taskKey: "local-a", latestRunId: 3 },
    { kind: "delegated_task", id: 2, taskKey: "local-b" },
    { kind: "tracker_issue", key: "DEV-1" },
    { kind: "follow_up_run", runId: 3, origin: "ci_fix", status: "failed", startedAt: 1 },
  ]);
  // A detail without lineage (older recording) passes through unchanged.
  expect(pruneUnrecordedLineage({ run: { id: 1 } }, new Set())).toEqual({ run: { id: 1 } });
});
