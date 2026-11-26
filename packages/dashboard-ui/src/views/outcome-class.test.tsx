/**
 * Outcome classes in the UI: the class badge, the runs-list cause line and
 * class filter, the run-detail failure banner (with its pre-filled report),
 * the inbox's DevIntern problems tab, the overview's split count, and the
 * demo's internal-failure fixture.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ALL_ROWS,
  ESCALATION_GROUP,
  INTERNAL_ERROR,
  NotificationHarness,
} from "@/components/notifications/notification-fixtures.test-helpers";
import { OutcomeClassBadge } from "@/components/OutcomeClassBadge";
import { NeedsYouBlock, needsYouCounts } from "@/components/overview/NeedsYouSection";
import type { RunRecord } from "@/lib/api";
import { inboxQuery } from "@/lib/api-notifications";
import {
  classifyDemoRunDetail,
  classifyDemoRuns,
  DEMO_INTERNAL_CAUSE,
  demoNotifications,
  filterRecordedRuns,
} from "@/lib/demo-snapshot";
import { runBranchHref, runCause } from "@/lib/run-outcome";
import { InboxView } from "@/views/InboxView";
import { RunsTable, RunsView } from "@/views/RunsView";
import { FailureBanner } from "@/views/run-detail/FailureBanner";
import { reportDraftForRun } from "@/views/run-detail/ReportProblem";

const CAUSE = "Remote branch refs/remotes/origin/feature/base not found";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 953,
    origin: "local",
    status: "escalated",
    taskKey: "local-notification-center-backend-notification",
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_600_000,
    outcomeReason: `verify: ${CAUSE}; work preserved on branch 'feature/x'`,
    outcomeClass: "internal",
    failureStage: "verify",
    failureCause: CAUSE,
    workStatus: "saved",
    workRef: "feature/x",
    ...overrides,
  };
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("OutcomeClassBadge", () => {
  test("every class has its own label, icon, and border style, not just a color", () => {
    const html = (outcomeClass: NonNullable<RunRecord["outcomeClass"]>) =>
      render(createElement(OutcomeClassBadge, { outcomeClass }));
    expect(html("internal")).toContain("DevIntern problem");
    expect(html("internal")).toContain("<svg");
    expect(html("review_hold")).toContain("Waiting on review");
    expect(html("review_hold")).toContain("border-dashed");
    expect(html("agent")).toContain("Agent stopped");
    expect(html("environment")).toContain("Environment");
    expect(html("internal")).toContain('data-outcome-class="internal"');
  });
});

describe("runs list", () => {
  test("a classified run shows its class badge and the cause as a secondary line", () => {
    const html = render(createElement(RunsTable, { runs: [run()], onOpenRun: () => {} }));
    expect(html).toContain('data-outcome-class="internal"');
    expect(html).toContain(`verify: ${CAUSE}`);
  });

  test("an unclassified run keeps the plain outcome reason", () => {
    const html = render(
      createElement(RunsTable, {
        runs: [run({ outcomeClass: undefined, failureCause: undefined, outcomeReason: "boom" })],
        onOpenRun: () => {},
      }),
    );
    expect(html).not.toContain("data-outcome-class");
    expect(html).toContain("boom");
  });

  test("the toolbar offers a class filter", () => {
    const html = render(
      createElement(RunsView, { onOpenRun: () => {}, initialOutcomeClass: "internal" }),
    );
    expect(html).toContain(">Class<");
    expect(html).toContain("DevIntern problem");
  });

  test("the demo answers the class filter like the server", () => {
    const all = [run({ id: 2 }), run({ id: 1, outcomeClass: "review_hold" })];
    expect(
      filterRecordedRuns(all, "/api/runs?outcomeClass=internal").runs.map((r) => r.id),
    ).toEqual([2]);
  });
});

describe("run-detail failure banner", () => {
  test("names the class, failing stage, cause, and saved branch, with a report action", () => {
    const html = render(createElement(FailureBanner, { run: run({ repo: "acme/web" }) }));
    expect(html).toContain("DevIntern problem");
    expect(html).toContain("verify failed");
    expect(html).toContain(CAUSE);
    expect(html).toContain("https://github.com/acme/web/tree/feature/x");
    expect(html).toContain("Report problem");
  });

  test("shows a kept worktree path or a loud work-discarded line", () => {
    expect(
      render(createElement(FailureBanner, { run: run({ workStatus: "kept", workRef: "/w/t/1" }) })),
    ).toContain("/w/t/1");
    const discarded = render(
      createElement(FailureBanner, { run: run({ workStatus: "discarded", workRef: undefined }) }),
    );
    expect(discarded).toContain("Work discarded");
    expect(discarded).toContain("text-danger");
  });

  test("only DevIntern problems get the report action; successes get no banner", () => {
    const agent = render(
      createElement(FailureBanner, {
        run: run({ outcomeClass: "agent", failureStage: undefined }),
      }),
    );
    expect(agent).toContain("Agent stopped");
    expect(agent).not.toContain("Report problem");
    expect(render(createElement(FailureBanner, { run: run({ status: "succeeded" }) }))).toBe("");
    expect(render(createElement(FailureBanner, { run: run(), canReport: false }))).not.toContain(
      "Report problem",
    );
  });

  test("the report draft is pre-filled with the stage and cause", () => {
    const draft = reportDraftForRun(run());
    expect(draft?.title).toBe("verify failed in run #953");
    expect(draft?.description).toContain(CAUSE);
    expect(draft?.description).toContain("Work saved on branch feature/x");
    expect(reportDraftForRun(run({ outcomeClass: "agent" }))).toBeUndefined();
  });

  test("helpers: cause falls back to the reason; branch links need a known host", () => {
    expect(runCause({ outcomeReason: "pushed but PR creation failed: 422" })).toBe(
      "pushed but PR creation failed: 422",
    );
    expect(runBranchHref({ repo: "devintern" }, "feature/x")).toBeUndefined();
    expect(
      runBranchHref({ prUrl: "https://github.com/o/r/pull/3", repo: "r" }, "feature/a b"),
    ).toBe("https://github.com/o/r/tree/feature/a%20b");
  });
});

describe("inbox", () => {
  let page: NotificationHarness | undefined;
  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  test("DevIntern problems and Waiting on review are separate tabs", async () => {
    page = new NotificationHarness([...ALL_ROWS, INTERNAL_ERROR]);
    await page.render(createElement(InboxView));
    await page.click(page.button("DevIntern problems"));
    expect(page.inboxTitles()).toEqual([INTERNAL_ERROR.title]);
    expect(page.calls.map((call) => call.url)).toContain(
      "/api/notifications?unresolved=true&kind=internal_error&limit=50",
    );
    await page.click(page.button("Waiting on review"));
    expect(page.inboxTitles()).toEqual([ESCALATION_GROUP.title]);
  });

  test("tab queries", () => {
    expect(inboxQuery("problems", false, 10)).toEqual({
      unresolved: true,
      kind: "internal_error",
      limit: 10,
    });
    expect(inboxQuery("review", true, 10)).toEqual({ kind: "escalated", limit: 10 });
  });
});

describe("overview", () => {
  test("splits the attention count from what waits on review", () => {
    expect(needsYouCounts(7, 5)).toBe("2 need attention · 5 waiting on review");
    expect(needsYouCounts(1, 0)).toBe("1 needs attention · 0 waiting on review");
    expect(needsYouCounts(3, undefined)).toBe("3");
    const html = render(
      createElement(NeedsYouBlock, {
        list: { notifications: [INTERNAL_ERROR, ESCALATION_GROUP], total: 2, limit: 5, offset: 0 },
        now: Date.now(),
        waitingOnReview: 1,
      }),
    );
    expect(html).toContain("1 needs attention · 1 waiting on review");
  });
});

describe("demo fixtures", () => {
  const recorded: RunRecord[] = [
    { id: 5, origin: "task", status: "succeeded", startedAt: 5, taskKey: "T-5" },
    { id: 4, origin: "auto_merge", status: "escalated", startedAt: 4, prNumber: 9 },
    {
      id: 3,
      origin: "task",
      status: "escalated",
      startedAt: 3,
      taskKey: "T-3",
      branch: "feature/t-3",
    },
    { id: 2, origin: "task", status: "failed", startedAt: 2, taskKey: "T-2" },
  ];

  test("an old recording gains an internal failure like run 953, holds, and agent stops", () => {
    const classified = classifyDemoRuns(recorded);
    const byId = new Map(classified.map((entry) => [entry.id, entry]));
    expect(byId.get(3)).toMatchObject({
      outcomeClass: "internal",
      failureStage: "verify",
      failureCause: DEMO_INTERNAL_CAUSE,
      workStatus: "saved",
      workRef: "feature/t-3",
    });
    expect(byId.get(4)?.outcomeClass).toBe("review_hold");
    expect(byId.get(2)?.outcomeClass).toBe("agent");
    expect(byId.get(5)?.outcomeClass).toBeUndefined();
    const detail = classifyDemoRunDetail({ run: recorded[2], stages: [] }, classified) as {
      run: RunRecord;
    };
    expect(detail.run.outcomeClass).toBe("internal");
    const internal = demoNotifications(classified, 1_800_000_000_000).find(
      (row) => row.kind === "internal_error",
    );
    expect(internal).toMatchObject({ runId: 3, severity: "high", count: 3 });
  });

  test("a recording that already carries classes is left alone", () => {
    const already = [{ ...recorded[3]!, outcomeClass: "environment" as const }];
    expect(classifyDemoRuns(already)).toEqual(already);
  });
});
