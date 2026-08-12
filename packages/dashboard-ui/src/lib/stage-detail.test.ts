import { test, expect } from "bun:test";

import { parseStageDetail } from "@/lib/stage-detail";

test("empty detail returns an empty parsed result", () => {
  expect(parseStageDetail("feasibility", "")).toEqual({});
  expect(parseStageDetail("feasibility", "   \n  ")).toEqual({});
});

test("non-JSON detail falls back to a safe pre block and keeps raw", () => {
  const detail = "just some plain text\nwith two lines";
  const result = parseStageDetail("implementation", detail);
  expect(result.fallback).toBe(detail);
  expect(result.raw).toBe(detail);
  expect(result.markdown).toBeUndefined();
  expect(result.fields).toBeUndefined();
});

test("malformed JSON falls back gracefully", () => {
  const detail = "{not valid json";
  const result = parseStageDetail("feasibility", detail);
  expect(result.fallback).toBe(detail);
  expect(result.raw).toBe(detail);
});

test("feasibility stage renders summary as markdown and structured fields", () => {
  const detail = JSON.stringify({
    isImplementable: true,
    clarityScore: 7,
    summary: "Task is clear enough to begin.",
    issues: [
      {
        category: "missing_requirements",
        description: "No acceptance criteria",
        severity: "major",
      },
    ],
    recommendations: ["Add acceptance criteria", "Clarify scope"],
  });
  const result = parseStageDetail("feasibility", detail);
  expect(result.markdown).toBe("Task is clear enough to begin.");
  expect(result.fallback).toBeUndefined();
  expect(result.raw).toContain('"isImplementable": true');
  expect(result.fields).toHaveLength(4);
  const fields = result.fields!;
  expect(fields[0]).toEqual({
    label: "Implementable",
    value: { kind: "bool", value: true, yes: "yes", no: "no" },
  });
  expect(fields[1]).toEqual({
    label: "Clarity score",
    value: { kind: "score", value: 7, max: 10 },
  });
  const issues = fields[2]!;
  expect(issues.value.kind).toBe("issues");
  expect((issues.value as { items: { severity: string }[] }).items[0]!.severity).toBe("major");
  const recs = fields[3]!;
  expect(recs.value.kind).toBe("list");
  expect((recs.value as { items: unknown[] }).items).toHaveLength(2);
});

test("implementation stage splits report markdown from structured fields", () => {
  const detail = JSON.stringify({
    harness: "Claude Code",
    durationMs: 724000,
    report: "# Summary\n\nImplemented the feature.\n\n- step one\n- step two",
  });
  const result = parseStageDetail("implementation", detail);
  expect(result.markdown).toBe("# Summary\n\nImplemented the feature.\n\n- step one\n- step two");
  expect(result.fields).toEqual([
    { label: "Harness", value: { kind: "text", text: "Claude Code" } },
    { label: "Duration", value: { kind: "duration", ms: 724000 } },
  ]);
});

test("auto_review stage surfaces ReviewFeedback summary and items", () => {
  // Matches `@getdevintern/code` `ReviewFeedback` / `AutoReviewLoopResult`.
  const detail = JSON.stringify({
    iterations: 3,
    success: true,
    finalFeedback: {
      summary: "## Review\n\nAll critical issues addressed.",
      approved: true,
      items: [
        {
          priority: "medium",
          category: "testing",
          file: "packages/dashboard-ui/src/lib/stage-detail.ts",
          line: "42",
          issue: "Missing unit coverage for empty known shapes",
          suggestion: "Add a fixture that asserts generic fallback",
        },
      ],
    },
  });
  const result = parseStageDetail("auto_review", detail);
  expect(result.markdown).toBe("## Review\n\nAll critical issues addressed.");
  expect(result.fields).toEqual([
    { label: "Iterations", value: { kind: "count", n: 3, noun: "iteration" } },
    { label: "Outcome", value: { kind: "bool", value: true, yes: "approved", no: "incomplete" } },
    {
      label: "Feedback",
      value: {
        kind: "reviewItems",
        items: [
          {
            priority: "medium",
            category: "testing",
            file: "packages/dashboard-ui/src/lib/stage-detail.ts",
            line: "42",
            issue: "Missing unit coverage for empty known shapes",
            suggestion: "Add a fixture that asserts generic fallback",
          },
        ],
      },
    },
  ]);
});

