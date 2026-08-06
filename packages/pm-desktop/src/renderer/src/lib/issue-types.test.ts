import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ISSUE_TYPES,
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
