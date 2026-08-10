import { describe, expect, test } from "bun:test";
import {
  applyLabelsFromProjectStatus,
  clearLabelCachesForKey,
  pruneSelectedLabels,
  selectionAfterLabelsFailure,
} from "./labels.ts";
import type { LabelListResult, LabelRef } from "../../../shared/ipc-contract.ts";

const available: LabelRef[] = [
  { id: "bug", name: "bug" },
  { id: "backend", name: "backend" },
];

describe("pruneSelectedLabels", () => {
  test("keeps ids present in the available set", () => {
    expect(pruneSelectedLabels(["bug", "backend"], available)).toEqual(["bug", "backend"]);
  });

  test("drops ids missing from the available set", () => {
    expect(pruneSelectedLabels(["bug", "stale", "backend"], available)).toEqual(["bug", "backend"]);
  });

  test("returns the same empty array reference when nothing selected", () => {
    const empty: string[] = [];
    expect(pruneSelectedLabels(empty, available)).toBe(empty);
  });

  test("clears all selections when available is empty (failure prune)", () => {
    expect(pruneSelectedLabels(["bug", "backend"], [])).toEqual([]);
  });

  test("keeps unknown ids when keepUnknown is set", () => {
    expect(pruneSelectedLabels(["bug", "invented"], available, { keepUnknown: true })).toEqual([
      "bug",
      "invented",
    ]);
  });
});

describe("selectionAfterLabelsFailure", () => {
  test("clears non-empty selections", () => {
    expect(selectionAfterLabelsFailure(["bug"])).toEqual([]);
  });

  test("returns the same empty array when already empty", () => {
    const empty: string[] = [];
    expect(selectionAfterLabelsFailure(empty)).toBe(empty);
  });

  test("keeps selections when keepOnFailure is set", () => {
    expect(selectionAfterLabelsFailure(["typed"], { keepOnFailure: true })).toEqual(["typed"]);
  });
});

describe("applyLabelsFromProjectStatus", () => {
  test("seeds success cache and clears prior entries", () => {
    const labelsCache = new Map<string, LabelListResult>([
      ["OLD", { labels: [{ id: "x", name: "x" }], truncated: false }],
    ]);
    const labelsFailedCache = new Map<string, string>([["OLD", "boom"]]);

    const result = applyLabelsFromProjectStatus(
      {
        supportsLabels: true,
        defaultProjectKey: "ENG",
        labels: available,
        labelsTruncated: true,
        labelsError: undefined,
      },
      labelsCache,
      labelsFailedCache,
    );

    expect(result).toEqual({
      labels: available,
      labelsTruncated: true,
      labelsError: null,
    });
    expect(labelsCache.get("ENG")).toEqual({ labels: available, truncated: true });
    expect(labelsCache.has("OLD")).toBe(false);
    expect(labelsFailedCache.size).toBe(0);
  });

  test("seeds failed-cache on labelsError so listLabels is not auto-retried", () => {
    const labelsCache = new Map<string, LabelListResult>();
    const labelsFailedCache = new Map<string, string>();

    const result = applyLabelsFromProjectStatus(
      {
        supportsLabels: true,
        defaultProjectKey: "ENG",
        labels: [],
        labelsError: "rate limited",
      },
      labelsCache,
      labelsFailedCache,
    );

    expect(result).toEqual({ labels: [], labelsTruncated: false, labelsError: "rate limited" });
    expect(labelsCache.size).toBe(0);
    expect(labelsFailedCache.get("ENG")).toBe("rate limited");
  });

  test("skips cache seeding when labels are unsupported", () => {
    const labelsCache = new Map<string, LabelListResult>();
    const labelsFailedCache = new Map<string, string>();

    applyLabelsFromProjectStatus(
      {
        supportsLabels: false,
        defaultProjectKey: "ENG",
        labels: available,
      },
      labelsCache,
      labelsFailedCache,
    );

    expect(labelsCache.size).toBe(0);
    expect(labelsFailedCache.size).toBe(0);
  });
});

describe("clearLabelCachesForKey", () => {
  test("removes both success and failure entries for the key", () => {
    const labelsCache = new Map<string, LabelListResult>([
      ["ENG", { labels: available, truncated: false }],
      ["DES", { labels: [{ id: "a", name: "a" }], truncated: false }],
    ]);
    const labelsFailedCache = new Map<string, string>([["ENG", "boom"]]);

    clearLabelCachesForKey(labelsCache, labelsFailedCache, "ENG");

    expect(labelsCache.has("ENG")).toBe(false);
    expect(labelsCache.has("DES")).toBe(true);
    expect(labelsFailedCache.has("ENG")).toBe(false);
  });
});
