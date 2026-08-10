import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ISSUE_TYPES,
  cacheIssueTypesFromStatus,
  getDefaultIssueType,
  issueTypeIfNeedsReset,
  orderIssueTypes,
  resolveIssueTypes,
} from "./issue-types.ts";

describe("resolveIssueTypes", () => {
  test("returns tracker types when non-empty", () => {
    expect(resolveIssueTypes(["Epic", "Task"])).toEqual(["Epic", "Task"]);
  });

  test("falls back to DEFAULT_ISSUE_TYPES when missing or empty", () => {
    expect(resolveIssueTypes(undefined)).toEqual(DEFAULT_ISSUE_TYPES);
    expect(resolveIssueTypes(null)).toEqual(DEFAULT_ISSUE_TYPES);
    expect(resolveIssueTypes([])).toEqual(DEFAULT_ISSUE_TYPES);
  });
});

describe("cacheIssueTypesFromStatus", () => {
  test("refreshes cache when status.issueTypes change after Update", () => {
    const cache = new Map<string, string[]>();
    cache.set("ACME", ["Epic", "Task"]);

    const types = cacheIssueTypesFromStatus(
      { issueTypes: ["Bug", "Story", "Task"], defaultProjectKey: "ACME" },
      cache,
    );

    expect(types).toEqual(["Bug", "Story", "Task"]);
    expect(cache.get("ACME")).toEqual(["Bug", "Story", "Task"]);
    expect(cache.size).toBe(1);
  });

  test("clears stale keys when project key is absent", () => {
    const cache = new Map<string, string[]>([["OLD", ["Epic"]]]);
    const types = cacheIssueTypesFromStatus({ issueTypes: ["Task"] }, cache);
    expect(types).toEqual(["Task"]);
    expect(cache.size).toBe(0);
  });
});

describe("issueTypeIfNeedsReset", () => {
  test("keeps a still-valid selection", () => {
    expect(issueTypeIfNeedsReset("Bug", ["Epic", "Bug", "Task"])).toBeNull();
  });

  test("defaults with CLI rules when current is missing", () => {
    expect(issueTypeIfNeedsReset("Epic", ["Story", "Bug"])).toBe("Story");
    expect(issueTypeIfNeedsReset("Task", ["Epic", "Feature"])).toBe("Feature");
    expect(issueTypeIfNeedsReset(undefined, ["Epic", "Task"])).toBe("Task");
  });

  test("fallback list defaults to Task", () => {
    expect(getDefaultIssueType(resolveIssueTypes([]))).toBe("Task");
    expect(orderIssueTypes(resolveIssueTypes(["Epic", "Story", "Task"]))[0]).toBe("Task");
  });
});
