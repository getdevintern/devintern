import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  TaskPollingAcquirer,
  WAITING_RECHECK_MAX_MS,
  waitingRecheckDelayMs,
} from "../src/lib/acquirers/task-polling";
import type { ReadyTask, TaskPollOutcome } from "../src/lib/acquirers/task-polling";
import { buildPrBody, stackedOnFromDescription } from "../src/lib/code-host/pr-body";
import {
  encodeStackBaseEnv,
  renderStackedOnSection,
  STACKED_ON_ENV,
  stackBaseFromEnv,
  takeStackBaseFromEnv,
} from "../src/lib/dependencies/stacked-base";
import type { StackBase } from "../src/lib/dependencies/gate";
import { collectQueuedWork, queuedDependencyStatus } from "../src/lib/observability/queued-work";
import { RunStore } from "../src/lib/state/run-recorder";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { buildRetryQueueAcquirer } from "../src/lib/workspace/workspace-worker";
import { dropUnusedStackBase, recordConfirmedStackBase } from "../src/lib/task/pipeline";
import { TaskFormatter } from "../src/lib/task/formatter";
import type { FormattedTaskDetails } from "../src/types/task-tracker";
import type { RunStatus } from "../src/lib/state/run-recorder";
import {
  readTrackerDependencyWaits,
  TrackerDependencyStore,
} from "../src/lib/state/tracker-dependencies";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";
import { supportsDependencies } from "../src/lib/trackers/capabilities";
import type { TaskBlocker } from "../src/lib/trackers/client";
import { GitHubTaskTrackerClient } from "../src/lib/trackers/github/github-task-tracker-client";
import { JiraTaskTrackerClient } from "../src/lib/trackers/jira/jira-task-tracker-client";
import { LinearTaskTrackerClient } from "../src/lib/trackers/linear/linear-task-tracker-client";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { createGatedFleetTaskExecutor } from "../src/lib/workspace/fleet-executor";
import { createFleetTaskEvaluator } from "../src/lib/workspace/fleet-events";
import type { RepoManagerLike } from "../src/lib/workspace/fleet-executor";
import { RoutingSkipStore } from "../src/lib/workspace/state";
import { createTrackerDependencyGate } from "../src/lib/workspace/tracker-dependency-gate";
import type {
  TrackerDependencyGateOptions,
  TrackerGateOutcome,
} from "../src/lib/workspace/tracker-dependency-gate";

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("tracker capability", () => {
  test("Jira, Linear, and GitHub model native blockers; others do not", () => {
    expect(supportsDependencies("jira")).toBe(true);
    expect(supportsDependencies("linear")).toBe(true);
    expect(supportsDependencies("github")).toBe(true);
    for (const tracker of ["gitlab", "azure-devops", "asana", "trello", "markdown", "nope"]) {
      expect(supportsDependencies(tracker)).toBe(false);
    }
  });
});

describe("Jira getBlockers", () => {
  const status = (name: string, key: string) => ({
    name,
    statusCategory: { id: 1, name, key, colorName: "x" },
  });
  const linked = (key: string, statusName: string, category: string) => ({
    id: key,
    key,
    fields: { summary: key, status: status(statusName, category) },
  });
  const blocks = { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" };

  test("returns inward Blocks links with their status category", async () => {
    const client = new JiraTaskTrackerClient("https://jira.example", "me@example.com", "tok");
    const urls: string[] = [];
    client.jiraApiCall = async (_method: string, url: string) => {
      urls.push(url);
      return {
        key: "PROJ-20",
        fields: {
          issuelinks: [
            // PROJ-20 is blocked by PROJ-12 (not done) and PROJ-11 (done).
            {
              id: "a",
              type: blocks,
              inwardIssue: linked("PROJ-12", "In Progress", "indeterminate"),
            },
            { id: "b", type: blocks, inwardIssue: linked("PROJ-11", "Done", "done") },
            // PROJ-20 blocks PROJ-30: not a blocker of PROJ-20.
            { id: "c", type: blocks, outwardIssue: linked("PROJ-30", "To Do", "new") },
            // Other link types are ignored.
            {
              id: "d",
              type: { id: "2", name: "Relates", inward: "relates to", outward: "relates to" },
              inwardIssue: linked("PROJ-40", "To Do", "new"),
            },
            // A renamed type that keeps the standard inward/outward names still counts.
            {
              id: "e",
              type: { id: "3", name: "Dependency", inward: "is blocked by", outward: "blocks" },
              inwardIssue: linked("PROJ-13", "To Do", "new"),
            },
          ],
        },
      };
    };

    const blockers = await client.getBlockers("PROJ-20");
    expect(urls).toEqual(["/rest/api/3/issue/PROJ-20?fields=issuelinks"]);
    expect(blockers).toEqual([
      { key: "PROJ-12", done: false, status: "In Progress" },
      { key: "PROJ-11", done: true, status: "Done" },
      { key: "PROJ-13", done: false, status: "To Do" },
    ]);
  });

  test("an issue without links has no blockers", async () => {
    const client = new JiraTaskTrackerClient("https://jira.example", "me@example.com", "tok");
    client.jiraApiCall = async () => ({ key: "PROJ-1", fields: {} });
    expect(await client.getBlockers("PROJ-1")).toEqual([]);
  });
});

describe("Linear getBlockers", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  test("returns inverse `blocks` relations with their workflow state", async () => {
    const bodies: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _url: string,
      init?: RequestInit,
    ) => {
      bodies.push(String(init?.body));
      return jsonResponse({
        data: {
          issue: {
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: { identifier: "ENG-1", state: { name: "In Progress", type: "started" } },
                },
                {
                  type: "blocks",
                  issue: { identifier: "ENG-2", state: { name: "Done", type: "completed" } },
                },
                {
                  type: "blocks",
                  issue: { identifier: "ENG-3", state: { name: "Canceled", type: "canceled" } },
                },
                {
                  type: "related",
                  issue: { identifier: "ENG-4", state: { name: "Todo", type: "unstarted" } },
                },
              ],
            },
          },
        },
      });
    }) as unknown as typeof fetch);

    const client = new LinearTaskTrackerClient("lin_api_test");
    expect(await client.getBlockers("ENG-9")).toEqual([
      { key: "ENG-1", done: false, status: "In Progress" },
      { key: "ENG-2", done: true, status: "Done" },
      { key: "ENG-3", done: true, status: "Canceled" },
    ]);
    const request = JSON.parse(bodies[0]!) as { query: string; variables: { id: string } };
    expect(request.variables.id).toBe("ENG-9");
    expect(request.query).toContain("inverseRelations");
  });

  test("a missing issue has no blockers", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse({ data: { issue: null } })) as unknown as typeof fetch);
    const client = new LinearTaskTrackerClient("lin_api_test");
    expect(await client.getBlockers("ENG-404")).toEqual([]);
  });
});

