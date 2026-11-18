import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { outcomeRunDisposition } from "../src/lib/agent/implementation-outcome";
import { RunStore } from "../src/lib/state/run-recorder";
import type { SessionPickupRunStore } from "../src/lib/state/session-pickup";
import {
  PICKUP_RUN_ID_ENV,
  isPickupStatus,
  pickupSelection,
  readImplementationReport,
  resolveSessionPickup,
} from "../src/lib/state/session-pickup";

describe("resolveSessionPickup", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `pickup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function failedRunWithState(taskKey: string, branch?: string, report?: string): number {
    const runId = store.createRun({ origin: "task", taskKey, ...(branch ? { branch } : {}) });
    if (report !== undefined) {
      store.addStage(
        runId,
        "implementation",
        "succeeded",
        "implemented",
        JSON.stringify({ report }),
      );
    }
    store.finishRun(runId, "failed", "agent exited non-zero");
    return runId;
  }

  test("selects only runs in the current tracker, team, repo, and origin", async () => {
    const scope = { tracker: "github", team: "team-b", repo: "shared", origin: "task" as const };
    const own = store.createRun({ ...scope, taskKey: "1", branch: "feature/own" });
    store.addStage(
      own,
      "implementation",
      "succeeded",
      "done",
      JSON.stringify({ report: "own report" }),
    );
    store.finishRun(own, "failed");
    for (const foreignScope of [
      { ...scope, team: "team-a" },
      { ...scope, tracker: "gitlab" },
      { ...scope, repo: "other" },
      { ...scope, origin: "error_monitor" as const },
      { ...scope, automationId: "nightly" },
    ]) {
      const foreign = store.createRun({ ...foreignScope, taskKey: "1", branch: "feature/foreign" });
      store.addStage(
        foreign,
        "implementation",
        "succeeded",
        "done",
        JSON.stringify({ report: "foreign report" }),
      );
      store.finishRun(foreign, "failed");
      expect(
        await resolveSessionPickup({ runStore: store, taskKey: "1", runId: foreign, scope }),
      ).toEqual({
        kind: "fresh",
        reason: "pinned run belongs to another task context",
      });
    }
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "1", scope });
    expect(decision.kind).toBe("resume");
    if (decision.kind === "resume") expect(decision.session.runId).toBe(own);
  });

  test("resumes the latest retriable run with branch, report, and landed work", async () => {
    const runId = failedRunWithState("PROJ-1", "feature/proj-1", "I added the parser");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-1",
      branchExists: () => true,
      describeLanded: ({ branch }) => `commits on ${branch}`,
    });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session).toMatchObject({
      runId,
      taskKey: "PROJ-1",
      status: "failed",
      branch: "feature/proj-1",
      report: "I added the parser",
      landed: "commits on feature/proj-1",
      outcomeReason: "agent exited non-zero",
    });
  });

  test("falls back when no prior attempt is on record", async () => {
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-2" });
    expect(decision).toEqual({ kind: "fresh", reason: "no prior attempt on record" });
  });

  test("falls back when the prior run did not end in a retriable status", async () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-3", branch: "feature/proj-3" });
    store.addStage(runId, "implementation", "succeeded", "done", JSON.stringify({ report: "x" }));
    store.finishRun(runId, "succeeded");

    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-3" });
    expect(decision).toEqual({ kind: "fresh", reason: "prior run is succeeded" });
  });

  test("falls back when the prior run recorded no branch", async () => {
    failedRunWithState("PROJ-4", undefined, "report but no branch");
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-4" });
    expect(decision).toEqual({ kind: "fresh", reason: "prior run recorded no branch" });
  });

  test("falls back when the prior run recorded no implementation report", async () => {
    failedRunWithState("PROJ-5", "feature/proj-5");
    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-5" });
    expect(decision).toEqual({
      kind: "fresh",
      reason: "prior run recorded no implementation report",
    });
  });

  test("resumes a failed run whose branch has commits even without a report", async () => {
    // Legacy/interrupted shape: the implementation stage was never written
    // before auto-review, but the branch holds the completed work.
    const runId = failedRunWithState("PROJ-5b", "feature/proj-5b");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5b",
      branchExists: () => true,
      hasLandedCommits: () => true,
      describeLanded: ({ branch }) => `Commits:\n123 add parser on ${branch}`,
    });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session).toMatchObject({
      runId,
      branch: "feature/proj-5b",
      landed: "Commits:\n123 add parser on feature/proj-5b",
      outcomeReason: "agent exited non-zero",
    });
    expect(decision.session.report).toBeUndefined();
  });

  test("falls back when the branch has no commits and no report", async () => {
    failedRunWithState("PROJ-5c", "feature/proj-5c");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5c",
      branchExists: () => true,
      hasLandedCommits: () => false,
    });

    expect(decision).toEqual({
      kind: "fresh",
      reason: "branch 'feature/proj-5c' has no commits to resume",
    });
  });

  test("starts the next automation occurrence fresh after a blocked PR-opening run", async () => {
    // A blocked run delivered (commits landed, PR opened) before its outcome
    // escalated it. The blocker is outside the code, so neither the next
    // occurrence nor a retry may resume its branch.
    const scope = {
      origin: "scheduled" as const,
      automationId: "release",
      tracker: "markdown",
      repo: "app",
    };
    const disposition = outcomeRunDisposition({ status: "blocked", reason: "test gate failed" });
    expect(disposition.status).toBe("escalated");
    const blocked = store.createRun({ ...scope, taskKey: "release", branch: "feature/release" });
    store.addStage(
      blocked,
      "implementation",
      "succeeded",
      "implemented",
      JSON.stringify({ report: "could not release" }),
    );
    store.finishRun(blocked, disposition.status, disposition.reason);
    const next = store.createRun({ ...scope, taskKey: "release" });

    const probes = { branchExists: () => true, hasLandedCommits: () => true };
    for (const selection of [{ excludeRunId: next }, { runId: blocked }]) {
      expect(
        await resolveSessionPickup({
          runStore: store,
          taskKey: "release",
          scope,
          ...selection,
          ...probes,
        }),
      ).toEqual({ kind: "fresh", reason: "prior run reported its goal as blocked" });
    }

    // An incomplete handoff is also escalated, but it is unfinished work and
    // stays resumable.
    const incomplete = store.createRun({ ...scope, taskKey: "release", branch: "feature/release" });
    store.finishRun(incomplete, "escalated", "implementation incomplete; handed back to a human");
    const resumed = await resolveSessionPickup({
      runStore: store,
      taskKey: "release",
      scope,
      runId: incomplete,
      ...probes,
    });
    expect(resumed.kind).toBe("resume");
  });

  test("requires commits when a report came from a failed implementation stage", async () => {
    // Delivery halts after the early stage write are corrected to "failed".
    // The report alone must not make an empty branch resumable.
    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-5e",
      branch: "feature/proj-5e",
    });
    store.addStage(
      runId,
      "implementation",
      "failed",
      "implementation not delivered",
      JSON.stringify({ report: "claims the work was implemented" }),
    );
    store.finishRun(runId, "failed", "Implementation was not committed");

    const empty = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5e",
      branchExists: () => true,
      hasLandedCommits: () => false,
    });
    expect(empty).toEqual({
      kind: "fresh",
      reason: "branch 'feature/proj-5e' has no commits to resume",
    });

    const landed = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5e",
      branchExists: () => true,
      hasLandedCommits: () => true,
    });
    expect(landed.kind).toBe("resume");
    if (landed.kind === "resume") {
      expect(landed.session.report).toBe("claims the work was implemented");
    }
  });

  test("requires commits when a succeeded report predates delivery", async () => {
    // recordCompletedImplementation writes a succeeded stage as soon as the
    // agent session ends, before commit/verify/auto-review. A crash or SIGTERM
    // during delivery leaves that stage plus a report on an empty branch, so a
    // supplied commit probe must veto resuming it.
    const runId = store.createRun({
      origin: "task",
      taskKey: "PROJ-5f",
      branch: "feature/proj-5f",
    });
    store.addStage(
      runId,
      "implementation",
      "succeeded",
      "implemented with claude",
      JSON.stringify({ report: "claims the work was implemented" }),
    );
    store.finishRun(runId, "failed", "worker restarted during commit");

    const empty = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5f",
      branchExists: () => true,
      hasLandedCommits: () => false,
    });
    expect(empty).toEqual({
      kind: "fresh",
      reason: "branch 'feature/proj-5f' has no commits to resume",
    });

    const landed = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5f",
      branchExists: () => true,
      hasLandedCommits: () => true,
    });
    expect(landed.kind).toBe("resume");
    if (landed.kind === "resume") {
      expect(landed.session.report).toBe("claims the work was implemented");
    }
  });

  test("falls back when the commit probe throws", async () => {
    failedRunWithState("PROJ-5d", "feature/proj-5d");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-5d",
      hasLandedCommits: () => {
        throw new Error("git unavailable");
      },
    });

    expect(decision.kind).toBe("fresh");
  });

  test("falls back when the recorded branch no longer exists", async () => {
    failedRunWithState("PROJ-6", "feature/proj-6", "some report");
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-6",
      branchExists: () => false,
    });
    expect(decision).toEqual({
      kind: "fresh",
      reason: "branch 'feature/proj-6' no longer exists",
    });
  });

  test("falls back when the branch probe throws", async () => {
    failedRunWithState("PROJ-6b", "feature/proj-6b", "some report");
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-6b",
      branchExists: () => {
        throw new Error("git unavailable");
      },
    });
    expect(decision.kind).toBe("fresh");
  });

  test("ignores a non-JSON landed-work describer failure", async () => {
    failedRunWithState("PROJ-6c", "feature/proj-6c", "some report");
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-6c",
      describeLanded: () => {
        throw new Error("git exploded");
      },
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session.landed).toBeUndefined();
  });

  test("prefers an explicitly requested run id", async () => {
    failedRunWithState("PROJ-7", "feature/proj-7", "first report");
    const newer = failedRunWithState("PROJ-7", "feature/proj-7-attempt-2", "second report");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-7",
      runId: newer,
    });
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session.runId).toBe(newer);
    expect(decision.session.branch).toBe("feature/proj-7-attempt-2");
    expect(decision.session.report).toBe("second report");
  });

  test("treats an unknown explicit run id as fresh", async () => {
    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-8",
      runId: 9999,
    });
    expect(decision).toEqual({ kind: "fresh", reason: "no prior attempt on record" });
  });

  test("rejects a pinned run that belongs to another task", async () => {
    // A stale or mis-propagated DEVINTERN_PICKUP_RUN_ID must not let this task
    // resume another task's branch and inherit its implementation report.
    const other = failedRunWithState("PROJ-13", "feature/proj-13", "other report");
    failedRunWithState("PROJ-14", "feature/proj-14", "own report");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-14",
      runId: other,
    });

    expect(decision).toEqual({ kind: "fresh", reason: "pinned run belongs to another task" });
  });

  test("resumes the prior attempt when the current run is excluded", async () => {
    // The pipeline opens the current run before resolving pickup; excluding it
    // must leave the immediately preceding terminal attempt as the candidate.
    const prior = failedRunWithState("PROJ-10", "feature/proj-10", "prior report");
    const current = store.createRun({ origin: "task", taskKey: "PROJ-10" });

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-10",
      excludeRunId: current,
    });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session.runId).toBe(prior);
    expect(decision.session.branch).toBe("feature/proj-10");
    expect(decision.session.report).toBe("prior report");
  });

  test("the just-opened in_progress run shadows the prior attempt without exclusion", async () => {
    // Documents the bug the pipeline avoids by passing excludeRunId.
    failedRunWithState("PROJ-11", "feature/proj-11", "prior report");
    store.createRun({ origin: "task", taskKey: "PROJ-11" });

    const decision = await resolveSessionPickup({ runStore: store, taskKey: "PROJ-11" });
    expect(decision).toEqual({ kind: "fresh", reason: "prior run is in_progress" });
  });

  test("an explicit run id wins over the excluded id", async () => {
    const prior = failedRunWithState("PROJ-12", "feature/proj-12", "first report");
    const newer = failedRunWithState("PROJ-12", "feature/proj-12-attempt-2", "second report");

    const decision = await resolveSessionPickup({
      runStore: store,
      taskKey: "PROJ-12",
      runId: prior,
      excludeRunId: newer,
    });

    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") return;
    expect(decision.session.runId).toBe(prior);
  });

  test("degrades to fresh when the run store is unavailable", async () => {
    const broken: SessionPickupRunStore = {
      getRun: () => {
        throw new Error("db closed");
      },
      listRuns: () => {
        throw new Error("db closed");
      },
      listStages: () => [],
    };
    const decision = await resolveSessionPickup({ runStore: broken, taskKey: "PROJ-9" });
    expect(decision).toEqual({ kind: "fresh", reason: "run store unavailable" });
  });
});

describe("readImplementationReport", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `pickup-report-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("returns the most recent valid implementation report", () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-1" });
    store.addStage(runId, "implementation", "failed", "first", JSON.stringify({ report: "old" }));
    store.addStage(
      runId,
      "implementation",
      "succeeded",
      "second",
      JSON.stringify({ report: "new" }),
    );
    expect(readImplementationReport(store, runId)).toBe("new");
  });

  test("ignores non-implementation stages, malformed JSON, and empty reports", () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-2" });
    store.addStage(runId, "feasibility", "succeeded", "ok", JSON.stringify({ report: "nope" }));
    store.addStage(runId, "implementation", "succeeded", "truncated", '{"report": "unterminated');
    store.addStage(runId, "implementation", "succeeded", "blank", JSON.stringify({ report: "  " }));
    expect(readImplementationReport(store, runId)).toBeUndefined();
  });

  test("returns undefined when there are no stages", () => {
    const runId = store.createRun({ origin: "task", taskKey: "PROJ-3" });
    expect(readImplementationReport(store, runId)).toBeUndefined();
  });
});

