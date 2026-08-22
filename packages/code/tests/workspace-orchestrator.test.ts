import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { WorkspaceConfig } from "../src/lib/workspace/config";
import { CoordinationStore } from "../src/lib/workspace/coordination";
import { RunStore } from "../src/lib/run-recorder";
import { createRepoRunLock } from "../src/lib/workspace/state";
import {
  applyCoordinationSection,
  buildCoordinationSection,
  reconcileCoordinatedPrs,
  runCoordinatedTask,
} from "../src/lib/workspace/orchestrator";
import type { OrchestratorRepoManager } from "../src/lib/workspace/orchestrator";
import type { PlanningTaskInput, PlannerResult } from "../src/lib/workspace/planner-agent";
import type { LockManager } from "../src/lib/lock-manager";

const CONFIG: WorkspaceConfig = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[repos]]
name = "shared-config"
remote = "git@github.com:acme/shared-config.git"
  [repos.env]
  GITHUB_REPO = "acme/shared-config"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
branch_prefix = "task"
  [repos.env]
  GITHUB_REPO = "acme/backend"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
  [repos.env]
  GITHUB_REPO = "acme/frontend"
`);

class FakeRepoManager implements OrchestratorRepoManager {
  worktreeRequests: Array<{ repo: string; taskKey: string }> = [];
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  bareClonePath(repoName: string): string {
    return join(this.root, "repos", `${repoName}.git`);
  }

  async ensureBareClone(): Promise<string> {
    return this.root;
  }

  async fetch(): Promise<void> {}

  async createTaskWorktree(repo: { name: string }, taskKey: string): Promise<string> {
    this.worktreeRequests.push({ repo: repo.name, taskKey });
    return join(this.root, "worktrees", repo.name, taskKey);
  }

  async removeTaskWorktree(): Promise<void> {}
}

interface RunCall {
  repo: string;
  taskKey: string;
  env: Record<string, string | undefined>;
}

/** Behavior per repo for the fake single-repo pipeline. */
type RunBehavior = (repo: string, call: RunCall) => boolean;

describe("runCoordinatedTask", () => {
  let dir: string;
  let coordination: CoordinationStore;
  let runs: RunStore;
  let repoManager: FakeRepoManager;
  let calls: RunCall[];
  let behavior: RunBehavior;
  /** Simulates the PR the real subprocess would record via `recordRunPr`. */
  let simulateSubprocessPr: boolean;
  /** Repo that produces no diff (runTask succeeds but writes no PR). */
  let noDiffRepo: string | null;
  let plannerInvocations: number;
  let planFor: (input: PlanningTaskInput) => PlannerResult;
  const prBodies = new Map<string, string>();
  let reconciliationFailuresFor: Set<string>;
  let bodyUpdates: Array<{ slug: string; prNumber: number; body: string }>;

  beforeEach(() => {
    dir = join(tmpdir(), `ws-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    coordination = new CoordinationStore(join(dir, "queue.db"));
    runs = new RunStore(join(dir, "queue.db"));
    repoManager = new FakeRepoManager(dir);
    calls = [];
    behavior = () => true;
    simulateSubprocessPr = true;
    noDiffRepo = null;
    plannerInvocations = 0;
    planFor = (input) => {
      void input;
      plannerInvocations += 1;
      return {
        ok: true,
        entries: [
          {
            repo: "shared-config",
            rationale: "owns the flag",
            change: "add flag",
            dependencies: [],
          },
          {
            repo: "backend",
            rationale: "consumes it",
            change: "use flag",
            dependencies: ["shared-config"],
          },
        ],
        executionOrder: ["shared-config", "backend"],
      };
    };
    prBodies.clear();
    reconciliationFailuresFor = new Set();
    bodyUpdates = [];
  });

  afterEach(() => {
    coordination.close();
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<Parameters<typeof runCoordinatedTask>[0]> = {}) {
    const base = {
      config: CONFIG,
      workspaceDir: dir,
      store: coordination,
      runs,
      repoManager,
      repoLock: (name: string): LockManager => createRepoRunLock(name, dir),
      planner: async (input: PlanningTaskInput): Promise<PlannerResult> => planFor(input),
      github: {
        getPullRequestBody: async (slug: string, prNumber: number) =>
          prBodies.get(`${slug}#${prNumber}`) ?? null,
        updatePullRequestBody: async (slug: string, prNumber: number, body: string) => {
          if (reconciliationFailuresFor.has(slug)) {
            throw new Error("GitHub API down");
          }
          bodyUpdates.push({ slug, prNumber, body });
          prBodies.set(`${slug}#${prNumber}`, body);
        },
      },
      runTask: async (
        _taskKey: string,
        _extraArgs: string[],
        opts: { cwd: string; env: Record<string, string | undefined> },
      ) => {
        // The orchestrator passes the repo name via cwd (<root>/worktrees/<repo>/...).
        const afterWorktrees = opts.cwd.split(/worktrees[\\/]/)[1] ?? "";
        const repo = afterWorktrees.split(/[\\/]/)[0] ?? "?";
        const call: RunCall = { repo, taskKey: _taskKey, env: opts.env };
        calls.push(call);

        const ok = behavior(repo, call);
        if (simulateSubprocessPr && ok && repo !== noDiffRepo) {
          const slug = CONFIG.repos.find((r) => r.name === repo)?.env.GITHUB_REPO ?? "";
          const branch = opts.env.DEVINTERN_FEATURE_BRANCH ?? "";
          const n = branch.length + repo.length; // deterministic fake number
          const url = `https://github.com/${slug}/pull/${n}`;
          const runId = runs.createRun({
            origin: "task",
            taskKey: _taskKey,
            coordinationId: opts.env.DEVINTERN_COORDINATION_ID,
            branch,
            repo: slug,
          });
          runs.setRunPr(runId, { repo: slug, prNumber: n, url });
          prBodies.set(`${slug}#${n}`, "## Task: DEV-9\n(base body)");
        }

        return ok;
      },
      extraArgs: ["--create-pr"],
      recordSkip: () => {},
    };
    return { ...base, ...overrides };
  }

  test("plans once and executes repositories in dependency order with coordination env", async () => {
    const deps = makeDeps();
    const handled = await runCoordinatedTask(
      deps,
      {
        taskKey: "DEV-9",
        title: "Add a flag",
        description: "wire a feature flag",
        candidates: ["backend"],
      },
      ["backend"],
    );
    expect(handled).toBe(true);
    expect(plannerInvocations).toBe(1);

    // Topological order: prerequisite first.
    expect(calls.map((call) => call.repo)).toEqual(["shared-config", "backend"]);

    const effort = coordination.latestForTask("DEV-9");
    expect(effort?.status).toBe("completed");
    expect(effort?.plan?.executionOrder).toEqual(["shared-config", "backend"]);
    const id = effort?.coordinationId as string;

    // Deterministic, collision-resistant branches honoring repo conventions.
    expect(calls[0]?.env.DEVINTERN_FEATURE_BRANCH).toBe(`feature/${id}`);
    expect(calls[1]?.env.DEVINTERN_FEATURE_BRANCH).toBe(`task/${id}`);
    expect(calls[0]?.env.DEVINTERN_COORDINATION_ID).toBe(id);
    expect(calls[0]?.env.DEVINTERN_PR_FOOTER).toContain(`devintern-coordination:${id}`);

    // Worktrees are requested under stable names for debuggability.
    expect(repoManager.worktreeRequests[0]).toEqual({
      repo: "shared-config",
      taskKey: `dev-9-${id}`,
    });

    // Per-repo run rows carry repository, branch, status, dependencies, PR.
    const sharedRow = coordination.getRun(id, "shared-config");
    expect(sharedRow).toMatchObject({ status: "succeeded" });
    expect(sharedRow?.prUrl).toContain("https://github.com/acme/shared-config/pull/");
    const backendRow = coordination.getRun(id, "backend");
    expect(backendRow).toMatchObject({
      status: "succeeded",
      dependencies: ["shared-config"],
      branch: `task/${id}`,
    });
    expect(backendRow?.prUrl).toContain("https://github.com/acme/backend/pull/");

    // Sibling links reconciled into both PR bodies exactly once each.
    const marker = `devintern-coordination:${id}`;
    expect(bodyUpdates.map((update) => update.slug).sort()).toEqual([
      "acme/backend",
      "acme/shared-config",
    ]);
    const backendBody = bodyUpdates.find((u) => u.slug === "acme/backend");
    expect(backendBody?.body).toContain("acme/shared-config/pull/");
    // Exactly one coordination section (open + close markers), replaced not appended.
    expect(backendBody?.body.match(new RegExp(marker, "g"))).toHaveLength(2);
    expect(backendBody?.body).toContain("Role of backend");
    expect(coordination.getCoordination(id)?.reconciledAt).toBeDefined();

    // The parent effort is one related run in the dashboard data.
    const parent = runs.getRun(effort?.parentRunId as number);
    expect(parent?.status).toBe("succeeded");
    expect(parent?.coordinationId).toBe(id);
    expect(parent?.repo).toBeUndefined();
  });

  test("unplannable tasks are skipped safely before any mutation", async () => {
    planFor = () => {
      plannerInvocations += 1;
      return { ok: false, errors: ['Repository "?" is not configured in the workspace.'] };
    };
    const skips: string[] = [];
    const deps = makeDeps({ recordSkip: (reason: string) => skips.push(reason) });

    const handled = await runCoordinatedTask(
      deps,
      { taskKey: "DEV-10", candidates: ["backend", "frontend"] },
      ["backend", "frontend"],
    );

    expect(handled).toBe(true);
    expect(skips).toEqual(["unplanned"]);
    expect(plannerInvocations).toBe(1); // planner ran but produced garbage
    expect(calls).toHaveLength(0); // no repo was touched
    expect(coordination.latestForTask("DEV-10")).toBeNull(); // nothing persisted
  });

  test("a failed repository blocks its dependents and stays resumable", async () => {
    behavior = (repo) => repo !== "shared-config"; // prerequisite fails
    const deps = makeDeps();

    const handled = await runCoordinatedTask(deps, { taskKey: "DEV-11", candidates: [] }, []);
    expect(handled).toBe(true);

    const effort = coordination.latestForTask("DEV-11");
    expect(effort?.status).toBe("partial_failure");
    const id = effort?.coordinationId as string;
    expect(coordination.getRun(id, "shared-config")?.status).toBe("failed");
    const backendRow = coordination.getRun(id, "backend");
    expect(backendRow?.status).toBe("blocked");
    expect(backendRow?.reason).toContain('prerequisite "shared-config"');
    expect(calls.map((call) => call.repo)).toEqual(["shared-config"]); // dependent never ran
    expect(bodyUpdates).toHaveLength(0); // no sibling reconciliation with <2 PRs

    const parent = runs.getRun(effort?.parentRunId as number);
    expect(parent?.status).toBe("failed");
  });

  test("resume retries only unfinished repositories without duplicating completed work", async () => {
    let backendAttempts = 0;
    behavior = (repo) => {
      if (repo === "shared-config") {
        return true; // completed on the first pass, never touched again
      }
      backendAttempts += 1;
      return backendAttempts > 1; // backend fails on its first attempt only
    };
    const deps = makeDeps();

    await runCoordinatedTask(deps, { taskKey: "DEV-12", candidates: [] }, []);
    const effort = coordination.latestForTask("DEV-12");
    const id = effort?.coordinationId as string;
    const firstBranches = calls.map((call) => call.env.DEVINTERN_FEATURE_BRANCH);
    expect(calls.map((call) => call.repo)).toEqual(["shared-config", "backend"]);

    // Resume: same coordination ID, no re-planning, completed repo untouched.
    await runCoordinatedTask(deps, { taskKey: "DEV-12", candidates: [] }, []);
    expect(plannerInvocations).toBe(1);
    expect(backendAttempts).toBe(2); // failed repo was retried exactly once
    const resumedCalls = calls.slice(2);
    expect(resumedCalls.map((call) => call.repo)).toEqual(["backend"]);
    expect(resumedCalls[0]?.env.DEVINTERN_COORDINATION_ID).toBe(id);
    expect(resumedCalls[0]?.env.DEVINTERN_FEATURE_BRANCH).toBe(firstBranches[1]);
    expect(resumedCalls[0]?.env.DEVINTERN_FEATURE_BRANCH).toBe(`task/${id}`);

    expect(coordination.latestForTask("DEV-12")?.status).toBe("completed");
    expect(coordination.getRun(id, "backend")?.status).toBe("succeeded");
  });

  test("repositories with no required diff are skipped while dependents proceed", async () => {
    noDiffRepo = "shared-config"; // agent produces no changes for this repo
    planFor = (input) => {
      void input;
      plannerInvocations += 1;
      return {
        ok: true,
        entries: [
          { repo: "shared-config", rationale: "maybe", change: "maybe", dependencies: [] },
          { repo: "backend", rationale: "independent", change: "work", dependencies: [] },
        ],
        executionOrder: ["shared-config", "backend"],
      };
    };

    await runCoordinatedTask(makeDeps(), { taskKey: "DEV-13", candidates: [] }, []);

    const effort = coordination.latestForTask("DEV-13");
    const id = effort?.coordinationId as string;
    const sharedRow = coordination.getRun(id, "shared-config");
    expect(sharedRow?.status).toBe("skipped");
    expect(sharedRow?.reason).toBeTruthy();
    // Dependent visibility preserved and the effort still completes.
    expect(coordination.getRun(id, "backend")?.status).toBe("succeeded");
    expect(coordination.latestForTask("DEV-13")?.status).toBe("completed");
  });

  test("a busy repository lock leaves the effort pending and reports not-handled", async () => {
    const { LockManager } = await import("../src/lib/lock-manager");
    mkdirSync(join(dir, "locks"), { recursive: true });
    const busyLock = new LockManager(join(dir, "locks"), "backend.run.lock", { plainDir: true });
    expect(busyLock.acquire().success).toBe(true);

    const handled = await runCoordinatedTask(makeDeps(), { taskKey: "DEV-14", candidates: [] }, []);
    expect(handled).toBe(false);

    const effort = coordination.latestForTask("DEV-14");
    const id = effort?.coordinationId as string;
    // Prerequisite finished; the blocked-on-lock repo waits as pending.
    expect(coordination.getRun(id, "shared-config")?.status).toBe("succeeded");
    expect(coordination.getRun(id, "backend")?.status).toBe("pending");

    busyLock.release();
  });

  test("reconciliation failures are recoverable and retryable independently", async () => {
    behavior = () => true;
    reconciliationFailuresFor = new Set(["acme/backend"]);
    const deps = makeDeps();

    await runCoordinatedTask(deps, { taskKey: "DEV-15", candidates: [] }, []);

    const effort = coordination.latestForTask("DEV-15");
    const id = effort?.coordinationId as string;
    // Implementation still completed even though one body update failed...
    expect(effort?.status).toBe("completed");
    expect(coordination.getCoordination(id)?.reconciledAt).toBeUndefined();

    // ...and the description update can be retried on its own (idempotent
    // refresh of every sibling body).
    reconciliationFailuresFor = new Set();
    bodyUpdates = [];
    const failedRepos = await reconcileCoordinatedPrs(
      { store: coordination, config: CONFIG, github: deps.github! },
      id,
    );
    expect(failedRepos).toEqual([]);
    expect(bodyUpdates.map((update) => update.slug).sort()).toEqual([
      "acme/backend",
      "acme/shared-config",
    ]);
    expect(coordination.getCoordination(id)?.reconciledAt).toBeDefined();
  });
});

