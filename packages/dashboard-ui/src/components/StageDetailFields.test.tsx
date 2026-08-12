import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, expect } from "bun:test";

import { StageDetailFields } from "@/components/StageDetailFields";
import type { DetailField } from "@/lib/stage-detail";

function render(fields: DetailField[]): string {
  return renderToStaticMarkup(createElement(StageDetailFields, { fields }));
}

test("bool fields render yes/no badges", () => {
  const html = render([
    {
      label: "Outcome",
      value: { kind: "bool", value: true, yes: "approved", no: "incomplete" },
    },
    {
      label: "Failed",
      value: { kind: "bool", value: false, yes: "ok", no: "bad" },
    },
  ]);
  expect(html).toContain("Outcome");
  expect(html).toContain("✓ approved");
  expect(html).toContain("Failed");
  expect(html).toContain("✕ bad");
});

test("issues render severity badges and descriptions", () => {
  const html = render([
    {
      label: "Issues",
      value: {
        kind: "issues",
        items: [
          {
            category: "missing_requirements",
            description: "No acceptance criteria",
            severity: "major",
          },
          {
            category: "ambiguity",
            description: "Unclear scope",
            severity: "critical",
          },
        ],
      },
    },
  ]);
  expect(html).toContain("Issues");
  expect(html).toContain("major");
  expect(html).toContain("critical");
  expect(html).toContain("missing_requirements");
  expect(html).toContain("No acceptance criteria");
  expect(html).toContain("Unclear scope");
});

test("list and nested fields render recursively", () => {
  const html = render([
    {
      label: "Recommendations",
      value: {
        kind: "list",
        items: [
          { kind: "text", text: "Add tests" },
          {
            kind: "fields",
            fields: [{ label: "File", value: { kind: "text", text: "foo.ts" } }],
          },
        ],
      },
    },
  ]);
  expect(html).toContain("Recommendations");
  expect(html).toContain("Add tests");
  expect(html).toContain("File");
  expect(html).toContain("foo.ts");
  expect(html).toContain("<ul");
});

test("markdown fields are formatted (not plain text only)", () => {
  const html = render([
    {
      label: "Notes",
      value: { kind: "markdown", text: "## Heading\n\nSome **bold** text." },
    },
  ]);
  expect(html).toContain("Notes");
  expect(html).toContain("<h2");
  expect(html).toContain("Heading");
  expect(html).toContain("<strong");
  expect(html).toContain("bold");
});

test("plain text, duration, score, and count render", () => {
  const html = render([
    { label: "Harness", value: { kind: "text", text: "Claude Code" } },
    { label: "Duration", value: { kind: "duration", ms: 120_000 } },
    { label: "Score", value: { kind: "score", value: 7, max: 10 } },
    { label: "Iterations", value: { kind: "count", n: 1, noun: "iteration" } },
  ]);
  expect(html).toContain("Claude Code");
  expect(html).toContain("2m");
  expect(html).toContain("7/10");
  expect(html).toContain("1 iteration");
});