describe("isPickupStatus", () => {
  test("accepts terminal retriable statuses only", () => {
    expect(isPickupStatus("failed")).toBe(true);
    expect(isPickupStatus("escalated")).toBe(true);
    expect(isPickupStatus("abandoned")).toBe(true);
    expect(isPickupStatus("succeeded")).toBe(false);
    expect(isPickupStatus("in_progress")).toBe(false);
    expect(isPickupStatus("deferred")).toBe(false);
  });
});

describe("pickupSelection", () => {
  test("pins the env-provided run id and ignores the current run", () => {
    const selection = pickupSelection(7, {
      [PICKUP_RUN_ID_ENV]: "42",
    } as NodeJS.ProcessEnv);
    expect(selection).toEqual({ runId: 42 });
  });

  test("excludes the current run when the env is absent", () => {
    expect(pickupSelection(7, {} as NodeJS.ProcessEnv)).toEqual({ excludeRunId: 7 });
  });

  test("ignores malformed env values and falls back to excluding the current run", () => {
    expect(pickupSelection(7, { [PICKUP_RUN_ID_ENV]: "abc" } as NodeJS.ProcessEnv)).toEqual({
      excludeRunId: 7,
    });
    expect(pickupSelection(7, { [PICKUP_RUN_ID_ENV]: "0" } as NodeJS.ProcessEnv)).toEqual({
      excludeRunId: 7,
    });
  });

  test("excludes an undefined current run when unpinned", () => {
    expect(pickupSelection(undefined, {} as NodeJS.ProcessEnv)).toEqual({
      excludeRunId: undefined,
    });
  });
});