describe("PR coordination section rendering", () => {
  const sectionOptions = {
    coordinationId: "dev-9-x1y2z3",
    taskKey: "DEV-9",
    entry: {
      repo: "backend",
      rationale: "implements the endpoint",
      change: "add POST /flags",
      dependencies: ["shared-config"],
    },
    siblings: [
      { repo: "shared-config", prUrl: "https://github.com/acme/shared-config/pull/7" },
      { repo: "backend", prUrl: "https://github.com/acme/backend/pull/9" },
      { repo: "frontend" },
    ],
  };

  test("includes role, dependency context, coordination id, and sibling links", () => {
    const section = buildCoordinationSection(sectionOptions);
    expect(section).toContain("<!-- devintern-coordination:dev-9-x1y2z3 -->");
    expect(section).toContain("<!-- /devintern-coordination:dev-9-x1y2z3 -->");
    expect(section).toContain("**Role of backend:** implements the endpoint");
    expect(section).toContain("[shared-config](https://github.com/acme/shared-config/pull/7)");
    expect(section).toContain("- frontend: (PR pending)");
    expect(section).toContain("coordinated effort `dev-9-x1y2z3`");
  });

  test("applyCoordinationSection replaces an existing marked block instead of appending", () => {
    const initial = buildCoordinationSection(sectionOptions); // pre-creation footer
    const updatedSection = buildCoordinationSection({
      ...sectionOptions,
      siblings: [
        { repo: "shared-config", prUrl: "https://github.com/acme/shared-config/pull/7" },
        { repo: "backend", prUrl: "https://github.com/acme/backend/pull/9" },
        { repo: "frontend", prUrl: "https://github.com/acme/frontend/pull/4" },
      ],
    });
    const updated = applyCoordinationSection(`Base\n\n${initial}`, updatedSection, "dev-9-x1y2z3");
    expect(updated.startsWith("Base")).toBe(true);
    expect(updated).toContain("acme/frontend/pull/4"); // refreshed sibling set
    expect(updated.match(/devintern-coordination:dev-9-x1y2z3/g)).toHaveLength(2); // open+close only

    // Appends when the body never carried the section.
    expect(applyCoordinationSection(null, "S", "dev-9-x1y2z3")).toBe("S");
    expect(applyCoordinationSection("Body.", "S", "dev-9-x1y2z3").endsWith("S")).toBe(true);
  });
});
