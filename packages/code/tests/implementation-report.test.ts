import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPLEMENTATION_REPORT_EXCERPT_LENGTH,
  readImplementationReport,
} from "../src/lib/agent/implementation-report";

let taskDir: string;

/** Write a summary file whose mtime is `ageMs` before `nowMs`. */
function writeSummary(name: string, content: string, mtimeMs: number): void {
  const path = join(taskDir, name);
  writeFileSync(path, content, "utf8");
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

const STARTED_AT = 1_700_000_000_000;

beforeEach(() => {
  taskDir = mkdtempSync(join(tmpdir(), "implementation-report-"));
});

afterEach(() => {
  rmSync(taskDir, { recursive: true, force: true });
});

describe("readImplementationReport", () => {
  test("returns the summary written by this attempt", () => {
    writeSummary("implementation-summary.md", "Implemented the parser.", STARTED_AT + 5_000);

    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({
      incomplete: false,
      report: "Implemented the parser.",
    });
  });

  test("ignores a summary left behind by an earlier attempt", () => {
    writeSummary("implementation-summary.md", "Old report.", STARTED_AT - 60_000);

    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({ incomplete: false });
  });

  test("accepts a summary whose mtime lands just before the attempt start", () => {
    // Fast runs can compare `Date.now()` against a file timestamp a fraction of
    // a millisecond earlier, which used to drop this attempt's own report.
    writeSummary("implementation-summary.md", "Implemented the parser.", STARTED_AT - 1);

    expect(readImplementationReport(taskDir, STARTED_AT).report).toBe("Implemented the parser.");
  });

  test("prefers the incomplete summary and marks the attempt incomplete", () => {
    writeSummary("implementation-summary.md", "Finished.", STARTED_AT + 5_000);
    writeSummary("implementation-summary-incomplete.md", "Stopped short.", STARTED_AT + 5_000);

    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({
      incomplete: true,
      report: "Stopped short.",
    });
  });

  test("prefers a fresh success summary over a stale incomplete summary from a prior attempt", () => {
    // A prior attempt's halt file predates this attempt by far more than the
    // mtime tolerance, so it is stale and must not override the success this
    // attempt just wrote.
    writeSummary("implementation-summary-incomplete.md", "Stale halt.", STARTED_AT - 500);
    writeSummary("implementation-summary.md", "Implemented the parser.", STARTED_AT + 5_000);

    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({
      incomplete: false,
      report: "Implemented the parser.",
    });
  });

  test("prefers a newer fresh success summary over an older fresh incomplete summary", () => {
    // Both files are inside this attempt: the halt was written first and the
    // success report after it, so the newer success must win instead of the
    // older incomplete file (the case that prevents a stale halt from
    // overriding a fresh report).
    writeSummary("implementation-summary-incomplete.md", "Halted.", STARTED_AT + 1_000);
    writeSummary("implementation-summary.md", "Implemented the parser.", STARTED_AT + 2_000);

    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({
      incomplete: false,
      report: "Implemented the parser.",
    });
  });

  test("prefers a newer incomplete summary over an older success summary", () => {
    writeSummary("implementation-summary.md", "Implemented the parser.", STARTED_AT + 1_000);
    writeSummary(
      "implementation-summary-incomplete.md",
      "Verification failed.",
      STARTED_AT + 2_000,
    );

    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({
      incomplete: true,
      report: "Verification failed.",
    });
  });

  test("reports no summary when the task directory has none", () => {
    expect(readImplementationReport(taskDir, STARTED_AT)).toEqual({ incomplete: false });
  });

  test("caps the persisted excerpt", () => {
    writeSummary(
      "implementation-summary.md",
      "x".repeat(IMPLEMENTATION_REPORT_EXCERPT_LENGTH + 50),
      STARTED_AT + 5_000,
    );

    expect(readImplementationReport(taskDir, STARTED_AT).report).toHaveLength(
      IMPLEMENTATION_REPORT_EXCERPT_LENGTH,
    );
  });
});
