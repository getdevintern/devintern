import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RunStore } from "../src/lib/state/run-recorder";
import type { RunOrigin } from "../src/lib/state/run-recorder";
import { WorkerState } from "../src/lib/state/worker-state";

const REPO = "acme/widgets";
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;

describe("deferred PR-driven runs", () => {
  let dbPath: string;
  let runs: RunStore;
  let state: WorkerState;

  beforeEach(() => {
    dbPath = join(tmpdir(), `deferred-pr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    runs = new RunStore(dbPath);
    state = new WorkerState(dbPath);
  });

  afterEach(() => {
    state.close();
    runs.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  function deferredRun(origin: RunOrigin, prNumber: number, taskKey?: string): number {
    const id = runs.createRun({
      origin,
      repo: REPO,
      prNumber,
      prUrl: prUrl(prNumber),
      ...(taskKey ? { taskKey } : {}),
    });
    runs.finishRun(id, "deferred", "Agent usage limit reached");
    return id;
  }

  function outcome(id: number) {
    const run = runs.getRun(id);
    const stage = runs.listStages(id).find((entry) => entry.stage === "outcome");
    return { status: run?.status, reason: run?.outcomeReason, stage: stage?.status };
  }

  test("closing a PR settles its keyless deferred runs only", () => {
    state.recordAgentPr({ repo: REPO, prNumber: 7 });
    const ciFix = deferredRun("ci_fix", 7);
    const conflict = deferredRun("conflict_resolution", 7);
    const keyed = deferredRun("ci_fix", 7, "TASK-1");
    const otherPr = deferredRun("ci_fix", 8);

    state.markAgentPrClosed(REPO, 7, "merged");

    for (const id of [ciFix, conflict]) {
      expect(outcome(id)).toEqual({
        status: "abandoned",
        reason: "superseded: the PR merged before this deferred run retried",
        stage: "abandoned",
      });
    }
    expect(outcome(keyed).status).toBe("deferred");
    expect(outcome(otherPr).status).toBe("deferred");
  });

  test("green CI settles only the PR's deferred CI fixes", () => {
    const ciFix = deferredRun("ci_fix", 7);
    const conflict = deferredRun("conflict_resolution", 7);

    expect(state.settleDeferredCiFixRuns(REPO, 7)).toEqual([ciFix]);
    expect(outcome(ciFix).reason).toBe("superseded: CI passed before this deferred CI fix retried");
    expect(outcome(conflict).status).toBe("deferred");
    expect(state.settleDeferredCiFixRuns(REPO, 7)).toEqual([]);
  });

  test("startup sweep settles deferred runs on PRs already closed", () => {
    state.recordAgentPr({ repo: REPO, prNumber: 7 });
    state.recordAgentPr({ repo: REPO, prNumber: 8 });
    state.markAgentPrClosed(REPO, 7);
    // Deferred after the close event, as rows recorded before this fix were.
    const stale = deferredRun("ci_fix", 7);
    const open = deferredRun("ci_fix", 8);

    expect(state.settleDeferredRunsOnClosedPrs()).toEqual([stale]);
    expect(outcome(stale)).toMatchObject({
      status: "abandoned",
      reason: "superseded: the PR closed before this deferred run retried",
    });
    expect(outcome(open).status).toBe("deferred");
  });
});