describe("GitHub getBlockers", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  test("reads the blocked_by dependencies API", async () => {
    const urls: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      urls.push(url);
      return jsonResponse([
        { number: 12, state: "open", repository_url: "https://api.github.com/repos/acme/webapp" },
        { number: 11, state: "closed", repository_url: "https://api.github.com/repos/acme/webapp" },
        { number: 5, state: "open", repository: { full_name: "acme/api" } },
      ]);
    }) as unknown as typeof fetch);

    const client = new GitHubTaskTrackerClient("tok", "acme", "webapp");
    expect(await client.getBlockers("#20")).toEqual([
      { key: "12", done: false, status: "open" },
      { key: "11", done: true, status: "closed" },
      { key: "acme/api#5", done: false, status: "open" },
    ]);
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/webapp/issues/20/dependencies/blocked_by?per_page=100",
    ]);
  });

  test("an account without the dependencies API reports no blockers", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch);
    const client = new GitHubTaskTrackerClient("tok", "acme", "webapp");
    expect(await client.getBlockers("20")).toEqual([]);
  });

  test("a token that may not read dependencies (403) reports no blockers, warning once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
        jsonResponse(
          { message: "Resource not accessible by personal access token" },
          403,
        )) as unknown as typeof fetch);
      const client = new GitHubTaskTrackerClient("tok", "acme", "webapp");
      expect(await client.getBlockers("20")).toEqual([]);
      expect(await client.getBlockers("21")).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a rate-limited 403 throws (transient, so the ticket waits)", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        })) as unknown as typeof fetch,
    );
    const client = new GitHubTaskTrackerClient("tok", "acme", "webapp");
    await expect(client.getBlockers("20")).rejects.toThrow(/GitHub API error \(403\)/);
  });

  test("other API failures throw", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse({ message: "boom" }, 500)) as unknown as typeof fetch);
    const client = new GitHubTaskTrackerClient("tok", "acme", "webapp");
    await expect(client.getBlockers("20")).rejects.toThrow(/GitHub API error \(500\)/);
  });
});

