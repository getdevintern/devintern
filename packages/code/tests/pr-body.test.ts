import { describe, expect, test } from "bun:test";
import {
  buildPrBody,
  parsePrBodySections,
  PR_BODY_SECTION_KEYS,
} from "../src/lib/code-host/pr-body";

const headings = (body: string): string[] =>
  body
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));

describe("buildPrBody", () => {
  test("emits every section in template order", () => {
    const body = buildPrBody({ taskKey: "DEV-1", taskSummary: "Add a widget" });

    expect(headings(body)).toEqual([
      "Why",
      "What changed",
      "Scope",
      "Tradeoffs",
      "Blast Radius",
      "Verification",
    ]);
    expect(PR_BODY_SECTION_KEYS).toHaveLength(6);
  });

  test("marks sections with no content as N/A", () => {
    const body = buildPrBody({ taskKey: "DEV-1", taskSummary: "Add a widget" });

    expect(body).toContain("## What changed\n\nN/A");
    expect(body).toContain("## Scope\n\nN/A");
    expect(body).toContain("## Tradeoffs\n\nN/A");
    expect(body).toContain("## Blast Radius\n\nN/A");
    expect(body).toContain("## Verification\n\nN/A");
  });

  test("falls back to the task summary for Why", () => {
    const body = buildPrBody({ taskKey: "DEV-1", taskSummary: "Add a widget" });
    expect(body).toContain("## Why\n\nTask DEV-1: Add a widget");
  });

  test("reuses structured sections from the implementation summary", () => {
    const summary = `## Why
Users cannot undo.
## What changed
- Added an undo stack.
## Scope
Not adding redo.
## Tradeoffs
Chose memory over persistence.
## Blast Radius
Only the editor.
## Verification
- \`bun test\` passed.`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain("## Why\n\nTask DEV-1: Add a widget\n\nUsers cannot undo.");
    expect(body).toContain("## What changed\n\n- Added an undo stack.");
    expect(body).toContain("## Scope\n\nNot adding redo.");
    expect(body).toContain("## Tradeoffs\n\nChose memory over persistence.");
    expect(body).toContain("## Blast Radius\n\nOnly the editor.");
    expect(body).toContain("## Verification\n\n- \`bun test\` passed.");
  });

  test("puts an unstructured summary under What changed", () => {
    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: "Replaced the parser with a state machine.",
    });

    expect(body).toContain("## What changed\n\nReplaced the parser with a state machine.");
    expect(body).toContain("## Scope\n\nN/A");
  });

  test("maps common heading aliases to template sections", () => {
    const summary = `## Changes Made
Renamed the flag.
### Testing
Ran the CLI end to end.`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain("## What changed\n\nRenamed the flag.");
    expect(body).toContain("## Verification\n\nRan the CLI end to end.");
  });

  test("includes the automatic-creation footer", () => {
    const body = buildPrBody({ taskKey: "DEV-1", taskSummary: "Add a widget" });
    expect(body).toContain("*This PR was automatically created by @devintern/code*");
  });

  test("keeps leading narrative before a recognized heading under What changed", () => {
    const summary = `Implemented X by rewriting the parser.

## Verification
- tests pass`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain("## What changed\n\nImplemented X by rewriting the parser.");
    expect(body).toContain("## Verification\n\n- tests pass");
  });

  test("merges leading narrative with an explicit What changed section", () => {
    const summary = `Implemented X by rewriting the parser.

## What changed
- Swapped the recursive descent parser.`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain(
      "## What changed\n\nImplemented X by rewriting the parser.\n\n- Swapped the recursive descent parser.",
    );
  });

  test("does not treat headings inside fenced code blocks as sections", () => {
    const summary = `## What changed
Here is the example:

\`\`\`ts
## Verification
const x = 1;
\`\`\`

Done.

## Verification
- tests pass`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain("## What changed\n\nHere is the example:");
    expect(body).toContain("## Verification\n\n- tests pass");
    expect(body).not.toContain("## Verification\n\n## Verification");
    expect(body).toContain("```ts\n## Verification\nconst x = 1;\n```");
  });

  test("keeps unrecognized headings inside the section they appear in", () => {
    const summary = `## What changed
Did A.
### Notes
Some important note.
## Verification
Tests pass.`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain("## What changed\n\nDid A.\n### Notes\nSome important note.");
    expect(body).toContain("## Verification\n\nTests pass.");
  });

  test("keeps the first occurrence of a duplicated section heading", () => {
    const summary = `## What changed
first pass

## What changed
second pass`;

    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: summary,
    });

    expect(body).toContain("## What changed\n\nfirst pass");
    expect(body).not.toContain("second pass");
  });

  test("keeps the task reference when the summary supplies a Why section", () => {
    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Add a widget",
      implementationSummary: "## Why\nUsers cannot undo.",
    });

    expect(body).toContain("## Why\n\nTask DEV-1: Add a widget\n\nUsers cannot undo.");
  });

  test("falls back to the task summary for Why with special characters", () => {
    const body = buildPrBody({
      taskKey: "DEV-1",
      taskSummary: "Handle OAuth2: tokens & refresh (v2) #42",
    });

    expect(body).toContain("## Why\n\nTask DEV-1: Handle OAuth2: tokens & refresh (v2) #42");
  });
});

describe("parsePrBodySections", () => {
  test("returns an empty object for missing or empty input", () => {
    expect(parsePrBodySections(undefined)).toEqual({});
    expect(parsePrBodySections("")).toEqual({});
  });

  test("ignores headings that do not map to a template section", () => {
    expect(parsePrBodySections("## Random\ncontent")).toEqual({});
  });

  test("ignores headings inside fenced code blocks", () => {
    const sections = parsePrBodySections("```md\n## Verification\nstill code\n```");

    expect(sections).toEqual({});
  });

  test("does not include leading narrative in parsed sections", () => {
    const sections = parsePrBodySections("Preamble text\n## Verification\ndone");

    expect(sections).toEqual({ verification: "done" });
  });
});
