import { describe, expect, test } from "bun:test";
import { parseClarityResponse } from "../src/lib/agent/clarity";
import { TaskFormatter } from "../src/lib/task/formatter";
import type { FormattedTaskDetails } from "../src/types/task-tracker";

function createMockTaskDetails(
  overrides: Partial<FormattedTaskDetails> = {},
): FormattedTaskDetails {
  return {
    key: "TEST-123",
    summary: "Add user authentication",
    issueType: "Story",
    status: "To Do",
    priority: "Medium",
    assignee: "dev@example.com",
    reporter: "pm@example.com",
    created: "2024-01-01T00:00:00.000Z",
    updated: "2024-01-01T00:00:00.000Z",
    labels: [],
    components: [],
    fixVersions: [],
    description: null,
    renderedDescription: null,
    linkedResources: [],
    relatedIssues: [],
    comments: [],
    attachments: [],
    ...overrides,
  } as FormattedTaskDetails;
}

describe("TaskFormatter - Clarity Prompt", () => {
  test("requests assumptions and out-of-scope in the JSON shape", () => {
    const prompt = TaskFormatter.formatClarityAssessment(createMockTaskDetails());

    expect(prompt).toContain('"assumptions"');
    expect(prompt).toContain('"outOfScope"');
    expect(prompt).toContain("list the specific assumptions");
    expect(prompt).toContain("work the task does not ask for");
  });
});

describe("parseClarityResponse", () => {
  test("parses assumptions and out-of-scope when provided", () => {
    const output = `{
  "isImplementable": true,
  "clarityScore": 8,
  "issues": [],
  "recommendations": ["Add acceptance criteria"],
  "assumptions": ["Reuses existing auth middleware"],
  "outOfScope": ["Migrating existing sessions"],
  "summary": "Implementable"
}`;

    const assessment = parseClarityResponse(output);
    expect(assessment.assumptions).toEqual(["Reuses existing auth middleware"]);
    expect(assessment.outOfScope).toEqual(["Migrating existing sessions"]);
  });

  test("normalizes missing assumptions and out-of-scope to empty arrays", () => {
    const output = `{
  "isImplementable": true,
  "clarityScore": 8,
  "issues": [],
  "recommendations": [],
  "summary": "Implementable"
}`;

    const assessment = parseClarityResponse(output);
    expect(assessment.assumptions).toEqual([]);
    expect(assessment.outOfScope).toEqual([]);
  });

  test("still rejects assessments missing core fields", () => {
    const output = `{"isImplementable": true, "recommendations": [], "summary": "x"}`;
    expect(() => parseClarityResponse(output)).toThrow("Invalid assessment structure");
  });
});
