import { expect, test } from "bun:test";

import type { LogEntry } from "@/lib/api";
import { levelDotClass, matchesQuery, severityCounts } from "@/lib/log-view";

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    index: 0,
    timestamp: null,
    level: "info",
    stream: "out",
    message: "",
    taskKey: null,
    ...partial,
  };
}

test("matchesQuery is a case-insensitive substring match", () => {
  const line = entry({ message: "❌ Run PROJ-1 failed: git push rejected" });
  expect(matchesQuery(line, "PROJ-1")).toBe(true);
  expect(matchesQuery(line, "proj-1")).toBe(true);
  expect(matchesQuery(line, "rejected")).toBe(true);
  expect(matchesQuery(line, "approved")).toBe(false);
});

test("matchesQuery treats blank/whitespace queries as match-all", () => {
  const line = entry({ message: "anything" });
  expect(matchesQuery(line, "")).toBe(true);
  expect(matchesQuery(line, "   ")).toBe(true);
});

test("severityCounts tallies errors and warnings only", () => {
  const counts = severityCounts([
    entry({ level: "error" }),
    entry({ level: "warn" }),
    entry({ level: "info" }),
    entry({ level: "error" }),
  ]);
  expect(counts).toEqual({ error: 2, warn: 1 });
});

test("severityCounts of an empty window is zeroed", () => {
  expect(severityCounts([])).toEqual({ error: 0, warn: 0 });
});

test("levelDotClass distinguishes severities", () => {
  expect(levelDotClass("error")).not.toBe(levelDotClass("warn"));
  expect(levelDotClass("info")).not.toBe(levelDotClass("error"));
});