describe("tracker dependency gate", () => {
  let dir: string;
  let dbPath: string;
  let runs: RunStore;
  let prs: WorkerState;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    dir = uniqueDir("tracker-deps");
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    runs = new RunStore(dbPath);
    prs = new WorkerState(dbPath);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    prs.close();
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Record a finished run (optionally with an open registered PR) for a ticket. */
  function finishRun(
    taskKey: string,
    status: Exclude<RunStatus, "in_progress">,
    pr?: { number: number; repo?: string },
  ): void {
    const repo = pr?.repo ?? "backend";
    const runId = runs.createRun({ origin: "task", taskKey, repo });
    if (pr) {
      const branch = `feature/${taskKey.toLowerCase()}`;
      runs.setRunPr(runId, { repo: "acme/backend", prNumber: pr.number });
      runs.setRunBranch(runId, branch);
      prs.recordAgentPr({ repo: "acme/backend", prNumber: pr.number, branch, taskKey });
    }
    runs.finishRun(runId, status);
  }

  function gate(
    blockers: TaskBlocker[] | (() => Promise<TaskBlocker[]>),
    options: Partial<TrackerDependencyGateOptions> = {},
  ) {
    return createTrackerDependencyGate({
      dbPath,
      tracker: "jira",
      getBlockers: typeof blockers === "function" ? blockers : async () => blockers,
      mode: () => "merged",
      ...options,
    });
  }

  /** What the task subprocess does once its pipeline targets the stack base. */
  function confirmStack(taskKey: string, outcome: TrackerGateOutcome): void {
    const base = outcome.kind === "ready" ? outcome.stackedOn : undefined;
    expect(
      recordConfirmedStackBase(taskKey, base, base?.branch ?? "main", {
        WEBHOOK_QUEUE_DB: dbPath,
      }),
    ).toBe(true);
  }

  function storedStackBase(taskKey: string): string | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT stacked_on FROM tracker_dependencies WHERE task_key = ?")
        .get(taskKey) as { stacked_on: string | null } | null;
      return row?.stacked_on ?? null;
    } finally {
      db.close();
    }
  }

  test("a ticket without blockers is ready", async () => {
    expect(await gate([])("PROJ-20", "backend")).toEqual({ kind: "ready" });
  });

  test("a blocker done in the tracker but unknown locally is satisfied", async () => {
    const outcome = await gate([{ key: "PROJ-12", done: true, status: "Done" }])(
      "PROJ-20",
      "backend",
    );
    expect(outcome).toEqual({ kind: "ready" });
  });

  test("a blocker unknown locally and not done waits, is listed, and clears once done", async () => {
    let done = false;
    const check = gate(async () => [
      { key: "PROJ-12", done, status: done ? "Done" : "In Progress" },
    ]);

    expect(await check("PROJ-20", "backend")).toEqual({
      kind: "waiting",
      reason: "PROJ-12 not done (In Progress)",
    });
    const waits = readTrackerDependencyWaits(dbPath);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      taskKey: "PROJ-20",
      tracker: "jira",
      repo: "backend",
      dependsOn: ["PROJ-12"],
      dependencyMode: "merged",
      state: "waiting",
      reason: "PROJ-12 not done (In Progress)",
    });

    // The queue view (worker queue / dashboard) shows the held-back ticket.
    const queued = collectQueuedWork({
      dbPath,
      queueDbPath: dbPath,
      listInjected: () => [],
      lookupRun: () => null,
      pendingTotal: 0,
    });
    expect(queued.items.map((item) => [item.kind, item.taskKey])).toEqual([["tracker", "PROJ-20"]]);
    expect(queuedDependencyStatus(queued.items[0]!)).toBe(
      "waiting: PROJ-12 not done (In Progress)",
    );
    expect(queued.total).toBe(1);

    // Re-evaluated on the next poll: the reason is logged only when it changes.
    await check("PROJ-20", "backend");
    expect(logSpy.mock.calls.filter(([line]) => String(line).includes("waiting"))).toHaveLength(1);

    done = true;
    expect(await check("PROJ-20", "backend")).toEqual({ kind: "ready" });
    expect(readTrackerDependencyWaits(dbPath)).toEqual([]);
  });

  test("a locally implemented blocker with an open PR: stacked starts on its branch, merged waits", async () => {
    finishRun("PROJ-12", "succeeded", { number: 7 });
    const blockers = [{ key: "PROJ-12", done: false, status: "In Review" }];

    const merged = await gate(blockers)("PROJ-20", "backend");
    expect(merged).toEqual({ kind: "waiting", reason: "PROJ-12 PR #7 not merged" });

    const stacked = await gate(blockers, { mode: () => "stacked" })("PROJ-20", "backend");
    expect(stacked).toMatchObject({
      kind: "ready",
      stackedOn: {
        taskKey: "PROJ-12",
        branch: "feature/proj-12",
        prNumber: 7,
        prUrl: "https://github.com/acme/backend/pull/7",
      },
    });
    // Not recorded by the gate: only the task subprocess knows the run
    // really targets the base (a deferred or overridden run stacks on nothing).
    expect(storedStackBase("PROJ-20")).toBeNull();
    confirmStack("PROJ-20", stacked);
    // Recorded so dependents of PROJ-20 know its PR targets PROJ-12's branch.
    expect(storedStackBase("PROJ-20")).toBe("PROJ-12");
    expect(readTrackerDependencyWaits(dbPath)).toEqual([]);
  });

  test("GitHub issue numbers are scoped to the team: another team's #12 is not this blocker", async () => {
    // Team api handled its own issue 12 (failed once, then opened PR #7).
    // Team web's ticket 30 is blocked by web's issue 12, which nobody handled.
    const apiRun = (status: Exclude<RunStatus, "in_progress">, prNumber?: number): void => {
      const runId = runs.createRun({ origin: "task", taskKey: "12", repo: "api", team: "api" });
      if (prNumber !== undefined) {
        runs.setRunPr(runId, { repo: "acme/api", prNumber });
        prs.recordAgentPr({ repo: "acme/api", prNumber, branch: "feature/12", taskKey: "12" });
      }
      runs.finishRun(runId, status);
    };
    const github = (team: string) =>
      gate([{ key: "12", done: false, status: "open" }], { tracker: "github", team });

    apiRun("failed");
    expect(await github("web")("30", "web")).toEqual({
      kind: "waiting",
      reason: "12 not done (open)",
    });
    // The team that owns that run still judges its blocker by it.
    expect(await github("api")("31", "api")).toEqual({ kind: "blocked", reason: "12 failed" });

    apiRun("succeeded", 7);
    const resolveMergeState = async () => ({ state: "merged" as const });
    expect(
      await gate([{ key: "12", done: false, status: "open" }], {
        tracker: "github",
        team: "web",
        resolveMergeState,
      })("30", "web"),
    ).toEqual({ kind: "waiting", reason: "12 not done (open)" });
    expect(await github("api")("31", "api")).toEqual({
      kind: "waiting",
      reason: "12 PR #7 not merged",
    });

    // Jira keys are workspace-wide: another team's run still counts.
    const jiraRun = runs.createRun({ origin: "task", taskKey: "API-12", repo: "api", team: "api" });
    runs.finishRun(jiraRun, "failed");
    expect(await gate([{ key: "API-12", done: false }], { team: "web" })("WEB-30", "web")).toEqual({
      kind: "blocked",
      reason: "API-12 failed",
    });
  });

  test("a stacked ticket's base flows to its own dependents", async () => {
    // PROJ-20 was stacked on PROJ-12 and its PR merged into PROJ-12's branch,
    // while PROJ-12 is still open: PROJ-30 (blocked by PROJ-20) waits on PROJ-12.
    finishRun("PROJ-12", "succeeded", { number: 7 });
    const stacked = await gate([{ key: "PROJ-12" }], { mode: () => "stacked" })(
      "PROJ-20",
      "backend",
    );
    expect(stacked).toMatchObject({ kind: "ready" });
    confirmStack("PROJ-20", stacked);
    finishRun("PROJ-20", "succeeded", { number: 8 });
    prs.markAgentPrClosed("acme/backend", 8, "merged", { mergedInto: "feature/proj-12" });

    const outcome = await gate([{ key: "PROJ-20", done: false }])("PROJ-30", "backend");
    expect(outcome).toEqual({ kind: "waiting", reason: "PROJ-12 PR #7 not merged" });
  });

  test("re-gating a stacked ticket without a stack keeps its base for dependents", async () => {
    finishRun("PROJ-12", "succeeded", { number: 7 });
    const stacked = await gate([{ key: "PROJ-12" }], { mode: () => "stacked" })(
      "PROJ-20",
      "backend",
    );
    confirmStack("PROJ-20", stacked);
    finishRun("PROJ-20", "succeeded", { number: 8 });

    // PROJ-20 is picked up again after its blocker link was removed, and again
    // with the blocker done in the tracker: both verdicts are unstacked.
    expect(await gate([])("PROJ-20", "backend")).toEqual({ kind: "ready" });
    expect(
      await gate([{ key: "PROJ-12", done: true }], { mode: () => "stacked" })("PROJ-20", "backend"),
    ).toMatchObject({ kind: "ready" });
    expect(storedStackBase("PROJ-20")).toBe("PROJ-12");

    // PR #8 still targeted PROJ-12's branch, so PROJ-30 keeps waiting on PROJ-12.
    prs.markAgentPrClosed("acme/backend", 8, "merged", { mergedInto: "feature/proj-12" });
    const outcome = await gate([{ key: "PROJ-20", done: false }])("PROJ-30", "backend");
    expect(outcome).toEqual({ kind: "waiting", reason: "PROJ-12 PR #7 not merged" });
  });

  test("a merged blocker PR satisfies merged mode", async () => {
    finishRun("PROJ-12", "succeeded", { number: 7 });
    prs.markAgentPrClosed("acme/backend", 7, "merged");
    expect(await gate([{ key: "PROJ-12", done: false }])("PROJ-20", "backend")).toEqual({
      kind: "ready",
    });
  });

  test("the code host's merge answer unblocks a ticket waiting on a stale open PR", async () => {
    finishRun("PROJ-12", "succeeded", { number: 7 });
    const lookups: Array<{ repo: string; taskKey: string; number: number }> = [];
    const check = gate([{ key: "PROJ-12", done: false }], {
      resolveMergeState: async (lookup) => {
        lookups.push({ repo: lookup.repo, taskKey: lookup.taskKey, number: lookup.pr.number });
        return { state: "merged" };
      },
    });
    expect(await check("PROJ-20", "backend")).toEqual({ kind: "ready" });
    expect(lookups).toEqual([{ repo: "backend", taskKey: "PROJ-12", number: 7 }]);
  });

  test("a failed blocker blocks until the tracker reports it done", async () => {
    finishRun("PROJ-12", "failed");
    let done = false;
    const check = gate(async () => [{ key: "PROJ-12", done }]);
    expect(await check("PROJ-20", "backend")).toEqual({
      kind: "blocked",
      reason: "PROJ-12 failed",
    });
    expect(readTrackerDependencyWaits(dbPath)[0]).toMatchObject({ state: "blocked" });

    // Resolved by hand in the tracker: the worker's failed attempt no longer blocks.
    done = true;
    expect(await check("PROJ-20", "backend")).toEqual({ kind: "ready" });
  });

  test("a blocker still running locally waits", async () => {
    runs.createRun({ origin: "task", taskKey: "PROJ-12", repo: "backend" });
    expect(await gate([{ key: "PROJ-12", done: false }])("PROJ-20", "backend")).toEqual({
      kind: "waiting",
      reason: "PROJ-12 running",
    });
  });

  test("a stack base in another repo cannot be stacked on", async () => {
    finishRun("PROJ-12", "succeeded", { number: 7, repo: "frontend" });
    const outcome = await gate([{ key: "PROJ-12" }], { mode: () => "stacked" })(
      "PROJ-20",
      "backend",
    );
    expect(outcome).toEqual({
      kind: "waiting",
      reason:
        "PROJ-12 PR #7 not merged (it is in repo frontend, not backend, so it cannot be stacked on)",
    });
  });

  test("a cross-repo stack base asks the code host whether its PR merged", async () => {
    // The registry still says PR #7 is open (no webhook saw the merge).
    finishRun("PROJ-12", "succeeded", { number: 7, repo: "frontend" });
    const asked: Array<{ repo: string; taskKey: string }> = [];
    const outcome = await gate([{ key: "PROJ-12" }], {
      mode: () => "stacked",
      resolveMergeState: async ({ repo, taskKey }) => {
        asked.push({ repo, taskKey });
        return { state: "merged" as const, mergedIntoDefault: true };
      },
    })("PROJ-20", "backend");
    expect(asked).toEqual([{ repo: "frontend", taskKey: "PROJ-12" }]);
    expect(outcome).toEqual({ kind: "ready" });
    expect(readTrackerDependencyWaits(dbPath)).toEqual([]);
  });

  test("a stack base is recorded only when the run really targets it", () => {
    const base: StackBase = { taskKey: "PROJ-12", branch: "feature/proj-12", prNumber: 7 };
    const env = { WEBHOOK_QUEUE_DB: dbPath };
    const store = new TrackerDependencyStore(dbPath);
    try {
      store.record(
        {
          taskKey: "PROJ-20",
          tracker: "jira",
          dependsOn: ["PROJ-12"],
          dependencyMode: "stacked",
          state: null,
          reason: null,
        },
        Date.now(),
      );
    } finally {
      store.close();
    }
    // The base branch is missing on the remote: the target fell back to main.
    expect(recordConfirmedStackBase("PROJ-20", base, "main", env)).toBe(false);
    // An explicit `Target branch:` removed the env marker: no base at all.
    expect(recordConfirmedStackBase("PROJ-20", undefined, "develop", env)).toBe(false);
    expect(storedStackBase("PROJ-20")).toBeNull();
    // The run targets the base's branch.
    expect(recordConfirmedStackBase("PROJ-20", base, "feature/proj-12", env)).toBe(true);
    expect(storedStackBase("PROJ-20")).toBe("PROJ-12");
  });

  test("a tracker read failure holds the ticket back instead of running it out of order", async () => {
    const outcome = await gate(async () => {
      throw new Error("503 Service Unavailable");
    })("PROJ-20", "backend");
    expect(outcome.kind).toBe("waiting");
    expect((outcome as { reason: string }).reason).toContain("503 Service Unavailable");
  });

  test("a state DB failure holds the ticket back instead of rejecting", async () => {
    // Unopenable DB: the store constructor itself throws.
    const unopenable = createTrackerDependencyGate({
      dbPath: dir, // a directory, not a database file
      tracker: "jira",
      getBlockers: async () => [{ key: "PROJ-12", done: true }],
      mode: () => "merged",
    });
    const first = await unopenable("PROJ-20", "backend");
    expect(first.kind).toBe("waiting");
    expect((first as { reason: string }).reason).toContain("could not evaluate PROJ-20's blockers");

    // A write failing on an open connection (table gone under it).
    const check = gate([{ key: "PROJ-12", done: true }]);
    expect(await check("PROJ-20", "backend")).toEqual({ kind: "ready" });
    const db = new Database(dbPath);
    db.run("DROP TABLE tracker_dependencies");
    db.close();
    const failed = await check("PROJ-21", "backend");
    expect(failed.kind).toBe("waiting");
    expect((failed as { reason: string }).reason).toContain("tracker_dependencies");
    // The broken connection is dropped: the next evaluation reopens (and
    // re-creates the schema) instead of failing forever.
    expect(await check("PROJ-21", "backend")).toEqual({ kind: "ready" });
  });

  test("waits of tickets the poll no longer returns are cleared", async () => {
    await gate([{ key: "PROJ-12", done: false }], { team: "platform" })("PROJ-20", "backend");
    await gate([{ key: "PROJ-12", done: false }], { team: "growth" })("PROJ-21", "backend");
    const store = new TrackerDependencyStore(dbPath);
    try {
      store.clearWaitsExcept("platform", new Set(["PROJ-99"]));
      expect(store.listWaiting().map((wait) => wait.taskKey)).toEqual(["PROJ-21"]);
    } finally {
      store.close();
    }
  });
});

