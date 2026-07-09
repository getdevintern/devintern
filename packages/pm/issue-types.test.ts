import { describe, expect, test } from "bun:test";
import { getDefaultIssueType } from "./lib/issue-types";

describe("getDefaultIssueType", () => {
  test("prefers Task when present", () => {
    expect(getDefaultIssueType(["Story", "Task", "Bug", "Epic"])).toBe("Task");
    expect(getDefaultIssueType(["Task", "Story", "Bug", "Epic"])).toBe("Task");
    expect(getDefaultIssueType(["Bug", "Task"])).toBe("Task");
  });

  test("falls back to Story when Task is absent", () => {
    expect(getDefaultIssueType(["Story", "Bug", "Epic"])).toBe("Story");
    expect(getDefaultIssueType(["Bug", "Story"])).toBe("Story");
  });

  test("falls back to first non-Epic type when Task and Story are absent", () => {
    expect(getDefaultIssueType(["Epic", "Bug"])).toBe("Bug");
    expect(getDefaultIssueType(["Epic", "Feature", "Bug"])).toBe("Feature");
  });

  test("falls back to first type when only Epic is available", () => {
    expect(getDefaultIssueType(["Epic"])).toBe("Epic");
  });

  test("falls back to Task for empty array", () => {
    expect(getDefaultIssueType([])).toBe("Task");
  });

  test("is case-insensitive", () => {
    expect(getDefaultIssueType(["STORY", "TASK", "BUG"])).toBe("TASK");
    expect(getDefaultIssueType(["story", "task", "bug"])).toBe("task");
    expect(getDefaultIssueType(["Epic", "Story"])).toBe("Story");
  });
});
