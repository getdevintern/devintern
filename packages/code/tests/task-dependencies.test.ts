import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { runContext } from "../src/lib/cli/context";
import {
  evaluateDependencyGate,
  findDependencyCycle,
  resolveDependencyMode,
} from "../src/lib/dependencies/gate";
import type { DependencyFacts } from "../src/lib/dependencies/gate";
import { readLocalDependencyFacts } from "../src/lib/dependencies/local-facts";
import { applyStackBase, parseStackedOnMarker } from "../src/lib/dependencies/stacked-base";
import { buildPrBody } from "../src/lib/code-host/pr-body";
import { applyAgentPrFetch, mergeDetailsFromPr } from "../src/lib/review/agent-pr-reconciler";
import { collectQueuedWork, queuedDependencyStatus } from "../src/lib/observability/queued-work";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunStatus } from "../src/lib/state/run-recorder";
import { WorkerState } from "../src/lib/state/worker-state";
import { resolveEffectiveTargetBranch } from "../src/lib/task/pipeline";
import { extractDependsOn, extractTargetBranch } from "../src/lib/utils/general";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import {
  InjectedTaskAcquirer,
  MAX_INJECTED_DEFERRALS,
  MERGE_STATE_LOOKUP_COOLDOWN_MS,
} from "../src/lib/workspace/injected-acquirer";
import {
  enqueueInjectedTask,
  InjectedTaskDependencyError,
} from "../src/lib/workspace/injected-enqueue";
import { parseWorkerAddArgs, runWorkerAdd } from "../src/lib/workspace/add-command";
import { workspaceDbPath } from "../src/lib/workspace/paths";
import { resetWorkerFailover } from "../src/lib/worker/failover";
import type { InjectedTask } from "../src/lib/state/injected-tasks";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

const SLUG = "acme/backend";

describe("Depends on: extractor", () => {
  // Same markdown variants `extractTargetBranch` accepts.
  const cases: Array<[string, string[]]> = [
    ["Depends on: local-a", ["local-a"]],
    ["depends on: local-a", ["local-a"]],
    ["DEPENDS ON: local-a", ["local-a"]],
    ["Depends on: local-a, local-b", ["local-a", "local-b"]],
    ["Depends on: local-a local-b and PROJ-12", ["local-a", "local-b", "PROJ-12"]],
    ["**Depends on**: local-a", ["local-a"]],
    ["**Depends on: local-a**", ["local-a"]],
    ["Depends on: **local-a**", ["local-a"]],
    ["*Depends on*: local-a", ["local-a"]],
    ["_Depends on_: local-a", ["local-a"]],
    ["***Depends on***: local-a", ["local-a"]],
    ["## Depends on: local-a", ["local-a"]],
    ["###### Depends on: local-a", ["local-a"]],
    ["- **Depends on**: `local-a`", ["local-a"]],
    ["| Depends on: | local-a, local-b |", ["local-a", "local-b"]],
    ["Depends on:   local-a  ", ["local-a"]],
    ["Depends on: local-a — needs its API", ["local-a"]],
    ["Intro\n\nDepends on: local-a\n\nDepends on: local-b, local-a", ["local-a", "local-b"]],
  ];
  for (const [description, expected] of cases) {
    test(`parses ${JSON.stringify(description)}`, () => {
      expect(extractDependsOn(description)).toEqual(expected);
    });
  }

  test("ignores prose and missing values", () => {
    expect(extractDependsOn(undefined)).toEqual([]);
    expect(extractDependsOn("")).toEqual([]);
    expect(extractDependsOn("This change depends on: nothing in particular")).toEqual([]);
    expect(extractDependsOn("Depends on:")).toEqual([]);
    expect(extractDependsOn("Target branch: develop")).toEqual([]);
  });

  test("keeps only key-shaped tokens on a line that starts with the label", () => {
    expect(extractDependsOn("Depends on: the orders API being deployed first")).toEqual([]);
    expect(extractDependsOn("- Depends on: PROJ-12 landing")).toEqual(["PROJ-12"]);
    expect(extractDependsOn("Depends on: local-a once it ships")).toEqual(["local-a"]);
  });
});

describe("dependency_mode config", () => {
  const base = (extra: string) => `
[defaults]
tracker = "jira"
task_query = "labels = devintern"
${extra}

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`;

  test("defaults to merged", () => {
    expect(parseWorkspaceConfig(base("")).defaults.dependencyMode).toBe("merged");
  });

  test("accepts merged and stacked", () => {
    expect(parseWorkspaceConfig(base('dependency_mode = "stacked"')).defaults.dependencyMode).toBe(
      "stacked",
    );
    expect(parseWorkspaceConfig(base('dependency_mode = "merged"')).defaults.dependencyMode).toBe(
      "merged",
    );
  });

  test("rejects unknown and non-string values", () => {
    expect(() => parseWorkspaceConfig(base('dependency_mode = "rebase"'))).toThrow(
      /\[defaults\]\.dependency_mode must be one of: merged, stacked/,
    );
    expect(() => parseWorkspaceConfig(base("dependency_mode = 3"))).toThrow(
      /\[defaults\]\.dependency_mode must be a non-empty string/,
    );
  });

  test("per-task override wins over the configured default", () => {
    expect(resolveDependencyMode({})).toBe("merged");
    expect(resolveDependencyMode({ configured: "stacked" })).toBe("stacked");
    expect(resolveDependencyMode({ override: "merged", configured: "stacked" })).toBe("merged");
  });
});

