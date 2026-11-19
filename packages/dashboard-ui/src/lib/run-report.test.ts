import { describe, expect, test } from "bun:test";

import type { RunStageRecord } from "@/lib/api";
import { parseRunReport, reportHeadline, runReport } from "@/lib/run-report";

function implementationStage(detail: unknown, id = 1): RunStageRecord {
  return {
    id,
    runId: 7,
    stage: "implementation",
    status: "succeeded",
    summary: "implemented with Claude Code",
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
    createdAt: 0,
  };
}

const REPORT = [
  "No automation goal is blocked this run. One new failure pattern turned up.",
  "",
  "**Stuck PRs:**",
  "- #285 escalated again.",
  "",
  '<!-- devintern:outcome status=done reason="all goals met" -->',
  "<!-- devintern:summary:start -->",
  "## Why",
  "Scheduled check.",
  "<!-- devintern:summary:end -->",
].join("\n");

describe("parseRunReport", () => {
  test("splits the body from the summary briefing and drops the outcome marker", () => {
    const report = parseRunReport(REPORT)!;
    expect(report.body).toBe(
      "No automation goal is blocked this run. One new failure pattern turned up.\n\n**Stuck PRs:**\n- #285 escalated again.",
    );
    expect(report.briefing).toBe("## Why\nScheduled check.");
    expect(report.headline).toBe("No automation goal is blocked this run.");
  });

  test("uses the briefing as the body when the report is only a briefing", () => {
    const report = parseRunReport(
      "<!-- devintern:summary:start -->\n## Why\nBecause.\n<!-- devintern:summary:end -->",
    )!;
    expect(report.body).toBe("## Why\nBecause.");
    expect(report.briefing).toBeUndefined();
    expect(report.headline).toBeUndefined();
  });

  test("keeps text after an unterminated summary start out of the body", () => {
    const report = parseRunReport("Done.\n<!-- devintern:summary:start -->\n## Why\nx")!;
    expect(report.body).toBe("Done.");
    expect(report.briefing).toBe("## Why\nx");
  });

  test("returns undefined for an empty report", () => {
    expect(parseRunReport("  \n<!-- devintern:outcome status=noop -->\n")).toBeUndefined();
  });
});

describe("reportHeadline", () => {
  test("takes the first sentence as plain text without splitting version numbers", () => {
    expect(reportHeadline("I released `@getdevintern/code` 2.26.0. The tag is pushed.")).toBe(
      "I released @getdevintern/code 2.26.0.",
    );
  });

  test("strips emphasis and link targets", () => {
    expect(reportHeadline("**Nothing** sent, see [PR #5](https://x.test/5).")).toBe(
      "Nothing sent, see PR #5.",
    );
  });

  test("skips reports that open with structure instead of prose", () => {
    expect(reportHeadline("## Summary\nText.")).toBeUndefined();
    expect(reportHeadline("- item one\n- item two")).toBeUndefined();
    expect(reportHeadline("| a | b |\n|---|---|")).toBeUndefined();
  });

  test("uses the whole paragraph when it has no sentence end, bounded in length", () => {
    expect(reportHeadline("Queued three tasks")).toBe("Queued three tasks");
    const long = reportHeadline("word ".repeat(100))!;
    expect(long.length).toBeLessThanOrEqual(220);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("runReport", () => {
  test("reads the latest implementation report for prompt automations", () => {
    const stages = [
      implementationStage({ report: "First attempt." }, 1),
      implementationStage({ harness: "Claude Code", report: "Second attempt." }, 2),
    ];
    expect(runReport({ origin: "scheduled" }, stages)?.body).toBe("Second attempt.");
    expect(runReport({ origin: "manual" }, stages)?.body).toBe("Second attempt.");
  });

  test("ignores task runs, missing reports, and non-JSON detail", () => {
    const stages = [implementationStage({ report: "Done." })];
    expect(runReport({ origin: "task" }, stages)).toBeUndefined();
    expect(runReport({ origin: "scheduled" }, [implementationStage({ harness: "x" })])).toBe(
      undefined,
    );
    expect(runReport({ origin: "scheduled" }, [implementationStage("not json")])).toBeUndefined();
  });
});
