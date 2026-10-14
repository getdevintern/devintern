import { describe, expect, test } from "bun:test";
import { extractImplementationSummary } from "../src/lib/agent/implementation-summary";
import {
  buildPrBody,
  parsePrBodySections,
  PR_BODY_SECTION_KEYS,
} from "../src/lib/code-host/pr-body";

const briefing = `## Why
Repeated finishes appended duplicate outcomes.
## What changed
Made run and outcome writes atomic.
## Scope
Run recording only; no queue changes.
## Tradeoffs
Replace the outcome instead of retaining duplicate history.
## Blast Radius
Run completion and orphan reaping share the outcome writer.
## Verification
bun test tests/run-recorder.test.ts: passed.`;
const marked = (summary: string) =>
  `<!-- devintern:summary:start -->\n${summary}\n<!-- devintern:summary:end -->`;

describe("final implementation briefing", () => {
  test("publishes all sections without streamed progress or trailing narration", () => {
    const output = `I'll start by exploring.\n${marked(briefing)}\nNo commit was made.`;
    const body = buildPrBody({
      taskKey: "DEV-159",
      taskSummary: "Idempotency audit",
      implementationSummary: output,
    });
    expect(extractImplementationSummary(output)).toBe(briefing);
    expect(Object.keys(parsePrBodySections(body))).toEqual([...PR_BODY_SECTION_KEYS]);
    expect(body).not.toContain("N/A");
    expect(body).not.toContain("I'll start");
    expect(body).not.toContain("No commit");
    expect(body).not.toContain("<!--");
    expect(body).toContain("## Verification\n\nbun test tests/run-recorder.test.ts: passed.");
  });

  test("uses the last complete briefing", () => {
    expect(extractImplementationSummary(`${marked("old")}\n${marked(briefing)}`)).toBe(briefing);
  });

  test("ignores marker examples in backtick and tilde fences", () => {
    for (const fence of ["```md", "~~~~md"]) {
      const close = fence.replace("md", "");
      const example = `${fence}\n${marked("example")}\n${close}`;
      expect(extractImplementationSummary(example)).toBe(example);
      expect(extractImplementationSummary(`${marked(briefing)}\n${example}`)).toBe(briefing);
    }
  });

  test("preserves fences inside the actual briefing", () => {
    const summary = `## Verification\n\`\`\`md\n${marked("example")}\n\`\`\`\nPassed.`;
    expect(extractImplementationSummary(marked(summary))).toBe(summary);
  });

  test("retains legacy, empty, and truncated output instead of losing evidence", () => {
    for (const output of [
      "",
      "Verification: tests passed",
      marked(""),
      "<!-- devintern:summary:start -->\npartial",
    ]) {
      expect(extractImplementationSummary(output)).toBe(output);
    }
  });

  test("handles CRLF output", () => {
    expect(extractImplementationSummary(marked(briefing).replaceAll("\n", "\r\n"))).toBe(briefing);
  });
});