describe("dependency gate", () => {
  const succeededWithPr = (
    key: string,
    state: "open" | "merged" | "closed" | "closed-unknown",
    number = 12,
  ): DependencyFacts => ({
    key,
    work: "done",
    latestRun: { status: "succeeded", prNumber: number, branch: `feature/${key}` },
    pr: { number, branch: `feature/${key}`, state },
  });

  test("merged mode waits for an open PR and is ready once it merged", () => {
    const waiting = evaluateDependencyGate("merged", [succeededWithPr("local-a", "open")]);
    expect(waiting).toMatchObject({ kind: "waiting", reason: "local-a PR #12 not merged" });
    expect(evaluateDependencyGate("merged", [succeededWithPr("local-a", "merged")]).kind).toBe(
      "ready",
    );
  });

  test("a dependency that succeeded without a PR is satisfied", () => {
    const facts: DependencyFacts = {
      key: "local-a",
      work: "done",
      latestRun: { status: "succeeded" },
    };
    expect(evaluateDependencyGate("merged", [facts]).kind).toBe("ready");
    expect(evaluateDependencyGate("stacked", [facts]).kind).toBe("ready");
  });

  test("a dependency that pushed but failed to open its PR blocks in both modes", () => {
    const facts: DependencyFacts = {
      key: "local-a",
      work: "done",
      latestRun: { status: "succeeded", branch: "feature/local-a", prFailure: "HTTP 422" },
    };
    for (const mode of ["merged", "stacked"] as const) {
      expect(evaluateDependencyGate(mode, [facts])).toMatchObject({
        kind: "blocked",
        reason: "local-a pushed but PR creation failed",
      });
    }
  });

  test("failed, escalated, abandoned, and closed-unmerged dependencies block", () => {
    for (const status of ["failed", "escalated", "abandoned"] as RunStatus[]) {
      expect(
        evaluateDependencyGate("merged", [{ key: "local-a", work: "done", latestRun: { status } }]),
      ).toMatchObject({ kind: "blocked", reason: `local-a ${status}` });
    }
    expect(evaluateDependencyGate("stacked", [{ key: "local-a", work: "failed" }])).toMatchObject({
      kind: "blocked",
      reason: "local-a failed",
    });
    expect(evaluateDependencyGate("merged", [succeededWithPr("local-a", "closed")])).toMatchObject({
      kind: "blocked",
      reason: "local-a PR #12 closed without merging",
    });
  });

  test("unknown merge state waits and asks for a lookup", () => {
    const decision = evaluateDependencyGate("merged", [
      succeededWithPr("local-a", "closed-unknown"),
    ]);
    expect(decision.kind).toBe("waiting");
    if (decision.kind !== "waiting") throw new Error("unreachable");
    expect(decision.mergeStateLookups.map((entry) => entry.pr.number)).toEqual([12]);
  });

  test("merged mode also asks about an open PR it waits on", () => {
    const decision = evaluateDependencyGate("merged", [succeededWithPr("local-a", "open")]);
    if (decision.kind !== "waiting") throw new Error("expected waiting");
    expect(decision.mergeStateLookups.map((entry) => entry.pr.number)).toEqual([12]);
  });

  test("stacked mode stacks on exactly one unmerged dependency", () => {
    const decision = evaluateDependencyGate("stacked", [
      succeededWithPr("local-a", "open", 12),
      succeededWithPr("local-b", "merged", 13),
    ]);
    expect(decision).toMatchObject({
      kind: "ready",
      stackedOn: { taskKey: "local-a", branch: "feature/local-a", prNumber: 12 },
    });
  });

  test("stacked mode waits while two or more dependencies are unmerged", () => {
    const decision = evaluateDependencyGate("stacked", [
      succeededWithPr("local-a", "open", 12),
      succeededWithPr("local-b", "open", 13),
    ]);
    expect(decision.kind).toBe("waiting");
    if (decision.kind !== "waiting") throw new Error("unreachable");
    expect(decision.reason).toContain("2 dependencies unmerged");
    expect(decision.reason).toContain("at most one remains unmerged");

    const oneLeft = evaluateDependencyGate("stacked", [
      succeededWithPr("local-a", "open", 12),
      succeededWithPr("local-b", "merged", 13),
    ]);
    expect(oneLeft.kind).toBe("ready");
  });

  test("stacked mode with every dependency merged behaves like merged mode", () => {
    const decision = evaluateDependencyGate("stacked", [succeededWithPr("local-a", "merged")]);
    expect(decision).toEqual({ kind: "ready", statuses: expect.any(Array) });
  });

  test("stacked mode waits while a dependency is still running", () => {
    expect(evaluateDependencyGate("stacked", [{ key: "local-a", work: "running" }])).toMatchObject({
      kind: "waiting",
      reason: "local-a running",
    });
  });

  describe("a merged dependency stacked on a merged base", () => {
    const T0 = Date.parse("2026-11-17T10:00:00Z");
    const base = (mergedAt?: number): DependencyFacts => ({
      ...succeededWithPr("local-b", "merged", 2),
      pr: { number: 2, branch: "feature/local-b", state: "merged", mergedAt, mergedInto: "main" },
    });
    const stacked = (
      merge: { mergedAt?: number; mergedInto?: string; mergedIntoDefault?: boolean },
      stackBase: DependencyFacts,
    ): DependencyFacts => ({
      ...succeededWithPr("local-a", "merged", 1),
      pr: { number: 1, branch: "feature/local-a", state: "merged", ...merge },
      stackBase,
    });

    test("merged into the base's branch before the base merged is satisfied", () => {
      const facts = stacked({ mergedAt: T0, mergedInto: "feature/local-b" }, base(T0 + 60_000));
      for (const mode of ["merged", "stacked"] as const) {
        expect(evaluateDependencyGate(mode, [facts]).kind).toBe("ready");
      }
    });

    test("merged into the base's branch after the base merged blocks", () => {
      // B merged into main; A's PR still targeted feature/local-b and was
      // merged there afterwards, so main never got A's work.
      const facts = stacked({ mergedAt: T0 + 60_000, mergedInto: "feature/local-b" }, base(T0));
      for (const mode of ["merged", "stacked"] as const) {
        const decision = evaluateDependencyGate(mode, [facts]);
        expect(decision.kind).toBe("blocked");
        if (decision.kind !== "blocked") throw new Error("unreachable");
        expect(decision.reason).toContain(
          "local-a PR #1 merged into feature/local-b after local-b PR #2 merged",
        );
      }
    });

    test("retargeted away from the base's branch before merging is satisfied", () => {
      const facts = stacked({ mergedAt: T0 + 60_000, mergedInto: "main" }, base(T0));
      expect(evaluateDependencyGate("merged", [facts]).kind).toBe("ready");
      const known = stacked(
        { mergedAt: T0 + 60_000, mergedInto: "main", mergedIntoDefault: true },
        base(T0),
      );
      expect(evaluateDependencyGate("merged", [known]).kind).toBe("ready");
    });

    test("retargeted to a branch that is not the default branch blocks", () => {
      const facts = stacked(
        { mergedAt: T0 + 60_000, mergedInto: "feature/local-c", mergedIntoDefault: false },
        base(T0),
      );
      for (const mode of ["merged", "stacked"] as const) {
        const decision = evaluateDependencyGate(mode, [facts]);
        if (decision.kind !== "blocked") throw new Error("expected blocked");
        expect(decision.reason).toContain(
          "local-a PR #1 merged into feature/local-c, which is neither the default branch",
        );
      }
    });

    test("unknown merge order waits and looks up the PR missing a host merge time", () => {
      const unknownDependency = evaluateDependencyGate("merged", [stacked({}, base(T0))]);
      if (unknownDependency.kind !== "waiting") throw new Error("expected waiting");
      expect(unknownDependency.reason).toBe(
        "checking whether local-a PR #1 merged before local-b PR #2",
      );
      expect(unknownDependency.mergeStateLookups.map((entry) => entry.pr.number)).toEqual([1]);

      const unknownBase = evaluateDependencyGate("stacked", [
        stacked({ mergedAt: T0, mergedInto: "feature/local-b" }, base()),
      ]);
      if (unknownBase.kind !== "waiting") throw new Error("expected waiting");
      expect(unknownBase.mergeStateLookups.map((entry) => entry.pr.number)).toEqual([2]);
    });
  });

  test("reads merge facts, including whether the base is the default branch, from a PR payload", () => {
    const payload = (ref: string) => ({
      merged_at: "2026-11-17T10:00:00Z",
      base: { sha: "abc", ref, repo: { default_branch: "main" } },
    });
    expect(mergeDetailsFromPr(payload("main"))).toEqual({
      mergedAt: Date.parse("2026-11-17T10:00:00Z"),
      mergedInto: "main",
      mergedIntoDefault: true,
    });
    expect(mergeDetailsFromPr(payload("feature/x")).mergedIntoDefault).toBe(false);
    expect(
      mergeDetailsFromPr({ base: { sha: "abc", ref: "main" } }).mergedIntoDefault,
    ).toBeUndefined();
  });

  test("finds cycles through existing edges", () => {
    const edges: Record<string, string[]> = { "local-b": ["local-a"], "local-c": ["local-b"] };
    expect(findDependencyCycle("local-a", ["local-c"], (key) => edges[key] ?? [])).toEqual([
      "local-a",
      "local-c",
      "local-b",
      "local-a",
    ]);
    expect(findDependencyCycle("local-d", ["local-c"], (key) => edges[key] ?? [])).toBeNull();
  });
});

