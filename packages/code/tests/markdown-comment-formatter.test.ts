import { describe, expect, test } from "bun:test";
import {
  formatAssessmentFailureMarkdown,
  formatClarityAssessmentMarkdown,
  formatEstimationCommentMarkdown,
  formatImplementationCommentMarkdown,
  formatIncompleteImplementationCommentMarkdown,
  isDevInternCommentText,
} from "../src/lib/trackers/shared/markdown-comment-formatter";

describe("markdown-comment-formatter - clarity assessment", () => {
  test("formats passing assessment as markdown with marker", () => {
    const markdown = formatClarityAssessmentMarkdown({
      clarityScore: 8,
      isImplementable: true,
      summary: "Task is clear and implementable",
      issues: [],
      recommendations: [],
    });

    expect(markdown).toContain("Automated Task Feasibility Assessment");
    expect(markdown).toContain("**Clarity Score:** 8/10");
    expect(markdown).toContain("✅ Ready for implementation");
    expect(markdown).toContain("**Summary:** Task is clear and implementable");
    expect(markdown).not.toContain('"clarityScore"');
  });

  test("includes issues and recommendations", () => {
    const markdown = formatClarityAssessmentMarkdown({
      clarityScore: 4,
      isImplementable: false,
      summary: "Requirements are vague",
      issues: [
        {
          category: "Scope",
          description: "Acceptance criteria missing",
          severity: "critical",
        },
      ],
      recommendations: ["Add acceptance criteria", "Link design mockups"],
    });

    expect(markdown).toContain("❌ Needs fundamental clarification");
    expect(markdown).toContain("**Critical Issues Identified:**");
    expect(markdown).toContain("🔴 **Scope:** Acceptance criteria missing");
    expect(markdown).toContain("1. Add acceptance criteria");
    expect(markdown).toContain("2. Link design mockups");
  });
});

describe("markdown-comment-formatter - comment bodies", () => {
  test("implementation comment includes marker, summary, and output", () => {
    const body = formatImplementationCommentMarkdown("Did the thing.", "Fix login bug");
    expect(body).toContain("Implementation Completed by @devintern/code");
    expect(body).toContain("Task: Fix login bug");
    expect(body).toContain("Did the thing.");
    expect(isDevInternCommentText(body)).toBe(true);
  });

  test("implementation comment truncates long agent output", () => {
    const body = formatImplementationCommentMarkdown("x".repeat(10000));
    expect(body.length).toBeLessThan(9000);
  });

  test("incomplete comment includes marker", () => {
    const body = formatIncompleteImplementationCommentMarkdown("Partial work", "Fix login bug");
    expect(body).toContain("⚠️ Implementation Incomplete");
    expect(body).toContain("Task: Fix login bug");
    expect(isDevInternCommentText(body)).toBe(true);
  });

  test("assessment failure bodies name the reason", () => {
    expect(formatAssessmentFailureMarkdown("max-turns")).toContain("maximum turn limit");
    expect(formatAssessmentFailureMarkdown("parse-error")).toContain("could not be parsed");
  });
});

describe("markdown-comment-formatter - estimation comment", () => {
  test("formats estimation with confidence bar, risks, and unclear areas", () => {
    const markdown = formatEstimationCommentMarkdown({
      storyPoints: 5,
      confidence: "medium",
      implementationConfidence: 7,
      reasoning: "Moderate scope with some unknowns.",
      risks: ["API contract may change"],
      unclearAreas: ["Error handling expectations"],
      summary: "Medium-sized task",
    });

    expect(markdown).toContain("Automated Story Points Estimation");
    expect(markdown).toContain("**Story Points:** 5");
    expect(markdown).toContain("🟡 medium");
    expect(markdown).toContain("7/10");
    expect(markdown).toContain("#### Reasoning");
    expect(markdown).toContain("- API contract may change");
    expect(markdown).toContain("- Error handling expectations");
    expect(markdown).not.toContain("Low confidence estimate");
    expect(isDevInternCommentText(markdown)).toBe(true);
  });

  test("adds low-confidence warning", () => {
    const markdown = formatEstimationCommentMarkdown({
      storyPoints: 8,
      confidence: "low",
      reasoning: "Very unclear.",
      risks: [],
      unclearAreas: [],
      summary: "Unclear task",
    });

    expect(markdown).toContain("🔴 low");
    expect(markdown).toContain("Low confidence estimate");
  });
});
