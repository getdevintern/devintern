import { describe, expect, test } from "bun:test";

import type { AutomationScheduleStatus } from "../src/lib/automation/acquirer";
import {
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