describe("gated fleet executor", () => {
  let dir: string;
  let skips: RoutingSkipStore;
  const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`);

  beforeEach(() => {
    dir = uniqueDir("gated-executor");
    mkdirSync(dir, { recursive: true });
    skips = new RoutingSkipStore(join(dir, "queue.db"));
  });

  afterEach(() => {
    skips.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const repoManager: RepoManagerLike = {
    ensureBareClone: async () => "",
    fetch: async () => {},
    ensureBaseWorktree: async () => "",
    createTaskWorktree: async (_repo, taskKey) => {
      const path = join(dir, "worktrees", taskKey);
      mkdirSync(path, { recursive: true });
      return path;
    },
    removeTaskWorktree: async () => {},
    sweepStaleWorktrees: async () => [],
    ensurePrJobWorktree: async () => "",
  };

  function executor(outcome: TrackerGateOutcome, ran: Array<Record<string, string | undefined>>) {
    const gated: string[] = [];
    const execute = createGatedFleetTaskExecutor(
      {
        config,
        workspaceDir: dir,
        skips,
        repoManager,
        isHarnessExhausted: () => false,
        runTask: async (_taskKey, _args, opts) => {
          ran.push(opts.env);
          return true;
        },
      },
      {
        dependencyGate: async (taskKey, repo) => {
          gated.push(`${taskKey}@${repo}`);
          return outcome;
        },
      },
    );
    return { execute, gated };
  }

  test("a held-back ticket reports waiting and never starts", async () => {
    const ran: Array<Record<string, string | undefined>> = [];
    const { execute, gated } = executor({ kind: "waiting", reason: "PROJ-12 not done" }, ran);
    expect(await execute("PROJ-20", { key: "PROJ-20", labels: [], components: [] })).toBe(
      "waiting",
    );
    expect(gated).toEqual(["PROJ-20@backend"]);
    expect(ran).toEqual([]);
  });

  test("a relayed task change goes through the same gate", async () => {
    const ran: Array<Record<string, string | undefined>> = [];
    const { execute, gated } = executor({ kind: "waiting", reason: "PROJ-12 not done" }, ran);
    const evaluate = createFleetTaskEvaluator({
      query: "project = PROJ",
      searchTasks: async () => ({ tasks: [{ key: "PROJ-20", updated: "u1" }] }),
      execute,
    });
    expect(await evaluate("PROJ-20")).toBe(true);
    expect(gated).toEqual(["PROJ-20@backend"]);
    expect(ran).toEqual([]);
  });

  test("a stacked verdict hands the base to the task subprocess", async () => {
    const ran: Array<Record<string, string | undefined>> = [];
    const base: StackBase = { taskKey: "PROJ-12", branch: "feature/proj-12", prNumber: 7 };
    const { execute } = executor({ kind: "ready", stackedOn: base }, ran);
    expect(await execute("PROJ-20", { key: "PROJ-20", labels: [], components: [] })).toBe(true);
    expect(stackBaseFromEnv(ran[0])).toEqual({ ...base, prUrl: undefined });

    const plain = executor({ kind: "ready" }, ran);
    await plain.execute("PROJ-21", { key: "PROJ-21", labels: [], components: [] });
    expect(ran[1]?.[STACKED_ON_ENV]).toBeUndefined();
  });
});

describe("dashboard retry of a gated ticket", () => {
  let dir: string;
  let skips: RoutingSkipStore;
  let retries: ScheduledRetryStore;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
  const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`);

  beforeEach(() => {
    dir = uniqueDir("gated-retry");
    mkdirSync(dir, { recursive: true });
    skips = new RoutingSkipStore(join(dir, "queue.db"));
    retries = new ScheduledRetryStore(join(dir, "queue.db"));
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    retries.close();
    skips.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs through the source's gate: a held ticket is settled, a stacked one keeps its base", async () => {
    const base: StackBase = { taskKey: "PROJ-12", branch: "feature/proj-12", prNumber: 7 };
    const verdicts: Record<string, TrackerGateOutcome> = {
      "PROJ-20": { kind: "waiting", reason: "PROJ-12 not done (In Progress)" },
      "PROJ-21": { kind: "ready", stackedOn: base },
    };
    const gatedTeams: Array<string | undefined> = [];
    const ran: Array<{ taskKey: string; env: Record<string, string | undefined> }> = [];
    retries.schedule({ taskKey: "PROJ-20", repo: "backend", actor: "a@x.com" });
    retries.schedule({ taskKey: "PROJ-21", repo: "backend", actor: "a@x.com" });
    const acquirer = buildRetryQueueAcquirer(
      {
        config,
        workspaceDir: dir,
        skips,
        repoManager: {
          ensureBareClone: async () => "",
          fetch: async () => {},
          ensureBaseWorktree: async () => "",
          createTaskWorktree: async (_repo, taskKey) => {
            const path = join(dir, "worktrees", taskKey);
            mkdirSync(path, { recursive: true });
            return path;
          },
          removeTaskWorktree: async () => {},
          sweepStaleWorktrees: async () => [],
          ensurePrJobWorktree: async () => "",
        },
        isHarnessExhausted: () => false,
        runTask: async (taskKey, _args, opts) => {
          ran.push({ taskKey, env: opts.env });
          return true;
        },
      },
      retries,
      false,
      (team) => {
        gatedTeams.push(team);
        return async (taskKey) => verdicts[taskKey]!;
      },
    );

    await acquirer.tick();

    // The held ticket never started and did not stall the drain.
    expect(ran.map((run) => run.taskKey)).toEqual(["PROJ-21"]);
    expect(stackBaseFromEnv(ran[0]!.env)).toEqual({ ...base, prUrl: undefined });
    expect(gatedTeams).toEqual([undefined, undefined]);
    const db = new Database(join(dir, "queue.db"), { readonly: true });
    try {
      const rows = db
        .query("SELECT task_key, status, message FROM scheduled_retries ORDER BY id")
        .all() as Array<{ task_key: string; status: string; message: string | null }>;
      expect(rows[0]).toMatchObject({ task_key: "PROJ-20", status: "failed" });
      expect(rows[0]!.message).toContain("PROJ-12 not done (In Progress)");
      expect(rows[1]).toMatchObject({ task_key: "PROJ-21", status: "done", message: null });
    } finally {
      db.close();
    }
  });
});

