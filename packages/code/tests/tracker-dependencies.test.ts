import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { TaskPollingAcquirer } from "../src/lib/acquirers/task-polling";
import type { ReadyTask, TaskPollOutcome } from "../src/lib/acquirers/task-polling";
import { buildPrBody, stackedOnFromDescription } from "../src/lib/code-host/pr-body";
import {
  encodeStackBaseEnv,
  STACKED_ON_ENV,
  stackBaseFromEnv,
  takeStackBaseFromEnv,
} from "../src/lib/dependencies/stacked-base";
import type { StackBase } from "../src/lib/dependencies/gate";
import { collectQueuedWork, queuedDependencyStatus } from "../src/lib/observability/queued-work";
import { RunStore } from "../src/lib/state/run-recorder";
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
    expect(stacked).toEqual({
      kind: "ready",
      stackedOn: {
        taskKey: "PROJ-12",
        branch: "feature/proj-12",
        prNumber: 7,
        prUrl: "https://github.com/acme/backend/pull/7",
      },
    });
    // Recorded so dependents of PROJ-20 know its PR targets PROJ-12's branch.
    expect(storedStackBase("PROJ-20")).toBe("PROJ-12");
    expect(readTrackerDependencyWaits(dbPath)).toEqual([]);
  });

  test("a stacked ticket's base flows to its own dependents", async () => {
    // PROJ-20 was stacked on PROJ-12 and its PR merged into PROJ-12's branch,
    // while PROJ-12 is still open: PROJ-30 (blocked by PROJ-20) waits on PROJ-12.
    finishRun("PROJ-12", "succeeded", { number: 7 });
    expect(
      await gate([{ key: "PROJ-12" }], { mode: () => "stacked" })("PROJ-20", "backend"),
    ).toMatchObject({ kind: "ready" });
    finishRun("PROJ-20", "succeeded", { number: 8 });
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

  test("a tracker read failure holds the ticket back instead of running it out of order", async () => {
    const outcome = await gate(async () => {
      throw new Error("503 Service Unavailable");
    })("PROJ-20", "backend");
    expect(outcome.kind).toBe("waiting");
    expect((outcome as { reason: string }).reason).toContain("503 Service Unavailable");
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
    });

    await acquirer.tick();
    await acquirer.tick();
    await acquirer.tick();
    await acquirer.tick();
    expect(executed).toEqual(["PROJ-20", "PROJ-20", "PROJ-20"]);
    // The cursor advanced every tick (no deferral-style rollback).
    expect(cursors).toEqual([null, "1", "2", "3"]);
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
