import { describe, expect, test } from "bun:test";
import { pruneSelectedLabels, selectionAfterLabelsFailure } from "./labels.ts";
import type { LabelRef } from "../../../shared/ipc-contract.ts";

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