describe("polling a ticket the gate holds back", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    dbPath = join(tmpdir(), `gate-poll-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  test("re-evaluates it on the next poll without rolling the cursor back", async () => {
    const outcomes: TaskPollOutcome[] = ["waiting", "waiting", true];
    let clock = 1_000_000;
    const executed: string[] = [];
    const cursors: Array<string | null> = [];
    const tasks: ReadyTask[] = [{ key: "PROJ-20", updated: "u1" }];
    let detections = 0;
    const acquirer = new TaskPollingAcquirer({
      trackerType: "jira",
      query: "project = PROJ",
      intervalSeconds: 60,
      detector: {
        source: "jira",
        async changesSince(cursor) {
          cursors.push(cursor);
          detections++;
          // Only the first tick sees a tracker change; later ticks re-admit
          // the held-back ticket through its pending re-scan.
          return { changed: detections === 1, nextCursor: String(detections) };
        },
      },
      workerState,
      queue,
      searchTasks: async () => ({ tasks }),
      executeTask: async (key) => {
        executed.push(key);
        return outcomes.shift() ?? true;
      },
      now: () => clock,
    });

    await acquirer.tick();
    await acquirer.tick();
    // Second wait in a row: the next re-check is one interval away.
    await acquirer.tick();
    expect(executed).toEqual(["PROJ-20", "PROJ-20"]);
    clock += 60_000;
    await acquirer.tick();
    await acquirer.tick();
    expect(executed).toEqual(["PROJ-20", "PROJ-20", "PROJ-20"]);
    // The cursor advanced every tick (no deferral-style rollback).
    expect(cursors).toEqual([null, "1", "2", "3", "4"]);
  });

  test("backs off re-checks without searching, and a ticket edit re-checks at once", async () => {
    let clock = 1_000_000;
    let searches = 0;
    let changed = true;
    let tasks: ReadyTask[] = [{ key: "PROJ-20", updated: "u1" }];
    const executed: string[] = [];
    const acquirer = new TaskPollingAcquirer({
      trackerType: "jira",
      query: "project = PROJ",
      intervalSeconds: 60,
      detector: {
        source: "jira",
        async changesSince() {
          const result = { changed, nextCursor: String(clock) };
          changed = false;
          return result;
        },
      },
      workerState,
      queue,
      searchTasks: async () => {
        searches++;
        return { tasks };
      },
      executeTask: async (key) => {
        executed.push(key);
        return "waiting";
      },
      now: () => clock,
    });

    await acquirer.tick(); // first pickup: waits
    await acquirer.tick(); // re-checked on the next poll: waits again
    expect(executed.length).toBe(2);
    // Backed off: idle ticks within the interval neither search nor re-gate.
    for (let i = 0; i < 5; i++) await acquirer.tick();
    expect(searches).toBe(2);
    expect(executed.length).toBe(2);
    clock += 60_000;
    await acquirer.tick(); // due: third wait, next gap two intervals
    expect(executed.length).toBe(3);
    clock += 60_000;
    await acquirer.tick();
    expect(executed.length).toBe(3);
    clock += 60_000;
    await acquirer.tick();
    expect(executed.length).toBe(4);
    expect(waitingRecheckDelayMs(100, 60)).toBe(WAITING_RECHECK_MAX_MS);

    // Editing the ticket (new stamp) re-checks it on the change tick.
    tasks = [{ key: "PROJ-20", updated: "u2" }];
    changed = true;
    await acquirer.tick();
    expect(executed.length).toBe(5);
  });
});

describe("stacked base for tracker tickets", () => {
  const base: StackBase = {
    taskKey: "PROJ-12",
    branch: "feature/proj-12",
    prNumber: 7,
    prUrl: "https://github.com/acme/backend/pull/7",
  };

  test("round-trips through the env and reaches the PR body", () => {
    const env = { [STACKED_ON_ENV]: encodeStackBaseEnv(base) };
    expect(takeStackBaseFromEnv("Plain ticket body", undefined, env)).toEqual(base);
    expect(env[STACKED_ON_ENV]).toBeDefined();

    const previous = process.env[STACKED_ON_ENV];
    process.env[STACKED_ON_ENV] = env[STACKED_ON_ENV];
    try {
      const stackedOn = stackedOnFromDescription({ type: "doc" });
      expect(stackedOn).toEqual(base);
      expect(buildPrBody({ taskKey: "PROJ-20", taskSummary: "x", stackedOn })).toContain(
        "Stacked on",
      );
    } finally {
      if (previous === undefined) delete process.env[STACKED_ON_ENV];
      else process.env[STACKED_ON_ENV] = previous;
    }
  });

  test("an explicit Target branch in the ticket wins and drops the env base", () => {
    const env: Record<string, string | undefined> = { [STACKED_ON_ENV]: encodeStackBaseEnv(base) };
    const warnings: string[] = [];
    expect(
      takeStackBaseFromEnv("Target branch: release", (message) => warnings.push(message), env),
    ).toBeUndefined();
    expect(env[STACKED_ON_ENV]).toBeUndefined();
    expect(warnings[0]).toContain("Target branch: release");
  });

  /** Mirror prepareTask + processSingleTask once the target branch is resolved. */
  function runStackedTicket(effectiveTargetBranch: string): {
    recorded: boolean;
    dropped: boolean;
    prBody: string;
    prompt: string;
    envSet: boolean;
  } {
    const previous = process.env[STACKED_ON_ENV];
    process.env[STACKED_ON_ENV] = encodeStackBaseEnv(base);
    try {
      const stackedOn = takeStackBaseFromEnv("Plain ticket body");
      const taskDetails = {
        key: "PROJ-20",
        summary: "x",
        issueType: "Story",
        status: "To Do",
        labels: [],
        components: [],
        fixVersions: [],
        description: "Plain ticket body",
        linkedResources: [],
        relatedIssues: [],
        comments: [],
        attachments: [],
        stackedOnSection: stackedOn ? renderStackedOnSection(stackedOn) : undefined,
      } as unknown as FormattedTaskDetails;
      const stackBase = stackBaseFromEnv();
      const recorded = recordConfirmedStackBase("PROJ-20", stackBase, effectiveTargetBranch, {
        WEBHOOK_QUEUE_DB: join(uniqueDir("stack-fallback"), "queue.db"),
      });
      const dropped = dropUnusedStackBase(stackBase, effectiveTargetBranch, taskDetails);
      return {
        recorded,
        dropped,
        envSet: process.env[STACKED_ON_ENV] !== undefined,
        prBody: buildPrBody({
          taskKey: "PROJ-20",
          taskSummary: "x",
          stackedOn: stackedOnFromDescription({ type: "doc" }),
        }),
        prompt: TaskFormatter.formatTaskForAgent(taskDetails),
      };
    } finally {
      if (previous === undefined) delete process.env[STACKED_ON_ENV];
      else process.env[STACKED_ON_ENV] = previous;
    }
  }

  test("a base branch missing on the remote drops the stack from the PR body and prompt", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = runStackedTicket("main");
      expect(run.recorded).toBe(false);
      expect(run.dropped).toBe(true);
      expect(run.envSet).toBe(false);
      expect(run.prBody).not.toContain("Stacked on");
      expect(run.prompt).not.toContain(base.branch);
      expect(warn.mock.calls.some(([message]) => String(message).includes("Not stacking"))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("a run that targets the base branch keeps the stack in the PR body and prompt", () => {
    const run = runStackedTicket(base.branch);
    expect(run.dropped).toBe(false);
    expect(run.envSet).toBe(true);
    expect(run.prBody).toContain("Stacked on");
    expect(run.prompt).toContain(base.branch);
  });
});

describe("[[teams]].dependency_mode", () => {
  test("parses a per-team override and rejects unknown values", () => {
    const ok = parseWorkspaceConfig(`
[defaults]
tracker = "jira"
dependency_mode = "merged"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[teams]]
name = "platform"
task_query = "project = PLAT"
repo = "backend"
dependency_mode = "stacked"

[[teams]]
name = "growth"
task_query = "project = GROW"
repo = "backend"
`);
    expect(ok.teams.map((team) => team.dependencyMode)).toEqual(["stacked", undefined]);

    const bad = () =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[teams]]
name = "platform"
task_query = "project = PLAT"
repo = "backend"
dependency_mode = "eventually"
`);
    expect(bad).toThrow(/\[\[teams\]\]\[0\]\.dependency_mode must be one of: merged, stacked/);
  });
});