test("known stage with only wrong-typed values falls back to generic fields", () => {
  const detail = JSON.stringify({
    harness: 123,
    durationMs: "long",
    report: false,
  });
  const result = parseStageDetail("implementation", detail);
  expect(result.markdown).toBeUndefined();
  expect(result.fields).toEqual([
    { label: "Harness", value: { kind: "text", text: "123" } },
    { label: "Duration Ms", value: { kind: "text", text: "long" } },
    { label: "Report", value: { kind: "bool", value: false } },
  ]);
});

test("auto_review stage surfaces finalFeedback object summary and items", () => {
  const detail = JSON.stringify({
    iterations: 2,
    success: false,
    finalFeedback: {
      summary: "Two issues remain.",
      approved: false,
      items: [
        {
          priority: "critical",
          category: "bug",
          file: "src/index.ts",
          line: "42-45",
          issue: "Off-by-one in the loop bound.",
          suggestion: "Use `<` instead of `<=`.",
        },
        {
          priority: "info",
          category: "documentation",
          issue: "Missing docstring.",
        },
      ],
    },
  });
  const result = parseStageDetail("auto_review", detail);
  expect(result.markdown).toBe("Two issues remain.");
  expect(result.fields).toEqual([
    { label: "Iterations", value: { kind: "count", n: 2, noun: "iteration" } },
    { label: "Outcome", value: { kind: "bool", value: false, yes: "approved", no: "incomplete" } },
    {
      label: "Feedback",
      value: {
        kind: "reviewItems",
        items: [
          {
            priority: "critical",
            category: "bug",
            file: "src/index.ts",
            line: "42-45",
            issue: "Off-by-one in the loop bound.",
            suggestion: "Use `<` instead of `<=`.",
          },
          {
            priority: "info",
            category: "documentation",
            file: undefined,
            line: undefined,
            issue: "Missing docstring.",
            suggestion: undefined,
          },
        ],
      },
    },
  ]);
});

test("change_request stage renders only structured fields", () => {
  const detail = JSON.stringify({
    reviewer: "octocat",
    reviewComments: 5,
    conversationComments: 2,
  });
  const result = parseStageDetail("change_request", detail);
  expect(result.markdown).toBeUndefined();
  expect(result.fields).toEqual([
    { label: "Reviewer", value: { kind: "text", text: "octocat" } },
    { label: "Review comments", value: { kind: "count", n: 5, noun: "comment" } },
    { label: "Conversation comments", value: { kind: "count", n: 2, noun: "comment" } },
  ]);
});

test("outcome stage with no known shape falls back to generic fields", () => {
  const detail = JSON.stringify({ reason: "escalated", note: "needs human" });
  const result = parseStageDetail("outcome", detail);
  expect(result.markdown).toBeUndefined();
  expect(result.fallback).toBeUndefined();
  expect(result.fields).toEqual([
    { label: "Reason", value: { kind: "text", text: "escalated" } },
    { label: "Note", value: { kind: "text", text: "needs human" } },
  ]);
});

test("unknown JSON shape on a known stage falls back to generic fields", () => {
  const detail = JSON.stringify({ fooBar: "baz", count: 3, nested: { a: 1 } });
  const result = parseStageDetail("feasibility", detail);
  expect(result.fallback).toBeUndefined();
  expect(result.fields).toBeDefined();
  const labels = result.fields!.map((f) => f.label);
  expect(labels).toEqual(["Foo Bar", "Count", "Nested"]);
  const nested = result.fields!.find((f) => f.label === "Nested")!;
  expect(nested.value.kind).toBe("fields");
});

test("a bare markdown-ish string is rendered as markdown", () => {
  const detail = JSON.stringify("# Heading\n\nSome **bold** text.");
  const result = parseStageDetail("outcome", detail);
  expect(result.markdown).toBe("# Heading\n\nSome **bold** text.");
  expect(result.fallback).toBeUndefined();
});

test("a bare plain string is rendered as fallback pre", () => {
  const detail = JSON.stringify("just a plain summary with no markdown.");
  const result = parseStageDetail("outcome", detail);
  expect(result.fallback).toBe("just a plain summary with no markdown.");
  expect(result.markdown).toBeUndefined();
});

test("null and primitive JSON values are handled safely", () => {
  expect(parseStageDetail("outcome", "null")).toEqual({ fallback: "null", raw: "null" });
  expect(parseStageDetail("outcome", "42")).toEqual({ fallback: "42", raw: "42" });
  expect(parseStageDetail("outcome", "true")).toEqual({ fallback: "true", raw: "true" });
});