describe("stacked base", () => {
  const base = { taskKey: "local-a", branch: "feature/local-a", prNumber: 12 };

  test("adds a Target branch line and a parseable marker", () => {
    const applied = applyStackBase("Do the thing.", base);
    expect(applied.stackedOn).toEqual(base);
    expect(extractTargetBranch(applied.body)).toBe("feature/local-a");
    expect(parseStackedOnMarker(applied.body)).toEqual({ ...base, prUrl: undefined });
  });

  test("an explicit Target branch wins, with a warning", () => {
    const warnings: string[] = [];
    const applied = applyStackBase("Target branch: release/1.0\n", base, (m) => warnings.push(m));
    expect(applied.stackedOn).toBeUndefined();
    expect(extractTargetBranch(applied.body)).toBe("release/1.0");
    expect(warnings[0]).toContain("wins over the stacked base feature/local-a");
  });

  test("the PR body states which PR it is stacked on", () => {
    const body = buildPrBody({ taskKey: "local-b", taskSummary: "B", stackedOn: base });
    expect(body).toContain("**Stacked on #12** (`feature/local-a`, task local-a)");
    expect(buildPrBody({ taskKey: "local-b", taskSummary: "B" })).not.toContain("Stacked on");
  });
});

describe("ad-hoc task dependencies", () => {
  let dir: string;
  let dbPath: string;
  let store: InjectedTaskStore;
  let runs: RunStore;
  let prs: WorkerState;
  let raw: Database;

  beforeEach(() => {
    resetWorkerFailover();
    dir = join(tmpdir(), `task-deps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    store = new InjectedTaskStore(dbPath);
    runs = new RunStore(dbPath);
    prs = new WorkerState(dbPath);
    store.hasPending(); // create the schema
    raw = new Database(dbPath);
  });

  afterEach(() => {
    raw.close();
    prs.close();
    runs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    resetWorkerFailover();
  });

  function add(
    title: string,
    options: { repo?: string; body?: string; after?: string[]; mode?: "merged" | "stacked" } = {},
  ): InjectedTask {
    return enqueueInjectedTask(store, dir, {
      repo: options.repo ?? "backend",
      title,
      body: options.body ?? "",
      after: options.after,
      dependencyMode: options.mode,
    }).task;
  }

  function settle(taskKey: string, status: "pending" | "done" | "failed"): void {
    raw.run("UPDATE injected_tasks SET status = ? WHERE task_key = ?", [status, taskKey]);
  }

  /** Record a finished run (optionally with a registered PR) for a dependency. */
  function finishRun(
    taskKey: string,
    status: Exclude<RunStatus, "in_progress">,
    pr?: { number: number; branch?: string; unregistered?: boolean },
  ): void {
    const runId = runs.createRun({ origin: "local", taskKey, repo: SLUG });
    if (pr) {
      const branch = pr.branch ?? `feature/${taskKey}`;
      runs.setRunPr(runId, { repo: SLUG, prNumber: pr.number });
      runs.setRunBranch(runId, branch);
      if (!pr.unregistered) prs.recordAgentPr({ repo: SLUG, prNumber: pr.number, branch, taskKey });
    }
    runs.finishRun(runId, status);
  }

  function acquirer(
    executed: InjectedTask[],
    extra: Partial<ConstructorParameters<typeof InjectedTaskAcquirer>[0]> = {},
  ) {
    return new InjectedTaskAcquirer({
      store,
      execute: async (task): Promise<TaskExecutionResult> => {
        executed.push(task);
        return true;
      },
      intervalSeconds: 3600,
      isPaused: () => false,
      ...extra,
    });
  }

  describe("enqueue validation", () => {
    test("rejects an unknown key", () => {
      expect(() => add("Second", { after: ["local-missing"] })).toThrow(
        InjectedTaskDependencyError,
      );
      expect(() => add("Second", { after: ["local-missing"] })).toThrow(
        /unknown dependency local-missing/,
      );
      expect(store.list()).toHaveLength(0);
    });

    test("ignores body keys and prose that name no ad-hoc task", () => {
      add("First");
      const result = enqueueInjectedTask(store, dir, {
        repo: "backend",
        title: "Second",
        body: "Depends on: the orders API being deployed first\n\nDepends on: PROJ-12, local-first",
      });
      expect(result.task.dependsOn).toEqual(["local-first"]);
      expect(result.ignoredDependencies).toEqual(["PROJ-12"]);
      expect(add("Third", { body: "Depends on: PROJ-99" }).dependsOn).toEqual([]);
    });

    test("rejects a cross-repo key", () => {
      add("First", { repo: "web" });
      expect(() => add("Second", { after: ["local-first"] })).toThrow(
        /cross-repo dependencies are not supported: local-first \(repo "web"\)/,
      );
      expect(store.list()).toHaveLength(1);
    });

    test("rejects a cycle", () => {
      // A pruned task's key can be derived again; the new task would then
      // depend on a task that already depends on its key.
      add("X");
      add("A", { after: ["local-x"] });
      raw.run("DELETE FROM injected_tasks WHERE task_key = 'local-x'");
      add("Helper");
      raw.run(
        `UPDATE injected_tasks SET depends_on = '["local-a"]' WHERE task_key = 'local-helper'`,
      );
      expect(() => add("X", { after: ["local-helper"] })).toThrow(
        /dependency cycle: local-x → local-helper → local-a → local-x/,
      );
      expect(store.getByTaskKey("local-x")).toBeNull();
    });

    test("merges --after with Depends on: lines and stores mode and initial state", () => {
      add("First");
      add("Second");
      const task = add("Third", {
        after: ["local-second"],
        body: "**Depends on**: local-first, local-second",
        mode: "stacked",
      });
      expect(task.dependsOn).toEqual(["local-second", "local-first"]);
      expect(task.dependencyMode).toBe("stacked");
      expect(task.dependencyState).toBe("waiting");
      expect(task.dependencyReason).toBe("local-second not started; local-first not started");
    });
  });

  describe("merged mode", () => {
    test("stays pending while the dependency PR is open, runs after the merge", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 12 });

      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      expect(executed).toHaveLength(0);
      const waiting = store.getById(dependent.id)!;
      expect(waiting.status).toBe("pending");
      expect(waiting.dependencyState).toBe("waiting");
      expect(waiting.dependencyReason).toBe("local-base PR #12 not merged");

      prs.markAgentPrClosed(SLUG, 12, "merged");
      await acquirer(executed).tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-next"]);
      // Merged mode starts from the default branch: no stacked base.
      expect(extractTargetBranch(readFileSync(dependent.taskFile, "utf8"))).toBeNull();
    });

    test("a dependency PR closed without merging blocks the dependent", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 12 });
      prs.markAgentPrClosed(SLUG, 12, "closed");

      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      expect(executed).toHaveLength(0);
      expect(store.getById(dependent.id)).toMatchObject({
        status: "pending",
        dependencyState: "blocked",
        dependencyReason: "local-base PR #12 closed without merging",
      });
    });

    test("a dependency run whose PR creation failed blocks the dependent", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      const runId = runs.createRun({ origin: "local", taskKey: "local-base", repo: SLUG });
      runs.setRunBranch(runId, "feature/local-base");
      runs.setRunPrFailure(runId, "Validation Failed");
      runs.finishRun(runId, "succeeded");

      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      expect(executed).toHaveLength(0);
      expect(store.getById(dependent.id)).toMatchObject({
        status: "pending",
        dependencyState: "blocked",
        dependencyReason: "local-base pushed but PR creation failed",
      });
    });

    test("an escalated or failed dependency blocks; a re-queue and success unblock it", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "escalated");

      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      expect(store.getById(dependent.id)?.dependencyReason).toBe("local-base escalated");

      settle("local-base", "failed");
      await acquirer(executed).tick();
      expect(store.getById(dependent.id)).toMatchObject({
        dependencyState: "blocked",
        dependencyReason: "local-base failed",
      });

      // `worker add --resume local-base`, which later succeeds without a PR.
      expect(store.requeueSettled("local-base")).not.toBeNull();
      const resumed: InjectedTask[] = [];
      await acquirer(resumed, {
        execute: async (task) => {
          resumed.push(task);
          if (task.taskKey === "local-base") finishRun("local-base", "succeeded");
          return true;
        },
      }).tick();
      expect(resumed.map((task) => task.taskKey)).toEqual(["local-base"]);
      expect(store.getById(dependent.id)?.dependencyState).toBe("waiting");

      await acquirer(executed).tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-next"]);
    });

    test("asks the code host when a closed PR's merge state is unknown", async () => {
      add("Base");
      add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 12 });
      prs.markAgentPrClosed(SLUG, 12); // closed, reason unknown

      const lookups: number[] = [];
      const resolveMergeState = async ({ pr }: { pr: { number: number } }) => {
        lookups.push(pr.number);
        prs.markAgentPrClosed(SLUG, pr.number, "merged");
        return { state: "merged" as const };
      };
      const executed: InjectedTask[] = [];
      await acquirer(executed, { resolveMergeState }).tick();
      expect(lookups).toEqual([12]);
      expect(executed.map((task) => task.taskKey)).toEqual(["local-next"]);
    });

    test("asks about an open PR no poller closed, with a cooldown", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 12 });

      let now = 1_000_000;
      let answer: "merged" | null = null;
      const lookups: number[] = [];
      const resolveMergeState = async ({ pr }: { pr: { number: number } }) => {
        lookups.push(pr.number);
        return answer && { state: answer };
      };
      const executed: InjectedTask[] = [];
      const worker = acquirer(executed, { resolveMergeState, now: () => now });
      await worker.tick(); // still open on the host
      expect(lookups).toEqual([12]);
      expect(store.getById(dependent.id)?.dependencyReason).toBe("local-base PR #12 not merged");

      answer = "merged"; // merged on the host; nothing records it locally
      await worker.tick();
      expect(lookups).toEqual([12]); // within the cooldown
      expect(executed).toHaveLength(0);

      now += MERGE_STATE_LOOKUP_COOLDOWN_MS;
      await worker.tick();
      expect(lookups).toEqual([12, 12]);
      expect(executed.map((task) => task.taskKey)).toEqual(["local-next"]);
    });

    test("a host merge answer for a stack base's PR satisfies the dependency stacked on it", async () => {
      add("A");
      settle("local-a", "done");
      finishRun("local-a", "succeeded", { number: 1 });
      add("B", { after: ["local-a"], mode: "stacked" });
      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      settle("local-b", "done");
      finishRun("local-b", "succeeded", { number: 2 });
      prs.markAgentPrClosed(SLUG, 2, "merged");
      add("C", { after: ["local-b"] });

      const lookups: number[] = [];
      // Like the real resolver, record what the host reports: B merged into
      // A's branch, then A merged into main.
      const T0 = Date.parse("2026-11-17T10:00:00Z");
      const resolveMergeState = async ({ pr }: { pr: { number: number } }) => {
        lookups.push(pr.number);
        prs.markAgentPrClosed(
          SLUG,
          pr.number,
          "merged",
          pr.number === 1
            ? { mergedAt: T0 + 60_000, mergedInto: "main" }
            : { mergedAt: T0, mergedInto: "feature/local-a" },
        );
        return { state: "merged" as const };
      };
      const worker = acquirer(executed, { resolveMergeState });
      await worker.tick(); // A's PR is open locally: asks about #1
      await worker.tick(); // A merged; B's host merge time unknown: asks about #2
      await worker.tick();
      expect(lookups).toEqual([1, 2]);
      expect(executed.map((task) => task.taskKey)).toEqual(["local-b", "local-c"]);
    });

    test("an unregistered stacked PR the host reports merged still follows its stack base", async () => {
      add("A");
      settle("local-a", "done");
      finishRun("local-a", "succeeded", { number: 1 });
      add("B", { after: ["local-a"], mode: "stacked" });
      const executed: InjectedTask[] = [];
      await acquirer(executed).tick(); // B claimed stacked on A
      settle("local-b", "done");
      // B's run recorded PR #2, but the registry never saw it.
      finishRun("local-b", "succeeded", { number: 2, unregistered: true });
      const T0 = Date.parse("2026-11-17T10:00:00Z");
      prs.markAgentPrClosed(SLUG, 1, "merged", { mergedAt: T0, mergedInto: "main" });
      const c = add("C", { after: ["local-b"] });

      // A merged into main first; B merged into A's branch afterwards.
      const resolveMergeState = async () => ({
        state: "merged" as const,
        mergedAt: T0 + 60_000,
        mergedInto: "feature/local-a",
      });
      const worker = acquirer(executed, { resolveMergeState });
      await worker.tick();
      await worker.tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-b"]);
      expect(store.getById(c.id)?.dependencyState).toBe("blocked");
      expect(store.getById(c.id)?.dependencyReason).toContain(
        "local-b PR #2 merged into feature/local-a after local-a PR #1 merged",
      );
    });

    test("a hung merge-state lookup does not hold the claim section", async () => {
      add("Base");
      add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 7 }); // still open locally

      const executed: InjectedTask[] = [];
      const lookups: number[] = [];
      const worker = acquirer(executed, {
        resolveMergeState: ({ pr }) => {
          lookups.push(pr.number);
          return new Promise(() => {}); // the host never answers
        },
        mergeStateLookupTimeoutMs: 50,
      });
      add("Independent");
      const first = worker.tick();
      await Bun.sleep(10);
      expect(lookups).toEqual([7]);
      expect(executed.map((task) => task.taskKey)).toEqual(["local-independent"]);

      // While the lookup still hangs, a later tick claims new work.
      add("Later");
      await worker.tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-independent", "local-later"]);
      expect(lookups).toEqual([7]); // cooldown: not looked up again

      await first; // the timeout settles the hung lookup
      expect(executed.map((task) => task.taskKey)).not.toContain("local-next");
    });

    test("a cached closed answer does not override a PR re-registered as open", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 12 });

      const resolveMergeState = async ({ pr }: { pr: { number: number } }) => {
        prs.markAgentPrClosed(SLUG, pr.number, "closed");
        return { state: "closed" as const };
      };
      const executed: InjectedTask[] = [];
      const worker = acquirer(executed, { resolveMergeState });
      await worker.tick(); // looks up; host says closed
      await worker.tick();
      expect(store.getById(dependent.id)?.dependencyReason).toBe(
        "local-base PR #12 closed without merging",
      );

      // PR reopened and re-registered (upsert resets state to open).
      prs.recordAgentPr({
        repo: SLUG,
        prNumber: 12,
        branch: "feature/local-base",
        taskKey: "local-base",
      });
      await worker.tick();
      expect(store.getById(dependent.id)).toMatchObject({
        dependencyState: "waiting",
        dependencyReason: "local-base PR #12 not merged",
      });
    });

    test("a cached closed answer for an unregistered PR is dropped once the dependency re-runs", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 44, unregistered: true });

      let answer: "closed" | null = "closed";
      const executed: InjectedTask[] = [];
      const worker = acquirer(executed, {
        resolveMergeState: async () => answer && { state: answer },
        execute: async (task) => {
          executed.push(task);
          // The re-run reopens and reports the same PR number.
          if (task.taskKey === "local-base") {
            finishRun("local-base", "succeeded", { number: 44, unregistered: true });
          }
          return true;
        },
      });
      await worker.tick(); // host says closed
      await worker.tick();
      expect(store.getById(dependent.id)?.dependencyState).toBe("blocked");

      answer = null; // reopened on the host
      expect(store.requeueSettled("local-base")).not.toBeNull();
      await worker.tick(); // runs local-base again
      expect(executed.map((task) => task.taskKey)).toEqual(["local-base"]);
      await worker.tick();
      expect(store.getById(dependent.id)).toMatchObject({
        dependencyState: "waiting",
        dependencyReason: "local-base PR #44 not merged",
      });
    });

    test("a PR the registry never recorded unblocks once the host says it merged", async () => {
      add("Base");
      add("Next", { after: ["local-base"] });
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 44, unregistered: true });

      const executed: InjectedTask[] = [];
      // No agent_prs row: the resolver cannot record anything; the acquirer
      // still honors its answer.
      await acquirer(executed, {
        resolveMergeState: async () => ({ state: "merged" as const }),
      }).tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-next"]);
    });
  });

  describe("stacked mode", () => {
    test("claimable once the dependency succeeded with an open PR; targets its branch", async () => {
      add("Base");
      const dependent = add("Next", { after: ["local-base"], mode: "stacked" });

      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      // Base runs first (no deps); the dependent waits for it to finish.
      expect(executed.map((task) => task.taskKey)).toEqual(["local-base"]);
      expect(store.getById(dependent.id)?.dependencyReason).toBe("local-base not started");

      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 7, branch: "feature/local-base" });
      await acquirer(executed).tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-base", "local-next"]);

      const description = readFileSync(dependent.taskFile, "utf8");
      expect(parseStackedOnMarker(description)).toMatchObject({
        taskKey: "local-base",
        prNumber: 7,
      });

      const previous = runContext.options;
      runContext.options = { prTargetBranch: "main", git: false, verbose: false } as never;
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await resolveEffectiveTargetBranch(description)).toBe("feature/local-base");
      } finally {
        log.mockRestore();
        runContext.options = previous;
      }
    });

    test("an explicit Target branch in the body wins over the stacked base", async () => {
      add("Base");
      settle("local-base", "done");
      finishRun("local-base", "succeeded", { number: 7 });
      const dependent = add("Next", {
        after: ["local-base"],
        mode: "stacked",
        body: "Target branch: release/2.0",
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const executed: InjectedTask[] = [];
        await acquirer(executed).tick();
        expect(executed.map((task) => task.taskKey)).toEqual(["local-next"]);
        expect(warn.mock.calls.flat().join(" ")).toContain("wins over the stacked base");
      } finally {
        warn.mockRestore();
      }
      expect(extractTargetBranch(readFileSync(dependent.taskFile, "utf8"))).toBe("release/2.0");
    });

    test("waits until at most one dependency remains unmerged", async () => {
      add("A");
      add("B");
      settle("local-a", "done");
      settle("local-b", "done");
      finishRun("local-a", "succeeded", { number: 1 });
      finishRun("local-b", "succeeded", { number: 2 });
      const dependent = add("C", { after: ["local-a", "local-b"], mode: "stacked" });

      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      expect(executed).toHaveLength(0);
      expect(store.getById(dependent.id)?.dependencyReason).toContain("2 dependencies unmerged");

      prs.markAgentPrClosed(SLUG, 1, "merged");
      await acquirer(executed).tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-c"]);
      expect(parseStackedOnMarker(readFileSync(dependent.taskFile, "utf8"))).toMatchObject({
        taskKey: "local-b",
        prNumber: 2,
      });
    });
    test("a stacked dependency merged into its base's branch counts only once the base merged", async () => {
      // A <- B (stacked on A's open PR) <- C. B's PR merges into A's branch
      // while A is still open: the default branch has neither A's nor B's work.
      add("A");
      settle("local-a", "done");
      finishRun("local-a", "succeeded", { number: 1 });
      add("B", { after: ["local-a"], mode: "stacked" });
      const executed: InjectedTask[] = [];
      await acquirer(executed).tick();
      expect(executed.map((task) => task.taskKey)).toEqual(["local-b"]);
      settle("local-b", "done");
      finishRun("local-b", "succeeded", { number: 2, branch: "feature/local-b" });
      const T0 = Date.parse("2026-11-17T10:00:00Z");
      prs.markAgentPrClosed(SLUG, 2, "merged", {
        mergedAt: T0,
        mergedInto: "feature/local-a",
      });

      const merged = add("C merged", { after: ["local-b"] });
      const stacked = add("C stacked", { after: ["local-b", "local-a"], mode: "stacked" });
      await acquirer(executed).tick();
      // Merged mode waits on A's PR, which now carries B's work.
      expect(store.getById(merged.id)).toMatchObject({
        status: "pending",
        dependencyReason: "local-a PR #1 not merged",
      });
      // Stacked mode stacks on A's branch (B and A resolve to the same PR).
      expect(executed.map((task) => task.taskKey)).toEqual(["local-b", "local-c-stacked"]);
      expect(parseStackedOnMarker(readFileSync(stacked.taskFile, "utf8"))).toMatchObject({
        taskKey: "local-a",
        prNumber: 1,
        branch: "feature/local-a",
      });

      // A merged after B landed in A's branch, so main now has both.
      prs.markAgentPrClosed(SLUG, 1, "merged", { mergedAt: T0 + 60_000, mergedInto: "main" });
      await acquirer(executed).tick();
      expect(executed.map((task) => task.taskKey)).toEqual([
        "local-b",
        "local-c-stacked",
        "local-c-merged",
      ]);
      expect(parseStackedOnMarker(readFileSync(merged.taskFile, "utf8"))).toBeNull();
    });
  });

  test("waiting tasks consume neither concurrency nor deferrals", async () => {
    add("Base");
    settle("local-base", "done");
    finishRun("local-base", "succeeded", { number: 12 });
    const waiting = add("Waiting", { after: ["local-base"] });
    add("Independent");

    const executed: InjectedTask[] = [];
    const drain = acquirer(executed, { maxConcurrency: 1, maxDeferrals: 1 });
    for (let tick = 0; tick < MAX_INJECTED_DEFERRALS + 2; tick++) {
      await drain.tick();
    }
    // The single slot went to the independent task on the first tick even
    // though the waiting row is older.
    expect(executed.map((task) => task.taskKey)).toEqual(["local-independent"]);
    const row = store.getById(waiting.id)!;
    expect(row.status).toBe("pending");
    expect(row.deferCount).toBe(0);
    expect(row.notBefore).toBeUndefined();
  });

  test("the queue view shows dependencies and reasons", () => {
    add("Base");
    settle("local-base", "done");
    finishRun("local-base", "escalated");
    add("Next", { after: ["local-base"] });
    add("Plain");

    const body = collectQueuedWork({
      dbPath,
      queueDbPath: dbPath,
      listInjected: (limit) => store.listPending(limit),
      lookupRun: () => null,
      pendingTotal: 0,
    });
    const next = body.items.find((item) => item.taskKey === "local-next")!;
    expect(next).toMatchObject({
      dependsOn: ["local-base"],
      dependencyMode: "merged",
      dependencyState: "blocked",
      dependencyReason: "local-base escalated",
    });
    expect(queuedDependencyStatus(next)).toBe("blocked: local-base escalated");
    const plain = body.items.find((item) => item.taskKey === "local-plain")!;
    expect(plain.dependsOn).toBeUndefined();
    expect(queuedDependencyStatus(plain)).toBeUndefined();
  });
});

describe("worker add --after", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `task-deps-add-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "workspace.toml");
    writeFileSync(
      configPath,
      `[workspace]
dashboard = false

[defaults]
tracker = "markdown"
dependency_mode = "stacked"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
`,
    );
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
  });

  afterEach(() => {
    delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runWorkerAdd(["--workspace", configPath, ...args], {
      log: (message) => out.push(message),
      error: (message) => err.push(message),
    });
    return { code, out, err };
  }

  test("parses --after (repeatable) and the mutually exclusive mode flags", () => {
    const parsed = parseWorkerAddArgs([
      "--title",
      "x",
      "--after",
      "local-a",
      "--after",
      "local-b",
      "--stack",
    ]);
    expect(parsed).toMatchObject({
      kind: "ok",
      options: { after: ["local-a", "local-b"], dependencyMode: "stacked" },
    });
    expect(parseWorkerAddArgs(["--title", "x", "--stack", "--wait-merge"])).toEqual({
      kind: "error",
      message: "--stack and --wait-merge are mutually exclusive.",
    });
    expect(parseWorkerAddArgs(["--resume", "local-x", "--after", "local-a"]).kind).toBe("error");
  });

  test("JSON includes dependsOn and the resolved mode; unknown keys fail without a row", async () => {
    expect((await run(["--title", "Base", "--json"])).code).toBe(0);

    const added = await run(["--title", "Next", "--after", "local-base", "--json"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out.at(-1)!)).toMatchObject({
      taskKey: "local-next",
      dependsOn: ["local-base"],
      dependencyMode: "stacked",
      dependencyState: "waiting",
      dependencyReason: "local-base not started",
    });

    const overridden = await run([
      "--title",
      "Other",
      "--body",
      "Depends on: local-base",
      "--wait-merge",
      "--json",
    ]);
    expect(JSON.parse(overridden.out.at(-1)!)).toMatchObject({
      dependsOn: ["local-base"],
      dependencyMode: "merged",
    });

    const rejected = await run(["--title", "Bad", "--after", "local-nope", "--json"]);
    expect(rejected.code).toBe(1);
    expect(rejected.err.join("\n")).toContain("unknown dependency local-nope");
    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      expect(store.getByTaskKey("local-bad")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a prose or tracker-key 'Depends on:' body still enqueues, with a warning", async () => {
    const added = await run([
      "--title",
      "Prose",
      "--body",
      "Depends on: the orders API being deployed first\n\nDepends on: PROJ-12",
      "--json",
    ]);
    expect(added.code).toBe(0);
    const json = JSON.parse(added.out.at(-1)!);
    expect(json).toMatchObject({ taskKey: "local-prose", status: "pending" });
    expect(json.dependsOn ?? []).toEqual([]);
    expect(added.err.join("\n")).toContain("Ignoring 'Depends on:' PROJ-12");
  });
});

describe("agent PR merge recording", () => {
  let dir: string;
  let state: WorkerState;

  beforeEach(() => {
    dir = join(tmpdir(), `task-deps-prs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    state = new WorkerState(join(dir, "queue.db"));
  });

  afterEach(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a fetched merged PR records merged; closed-unmerged records closed; reopen clears", () => {
    state.recordAgentPr({ repo: SLUG, prNumber: 1, taskKey: "local-a" });
    state.recordAgentPr({ repo: SLUG, prNumber: 2, taskKey: "local-b" });
    applyAgentPrFetch(
      state,
      { repo: SLUG, prNumber: 1 },
      {
        data: { state: "closed", merged: true, merged_at: "2026-11-17T00:00:00Z" },
        notModified: false,
      },
    );
    applyAgentPrFetch(
      state,
      { repo: SLUG, prNumber: 2 },
      {
        data: { state: "closed", merged: false },
        notModified: false,
      },
    );
    const rows = new Database(join(dir, "queue.db"), { readonly: true });
    try {
      const read = (n: number) =>
        rows
          .query("SELECT state, close_reason, merged_at FROM agent_prs WHERE pr_number = ?")
          .get(n) as { state: string; close_reason: string | null; merged_at: number | null };
      expect(read(1)).toMatchObject({ state: "closed", close_reason: "merged" });
      expect(read(1).merged_at).toBeGreaterThan(0);
      expect(read(2)).toEqual({ state: "closed", close_reason: "closed", merged_at: null });

      // A later close that cannot tell keeps the recorded reason.
      state.markAgentPrClosed(SLUG, 1);
      expect(read(1).close_reason).toBe("merged");

      state.recordAgentPr({ repo: SLUG, prNumber: 2, taskKey: "local-b" });
      expect(read(2)).toEqual({ state: "open", close_reason: null, merged_at: null });
    } finally {
      rows.close();
    }
  });

  test("a fetched merged PR records the host's merge time and base ref", () => {
    state.recordAgentPr({ repo: SLUG, prNumber: 1, branch: "feature/local-a", taskKey: "local-a" });
    applyAgentPrFetch(
      state,
      { repo: SLUG, prNumber: 1 },
      {
        data: {
          state: "closed",
          merged: true,
          merged_at: "2026-11-17T00:00:00Z",
          base: { sha: "abc", ref: "feature/local-b" },
        },
        notModified: false,
      },
    );
    // A later close without payload details keeps them.
    state.markAgentPrClosed(SLUG, 1, "merged");
    const db = new Database(join(dir, "queue.db"));
    try {
      expect(readLocalDependencyFacts(db, ["local-a"])[0]?.pr).toMatchObject({
        state: "merged",
        mergedAt: Date.parse("2026-11-17T00:00:00Z"),
        mergedInto: "feature/local-b",
      });
    } finally {
      db.close();
    }
  });
});