describe("resolveSessionPickup reopenSucceeded (ad-hoc re-queue)", () => {
  let dbPath: string;
  let store: RunStore;
  const scope = { origin: "local" as const, tracker: "local", repo: "x-rep" };
  const branch = "feature/local-add-helper";

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `pickup-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /** A succeeded run with a report, optionally with a recorded PR, plus the re-queued current run. */
  function succeededRun(prUrl?: string): { prior: number; current: number } {
    const prior = store.createRun({ ...scope, taskKey: "local-add-helper", branch });
    store.addStage(
      prior,
      "implementation",
      "succeeded",
      "implemented",
      JSON.stringify({ report: "added truncate()" }),
    );
    if (prUrl) store.setRunPr(prior, { url: prUrl, prNumber: 15 });
    store.finishRun(prior, "succeeded");
    const current = store.createRun({ ...scope, taskKey: "local-add-helper" });
    return { prior, current };
  }

  async function resolve(
    current: number,
    probes: {
      branchExists?: boolean;
      landed?: boolean;
      open?: "open" | "closed" | "none" | undefined;
      reopen?: boolean;
      notBefore?: number;
      onProbe?: () => void;
    } = {},
  ) {
    return resolveSessionPickup({
      runStore: store,
      taskKey: "local-add-helper",
      scope,
      excludeRunId: current,
      branchExists: () => probes.branchExists ?? true,
      hasLandedCommits: () => probes.landed ?? true,
      ...((probes.reopen ?? true)
        ? {
            reopenSucceeded: {
              notBefore: probes.notBefore ?? 0,
              isChangeRequestOpen: () => {
                probes.onProbe?.();
                return probes.open;
              },
            },
          }
        : {}),
    });
  }

  test("pushed-no-PR branch with no PR on the host resumes", async () => {
    const { prior, current } = succeededRun();
    let probed = false;
    const pickup = await resolve(current, { open: "none", onProbe: () => (probed = true) });
    expect(pickup.kind).toBe("resume");
    if (pickup.kind !== "resume") return;
    expect(pickup.session).toMatchObject({
      runId: prior,
      status: "succeeded",
      branch,
      report: "added truncate()",
    });
    expect(probed).toBe(true);
  });

  test("pushed-no-PR branch resumes when the PR state is unknown", async () => {
    const { prior, current } = succeededRun();
    const pickup = await resolve(current, { open: undefined });
    expect(pickup).toMatchObject({ kind: "resume", session: { runId: prior, branch } });
  });

  test("pushed-no-PR branch whose hand-opened PR was merged starts fresh", async () => {
    const { current } = succeededRun();
    expect(await resolve(current, { open: "closed" })).toEqual({
      kind: "fresh",
      reason: `a PR for '${branch}' was already merged or closed`,
    });
  });

  test("open-PR branch resumes and carries the recorded PR", async () => {
    const prUrl = "https://github.com/acme/x-rep/pull/15";
    const { prior, current } = succeededRun(prUrl);
    const pickup = await resolve(current, { open: "open" });
    expect(pickup.kind).toBe("resume");
    if (pickup.kind !== "resume") return;
    expect(pickup.session).toMatchObject({ runId: prior, branch, prUrl });
  });

  test("closed or merged PR starts fresh", async () => {
    const { current } = succeededRun("https://github.com/acme/x-rep/pull/15");
    expect(await resolve(current, { open: "closed" })).toEqual({
      kind: "fresh",
      reason: `prior run's PR for '${branch}' is no longer open`,
    });
  });

  test("a PR whose state cannot be confirmed starts fresh", async () => {
    const { current } = succeededRun("https://gitlab.com/acme/x-rep/-/merge_requests/15");
    expect(await resolve(current, { open: undefined })).toEqual({
      kind: "fresh",
      reason: `could not confirm prior run's PR for '${branch}' is still open`,
    });
  });

  test("missing branch starts fresh", async () => {
    const { current } = succeededRun();
    expect(await resolve(current, { branchExists: false })).toEqual({
      kind: "fresh",
      reason: `branch '${branch}' no longer exists`,
    });
  });

  test("a pushed-no-PR branch without commits ahead starts fresh", async () => {
    const { current } = succeededRun();
    expect(await resolve(current, { landed: false })).toEqual({
      kind: "fresh",
      reason: `branch '${branch}' has no commits to resume`,
    });
  });

  test("a succeeded run from before the queue row was enqueued stays final", async () => {
    // A pruned row's key reused by a later `worker add` with the same title:
    // the old run predates the new row, so it is not this task's prior attempt.
    const { prior, current } = succeededRun();
    const startedAt = store.getRun(prior)!.startedAt;
    expect(await resolve(current, { notBefore: startedAt + 1 })).toEqual({
      kind: "fresh",
      reason: "prior run is succeeded",
    });
    // A run of the same row (started at or after enqueue) still reopens.
    expect((await resolve(current, { notBefore: startedAt })).kind).toBe("resume");
  });

  test("without the opt-in a succeeded run stays final", async () => {
    const { current } = succeededRun();
    expect(await resolve(current, { reopen: false })).toEqual({
      kind: "fresh",
      reason: "prior run is succeeded",
    });
  });
});
