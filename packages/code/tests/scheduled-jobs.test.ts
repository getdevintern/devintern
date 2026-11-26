import { describe, expect, test } from "bun:test";

import type { AutomationScheduleStatus } from "../src/lib/automation/acquirer";
import {
  AUTO_MERGE_JOB_ID,
  autoMergeDescription,
  composeScheduledJobActions,
  CONFLICT_RESOLUTION_JOB_ID,
} from "../src/lib/automation/scheduled-jobs";
import type { ConflictWindowSource } from "../src/lib/automation/scheduled-jobs";

function source(statuses: AutomationScheduleStatus[], triggered: string[]) {
  return {
    listSchedules: () => statuses,
    triggerManual: async (id: string) => {
      triggered.push(id);
      return { ok: true as const };
    },
  };
}

describe("composeScheduledJobActions", () => {
  const automation: AutomationScheduleStatus = {
    id: "deps",
    enabled: true,
    interval: "1d",
    prompt: "Update deps",
  };
  const estimation: AutomationScheduleStatus = {
    id: "deps",
    kind: "estimation",
    enabled: true,
    cron: "0 9 * * 1",
    prompt: "",
    query: "labels = needs-estimate",
    runFilter: { automationId: "deps", origin: "estimate" },
  };

  test("lists automations, namespaced estimations, and the scheduled conflict window", () => {
    let opened = 0;
    const conflicts: ConflictWindowSource = {
      conflictWindowStatus: () => ({ schedule: { cron: "0 2 * * *" }, nextWindowAt: 1234 }),
      openConflictWindowNow: () => {
        opened += 1;
        return { ok: true };
      },
    };
    const actions = composeScheduledJobActions({
      automations: source([automation], []),
      estimations: source([estimation], []),
      conflicts: () => conflicts,
      conflictAgent: () => ({ harness: "codex" }),
    });

    const jobs = actions.list();
    expect(jobs.map((job) => [job.id, job.kind, job.title])).toEqual([
      ["deps", "automation", undefined],
      ["estimation:deps", "estimation", "deps"],
      [CONFLICT_RESOLUTION_JOB_ID, "conflict_resolution", "Conflict resolution"],
    ]);
    expect(jobs[2]).toMatchObject({
      cron: "0 2 * * *",
      nextDueAt: 1234,
      harness: "codex",
      runFilter: { origin: "conflict_resolution" },
    });
    expect(opened).toBe(0);
  });

  test("omits the conflict entry outside scheduled mode or before hooks attach", () => {
    const off = composeScheduledJobActions({
      automations: source([], []),
      conflicts: () => ({
        conflictWindowStatus: () => null,
        openConflictWindowNow: () => ({ ok: false, reason: "auto" }),
      }),
    });
    expect(off.list()).toEqual([]);
    const unattached = composeScheduledJobActions({
      automations: source([], []),
      conflicts: () => undefined,
    });
    expect(unattached.list()).toEqual([]);
  });

  test("routes Run now to the owning scheduler by id namespace", async () => {
    const automationRuns: string[] = [];
    const estimationRuns: string[] = [];
    let opened = 0;
    const actions = composeScheduledJobActions({
      automations: source([automation], automationRuns),
      estimations: source([estimation], estimationRuns),
      conflicts: () => ({
        conflictWindowStatus: () => ({ schedule: { interval: "6h" } }),
        openConflictWindowNow: () => {
          opened += 1;
          return { ok: true };
        },
      }),
    });

    expect(await actions.trigger("deps")).toEqual({ ok: true });
    expect(await actions.trigger("estimation:deps")).toEqual({ ok: true });
    expect(await actions.trigger(CONFLICT_RESOLUTION_JOB_ID)).toEqual({ ok: true });
    expect(automationRuns).toEqual(["deps"]);
    expect(estimationRuns).toEqual(["deps"]);
    expect(opened).toBe(1);
  });

  test("refuses the conflict trigger when the review poller is not wired", async () => {
    const actions = composeScheduledJobActions({ automations: source([], []) });
    expect(await actions.trigger(CONFLICT_RESOLUTION_JOB_ID)).toEqual({
      ok: false,
      reason: "conflict resolution is not available on this worker",
    });
  });
});

describe("auto-merge job", () => {
  const settings = {
    enabled: true,
    method: "squash" as const,
    review: false,
    safePaths: ["docs/**"],
    denyPaths: ["**/prompts/**"],
    reviewPaths: ["**/AGENTS.md"],
    reviewLabel: "needs-human-review",
    policy: "strict" as const,
    reviewLargeDiffs: false,
    agent: { model: "sonnet" },
  };

  test("is listed while enabled and Run now triggers the watcher", async () => {
    let triggered = 0;
    const actions = composeScheduledJobActions({
      automations: source([], []),
      autoMerge: () => ({
        autoMergeStatus: () => ({ intervalSeconds: 60, nextTickAt: 999, running: false }),
        runAutoMergeNow: () => {
          triggered += 1;
          return { ok: true };
        },
      }),
      autoMergeSettings: () => settings,
    });
    const [job] = actions.list();
    expect(job).toMatchObject({
      id: AUTO_MERGE_JOB_ID,
      kind: "auto_merge",
      interval: "60s",
      nextDueAt: 999,
      runFilter: { origin: "auto_merge" },
    });
    // Review is off, so the review agent override is not shown.
    expect(job?.model).toBeUndefined();
    expect(await actions.trigger(AUTO_MERGE_JOB_ID)).toEqual({ ok: true });
    expect(triggered).toBe(1);
  });

  test("is hidden while disabled and unavailable without GitHub wiring", async () => {
    const hidden = composeScheduledJobActions({
      automations: source([], []),
      autoMerge: () => ({
        autoMergeStatus: () => null,
        runAutoMergeNow: () => ({ ok: false, reason: "disabled" }),
      }),
    });
    expect(hidden.list()).toEqual([]);
    const unwired = composeScheduledJobActions({ automations: source([], []) });
    expect(await unwired.trigger(AUTO_MERGE_JOB_ID)).toMatchObject({ ok: false });
  });

  test("description summarizes the live policy", () => {
    const text = autoMergeDescription(settings);
    expect(text).toContain("`docs/**`");
    expect(text).toContain("`**/prompts/**`");
    expect(text).toContain("`.github/**`");
    expect(text).toContain("**Review paths** (always sent to the agent review): `**/AGENTS.md`");
    expect(text).toContain("off (they stay open)");
  });
});
