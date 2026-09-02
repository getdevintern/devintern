import { describe, expect, test } from "bun:test";

import type { RunRecord } from "@/lib/api";
import { runPrHref, runWorkLink } from "@/lib/run-work";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 7,
    origin: "task",
    status: "succeeded",
    startedAt: 0,
    ...overrides,
  };
}

describe("runPrHref", () => {
  test("prefers the recorded PR URL", () => {
    expect(
      runPrHref({
        prUrl: "https://github.com/acme/widgets/pull/9",
        prNumber: 9,
        repo: "acme/widgets",
      }),
    ).toBe("https://github.com/acme/widgets/pull/9");
  });

  test("derives the PR URL from repo slug and number for legacy rows without one", () => {
    expect(runPrHref({ prNumber: 42, repo: "acme/widgets" })).toBe(
      "https://github.com/acme/widgets/pull/42",
    );
  });

  test("returns undefined when the run has no PR reference", () => {
    expect(runPrHref({})).toBeUndefined();
    expect(runPrHref({ repo: "acme/widgets" })).toBeUndefined();
    expect(runPrHref({ prNumber: 3 })).toBeUndefined();
  });
});

describe("runWorkLink", () => {
  test("scheduled and manual automation runs show the automation id, not the occurrence task key", () => {
    // Automation occurrences materialize as markdown tasks whose filename
    // stem (a timestamp) becomes the task key; the automation id is the
    // meaningful identifier.
    const occurrenceKey = "2026-09-01t09-30-00-000z";
    for (const origin of ["scheduled", "manual"] as const) {
      const link = runWorkLink(
        run({ origin, taskKey: occurrenceKey, automationId: "nightly-tidy" }),
      );
      expect(link).toEqual({ label: "nightly-tidy" });
    }
  });

  test("estimate sweeps keep the tracker task key they estimated", () => {
    const link = runWorkLink(
      run({ origin: "estimate", taskKey: "ENG-42", automationId: "estimation-sweep" }),
    );
    expect(link).toEqual({ label: "ENG-42", href: undefined });
  });

  test("legacy automation runs without an automation id fall back to the occurrence task key", () => {
    const link = runWorkLink(run({ origin: "scheduled", taskKey: "2026-08-30t03-00-00-000z" }));
    expect(link).toEqual({ label: "2026-08-30t03-00-00-000z", href: undefined });
  });

  test("task runs show the tracker key with its ticket link when available", () => {
    const link = runWorkLink(run({ taskKey: "ENG-42", ticketUrl: "https://tracker.test/ENG-42" }));
    expect(link).toEqual({ label: "ENG-42", href: "https://tracker.test/ENG-42" });
  });

  test("pr mention and conflict resolution runs name the PR and link to it", () => {
    for (const origin of ["pr_mention", "conflict_resolution"] as const) {
      const link = runWorkLink(
        run({
          origin,
          repo: "acme/widgets",
          prNumber: 42,
          prUrl: "https://github.com/acme/widgets/pull/42",
        }),
      );
      expect(link).toEqual({
        label: "PR #42",
        href: "https://github.com/acme/widgets/pull/42",
      });
    }
  });

  test("pr-affected rows without a recorded URL degrade to plain text, not a dead link", () => {
    const link = runWorkLink(run({ origin: "pr_mention", prNumber: 42 }));
    expect(link).toEqual({ label: "PR #42", href: undefined });
  });

  test("runs with nothing identifiable fall back to the run id", () => {
    expect(runWorkLink(run())).toEqual({ label: "Run 7" });
  });
});
