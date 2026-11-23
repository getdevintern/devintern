import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { autoMergeCliArgs } from "../src/lib/acquirers/auto-merge-cli";
import type { AutoMergePolicy } from "../src/lib/review/auto-merge";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import {
  coalescePrFeedbackRuns,
  createFleetAddressPr,
  createFleetCiFix,
  createFleetMentionHandler,
  createFleetResolveConflicts,
  createFleetTaskEvaluator,
  createFleetAutoMerge,
  fleetAutoMergePolicyFingerprint,
  fleetGitHubSlugs,
  repoBySlug,
} from "../src/lib/workspace/fleet-events";
import { createFleetTaskExecutor } from "../src/lib/workspace/workspace-worker";
import type { RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";
import { createTaskSupervisor } from "../src/lib/worker/supervisor";

const CONFIG = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "mirror"
remote = "https://internal.example.com/mirror.git"
  [repos.env]
  GITHUB_REPO = "acme/mirror"

[[repos]]
name = "internal"
remote = "git@bitbucket.org:acme/internal.git"

[[routing.rules]]
repo = "backend"
labels = ["backend"]
`);

class FakeRepoManager implements RepoManagerLike {
  calls: string[] = [];
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  async ensureBareClone(repo: RepoConfig): Promise<string> {
    this.calls.push(`clone:${repo.name}`);
    return join(this.root, "repos", `${repo.name}.git`);
  }

  async fetch(repoName: string): Promise<void> {
    this.calls.push(`fetch:${repoName}`);
  }

  async ensureBaseWorktree(repo: RepoConfig): Promise<string> {
    this.calls.push(`base:${repo.name}`);
    const path = join(this.root, "worktrees", repo.name, "base");
    mkdirSync(path, { recursive: true });
    return path;
  }

  async ensurePrJobWorktree(repo: RepoConfig): Promise<string> {
    this.calls.push(`pr-jobs:${repo.name}`);
    const path = join(this.root, "worktrees", repo.name, "pr-jobs");
    mkdirSync(path, { recursive: true });
    return path;
  }

  async createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string> {
    const path = join(this.root, "worktrees", repo.name, taskKey.toLowerCase());
    mkdirSync(path, { recursive: true });
    return path;
  }

  async removeTaskWorktree(_repoName: string, worktreePath: string): Promise<void> {
    rmSync(worktreePath, { recursive: true, force: true });
  }

  async sweepStaleWorktrees(): Promise<string[]> {
    return [];
  }
}

describe("repo slug resolution", () => {
  test("repoBySlug prefers explicit GITHUB_REPO and falls back to the remote", () => {
    expect(repoBySlug(CONFIG, "acme/backend")?.name).toBe("backend");
    expect(repoBySlug(CONFIG, "ACME/Backend")?.name).toBe("backend");
    expect(repoBySlug(CONFIG, "acme/mirror")?.name).toBe("mirror");
    expect(repoBySlug(CONFIG, "acme/internal")).toBeUndefined();
  });

  test("fleetGitHubSlugs lists GitHub-reachable repos only", () => {
    expect(fleetGitHubSlugs(CONFIG).sort()).toEqual(["acme/backend", "acme/mirror"]);
  });
});

describe("fleet event handlers", () => {
  let workspaceDir: string;
  let repoManager: FakeRepoManager;
  let reviews: Array<{
    slug: string;
    prNumber: number;
    cwd: string;
    env: Record<string, string | undefined>;
  }>;
  let pushAccess: boolean | Error;
  const ciFixes: Array<{ slug: string; prNumber: number; feedbackPath: string; cwd: string }> = [];
  const resolutions: Array<{
    slug: string;
    prNumber: number;
    cwd?: string;
    expectedHeadSha?: string;
    expectedBaseSha?: string;
  }> = [];
  const resolveAgents: Array<Record<string, string | undefined>> = [];

  const deps = () => ({
    config: CONFIG,
    workspaceDir,
    repoManager,
    userHasPushAccess: async () => {
      if (pushAccess instanceof Error) {
        throw pushAccess;
      }
      return pushAccess;
    },
    runReview: async (
      slug: string,
      prNumber: number,
      opts: { cwd: string; env: Record<string, string | undefined> },
    ) => {
      reviews.push({ slug, prNumber, cwd: opts.cwd, env: opts.env });
      return true;
    },
    runCiFix: async (
      slug: string,
      prNumber: number,
      feedbackPath: string,
      opts: { cwd: string },
    ) => {
      ciFixes.push({ slug, prNumber, feedbackPath, cwd: opts.cwd });
      return true;
    },
    runResolve: async (
      slug: string,
      prNumber: number,
      opts: {
        cwd?: string;
        env?: Record<string, string | undefined>;
        expectedHeadSha?: string;
        expectedBaseSha?: string;
        harnessPin?: string;
      } = {},
    ) => {
      resolutions.push({
        slug,
        prNumber,
        cwd: opts.cwd,
        expectedHeadSha: opts.expectedHeadSha,
        expectedBaseSha: opts.expectedBaseSha,
      });
      resolveAgents.push({
        harnessPin: opts.harnessPin,
        harness: opts.env?.AGENT_HARNESS,
        model: opts.env?.AGENT_MODEL,
        effort: opts.env?.AGENT_EFFORT,
      });
      return { outcome: "clean" as const, message: "merged" };
    },
  });

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `fleet-ev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    repoManager = new FakeRepoManager(workspaceDir);
    reviews = [];
    pushAccess = true;
    resolutions.length = 0;
    resolveAgents.length = 0;
    ciFixes.length = 0;
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("addressPr runs the review from the repo's PR-job checkout with its env", async () => {
    const addressPr = createFleetAddressPr(deps());
    const ok = await addressPr("acme/backend", 42);

    expect(ok).toBe(true);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].cwd).toBe(join(workspaceDir, "worktrees", "backend", "pr-jobs"));
    expect(reviews[0].env.GITHUB_REPO).toBe("acme/backend");
    expect(repoManager.calls).toContain("fetch:backend");
  });

  test("addressPr skips slugs outside the workspace", async () => {
    const addressPr = createFleetAddressPr(deps());
    expect(await addressPr("acme/unknown", 7)).toBe(false);
    expect(reviews).toHaveLength(0);
  });

  test("reviews of different PRs share the per-repo budget with task worktrees", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 3, maxConcurrencyPerRepo: 2 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let bothStarted!: () => void;
    const bothRunning = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const started: string[] = [];
    const addressPr = createFleetAddressPr({
      ...deps(),
      supervisor,
      runReview: async (_slug, prNumber) => {
        started.push(`review-${prNumber}`);
        if (started.length === 2) bothStarted();
        await (prNumber === 1 ? firstGate : secondGate);
        return true;
      },
    });

    const first = addressPr("acme/backend", 1);
    const second = addressPr("acme/backend", 2);
    await bothRunning;
    const task = supervisor.schedule({
      id: "task",
      source: "test",
      repo: "backend",
      kind: "task",
      checkoutClass: "task_worktree",
      run: async () => started.push("task"),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Two PR jobs fill max_concurrency_per_repo = 2; the task waits.
    expect(started).toEqual(["review-1", "review-2"]);
    expect(supervisor.queuedJobs?.()).toMatchObject([{ id: "task", waitingOn: "repo" }]);
    releaseFirst();
    await task;
    expect(started).toEqual(["review-1", "review-2", "task"]);
    releaseSecond();
    await Promise.all([first, second]);
  });

  test("two jobs on the same PR run one after another without holding a slot", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 3, maxConcurrencyPerRepo: 2 });
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let reviewStarted!: () => void;
    const reviewRunning = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    const started: string[] = [];
    const addressPr = createFleetAddressPr({
      ...deps(),
      supervisor,
      runReview: async () => {
        started.push("review");
        reviewStarted();
        await reviewGate;
        return true;
      },
    });
    const fix = createFleetCiFix({
      ...deps(),
      supervisor,
      runCiFix: async () => {
        started.push("ci-fix");
        return true;
      },
    });
    const review = addressPr("acme/backend", 7);
    await reviewRunning;
    const ciFix = fix("acme/backend", 7, "/tmp/ci-feedback.json");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["review"]);
    expect(supervisor.inFlightCount()).toBe(1);
    expect(supervisor.queuedJobs?.()).toMatchObject([
      { label: "acme/backend#7", exclusiveKey: "acme/backend#7", waitingOn: "exclusive" },
    ]);
    releaseReview();
    await Promise.all([review, ciFix]);
    expect(started).toEqual(["review", "ci-fix"]);
  });

  test("CI fixes run from the matching repo's PR-job checkout", async () => {
    const fix = createFleetCiFix(deps());
    expect(await fix("acme/backend", 42, "/tmp/ci-feedback.json")).toBe(true);
    // PR jobs never touch the base checkout an automation may be using.
    expect(repoManager.calls).toContain("pr-jobs:backend");
    expect(repoManager.calls.some((call) => call.startsWith("base:"))).toBe(false);
    expect(ciFixes).toEqual([
      {
        slug: "acme/backend",
        prNumber: 42,
        feedbackPath: "/tmp/ci-feedback.json",
        cwd: join(workspaceDir, "worktrees", "backend", "pr-jobs"),
      },
    ]);
  });

  test("a queued CI fix reports deferred when shutdown prevents admission", async () => {
    const supervisor = createTaskSupervisor({ maxConcurrency: 1, maxConcurrencyPerRepo: 1 });
    await supervisor.drain({ graceMs: 0 });
    const fix = createFleetCiFix({ ...deps(), supervisor });

    expect(await fix("acme/backend", 42, "/tmp/ci-feedback.json")).toBe("deferred");
    expect(ciFixes).toHaveLength(0);
  });

  test("coalesces overlapping feedback events into one follow-up reconciliation", async () => {
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const addressPr = coalescePrFeedbackRuns(async () => {
      calls++;
      if (calls === 1) await firstRun;
      return true;
    });

    const relay = addressPr("acme/backend", 42);
    const reviewPoll = addressPr("ACME/backend", 42);
    const mentionPoll = addressPr("acme/backend", 42);
    expect(calls).toBe(1);

    releaseFirst();
    expect(await Promise.all([relay, reviewPoll, mentionPoll])).toEqual([true, true, true]);
    expect(calls).toBe(2);
  });

  test("base sync uses the fleet repo worktree and forwards expected SHAs", async () => {
    const resolve = createFleetResolveConflicts(deps());
    const result = await resolve("acme/backend", 42, {
      headSha: "head1",
      baseSha: "base1",
    });

    expect(result.outcome).toBe("clean");
    expect(resolutions).toEqual([
      {
        slug: "acme/backend",
        prNumber: 42,
        cwd: join(workspaceDir, "worktrees", "backend", "pr-jobs"),
        expectedHeadSha: "head1",
        expectedBaseSha: "base1",
      },
    ]);
    expect(repoManager.calls).toContain("fetch:backend");
  });

  test("base sync runs on the configured conflict-resolution agent", async () => {
    const previous = CONFIG.workspace.conflictAgent;
    // Mutated in place like a live reload; read at run time.
    CONFIG.workspace.conflictAgent = { harness: "claude-code", model: "sonnet", effort: "low" };
    try {
      const resolve = createFleetResolveConflicts(deps());
      await resolve("acme/backend", 42, { headSha: "head1", baseSha: "base1" });
    } finally {
      CONFIG.workspace.conflictAgent = previous;
    }
    expect(resolveAgents.at(-1)).toEqual({
      harnessPin: "claude-code",
      harness: "claude-code",
      model: "sonnet",
      effort: "low",
    });
  });

  test("mention handler skips a confirmed denial and runs for push access", async () => {
    const handle = createFleetMentionHandler(deps());

    pushAccess = false;
    expect(await handle("acme/backend", { user: { login: "driveby" } }, 5)).toBe("skipped");
    expect(reviews).toHaveLength(0);

    pushAccess = true;
    expect(await handle("acme/backend", { user: { login: "maintainer" } }, 5)).toBe(true);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].prNumber).toBe(5);
  });

  test("mention handler propagates permission API errors instead of denying", async () => {
    const handle = createFleetMentionHandler(deps());

    pushAccess = new Error("GitHub API 502");
    await expect(handle("acme/backend", { user: { login: "maintainer" } }, 5)).rejects.toThrow(
      "GitHub API 502",
    );
    expect(reviews).toHaveLength(0);
  });
});

describe("fleet auto-merge review policy", () => {
  const workspace = (extra: string, repoExtra = "") =>
    parseWorkspaceConfig(`
[workspace]
auto_merge = true
${extra}

[defaults]
tracker = "markdown"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
${repoExtra}
`);

  test("the fingerprint ignores the default policy but changes with policy or instructions", () => {
    const fingerprint = (extra: string, repoExtra?: string) =>
      fleetAutoMergePolicyFingerprint(workspace(extra, repoExtra), "acme/backend", "/ws");
    const base = fingerprint("");
    expect(fingerprint('auto_merge_policy = "strict"')).toBe(base);
    const standard = fingerprint('auto_merge_policy = "standard"');
    expect(standard).not.toBe(base);
    expect(fingerprint("", 'auto_merge_policy = "standard"')).toBe(standard);
    expect(fingerprint('auto_merge_review_instructions = "keep billing/ manual"')).not.toBe(base);
    // Review paths re-check held PRs, and an empty list hashes like none at all.
    expect(fingerprint("auto_merge_review_paths = []")).toBe(base);
    const review = fingerprint('auto_merge_review_paths = ["**/AGENTS.md"]');
    expect(review).not.toBe(base);
    expect(fingerprint("", 'auto_merge_review_paths = ["**/AGENTS.md"]')).toBe(review);
  });

  test("the runner passes the repo's review paths to the CLI", async () => {
    const root = join(tmpdir(), `fleet-auto-merge-review-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const config = workspace(
      'auto_merge_review_paths = ["**/AGENTS.md"]',
      'auto_merge_review_paths = ["**/skills/**"]',
    );
    const policies: unknown[] = [];
    const run = createFleetAutoMerge({
      config,
      workspaceDir: root,
      repoManager: new FakeRepoManager(root),
      userHasPushAccess: async () => true,
      runAutoMerge: async (_slug, _pr, opts) => {
        policies.push(opts.policy);
        return { outcome: "waiting", message: "stub", reviewed: false };
      },
    });
    await run("acme/backend", 1, "a".repeat(40));
    // Hot reload picks up the workspace list once the repo override is gone.
    config.repos = workspace("").repos;
    await run("acme/backend", 1, "a".repeat(40));
    expect(policies).toMatchObject([
      { reviewPaths: ["**/skills/**"] },
      { reviewPaths: ["**/AGENTS.md"] },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("the runner passes the repo's live policy and instructions to the CLI", async () => {
    const root = join(tmpdir(), `fleet-auto-merge-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const config = workspace(
      'auto_merge_policy = "standard"\nauto_merge_review_instructions = "workspace rule"',
      'auto_merge_review_instructions = "repo rule"',
    );
    const policies: unknown[] = [];
    const run = createFleetAutoMerge({
      config,
      workspaceDir: root,
      repoManager: new FakeRepoManager(root),
      userHasPushAccess: async () => true,
      runAutoMerge: async (_slug, _pr, opts) => {
        policies.push(opts.policy);
        return { outcome: "waiting", message: "stub", reviewed: false };
      },
    });
    await run("acme/backend", 1, "a".repeat(40));
    // Hot reload: the runner reads the live config on every run.
    config.workspace = workspace('auto_merge_policy = "strict"').workspace;
    config.repos = workspace("").repos;
    await run("acme/backend", 1, "a".repeat(40));
    expect(policies).toMatchObject([
      { reviewPolicy: "standard", reviewInstructions: "repo rule" },
      { reviewPolicy: "strict" },
    ]);
    expect(policies[1]).not.toHaveProperty("reviewInstructions");
    rmSync(root, { recursive: true, force: true });
  });
  test("custom rules: the fingerprint tracks the rules file contents", () => {
    const root = join(tmpdir(), `fleet-auto-merge-rules-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const config = workspace('auto_merge_policy = "custom"\nauto_merge_rules_file = "rules.md"');
    const fingerprint = () => fleetAutoMergePolicyFingerprint(config, "acme/backend", root);
    const missing = fingerprint();
    writeFileSync(join(root, "rules.md"), "Only docs are safe.\n");
    const v1 = fingerprint();
    expect(v1).not.toBe(missing);
    expect(fingerprint()).toBe(v1);
    writeFileSync(join(root, "rules.md"), "Only docs and tests are safe.\n");
    expect(fingerprint()).not.toBe(v1);
    rmSync(root, { recursive: true, force: true });
  });

  test("custom rules come from the workspace home, never the repo checkout", async () => {
    const root = join(tmpdir(), `fleet-auto-merge-local-${process.pid}-${Date.now()}`);
    const workspaceDir = join(root, "home");
    mkdirSync(workspaceDir, { recursive: true });
    const repoManager = new FakeRepoManager(root);
    const config = workspace(
      "",
      'auto_merge_policy = "custom"\nauto_merge_rules_file = "merge-rules.md"',
    );
    const policies: AutoMergePolicy[] = [];
    const run = createFleetAutoMerge({
      config,
      workspaceDir,
      repoManager,
      userHasPushAccess: async () => true,
      runAutoMerge: async (_slug, _pr, opts) => {
        // A same-named file planted in the checkout the CLI runs in.
        mkdirSync(opts.cwd!, { recursive: true });
        writeFileSync(join(opts.cwd!, "merge-rules.md"), "Everything is safe.");
        policies.push(opts.policy);
        return { outcome: "waiting", message: "stub", reviewed: false };
      },
    });
    await run("acme/backend", 1, "a".repeat(40));
    const policy = policies[0]!;
    expect(policy.reviewPolicy).toBe("custom");
    expect(policy.rulesFile).toBe(join(workspaceDir, "merge-rules.md"));
    expect(policy).not.toHaveProperty("rules");
    // The CLI gets the absolute workspace path, so its cwd cannot redirect it.
    const args = autoMergeCliArgs(policy, "a".repeat(40));
    expect(args).toContain(join(workspaceDir, "merge-rules.md"));
    expect(args.some((arg) => arg.startsWith("--rules="))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("createFleetTaskEvaluator", () => {
  let workspaceDir: string;
  let state: WorkspaceState;

  beforeEach(() => {
    workspaceDir = join(
      tmpdir(),
      `fleet-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    state = openWorkspaceState(workspaceDir);
  });

  afterEach(() => {
    state.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("executes only tasks that match the fleet query, with routing applied", async () => {
    const ran: string[] = [];
    const repoManager = new FakeRepoManager(workspaceDir);
    const execute = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      runTask: async (taskKey) => {
        ran.push(taskKey);
        return true;
      },
    });
    const evaluate = createFleetTaskEvaluator({
      query: "status=todo",
      searchTasks: async () => ({ tasks: [{ key: "T-1", labels: ["backend"] }] }),
      execute,
    });

    await evaluate("T-9"); // not in query results
    expect(ran).toHaveLength(0);

    await evaluate("T-1");
    expect(ran).toEqual(["T-1"]);
  });

  test("threads taskRef to the CLI subprocess while the worktree uses the task key", async () => {
    const refs: string[] = [];
    const worktreeKeys: string[] = [];
    const repoManager = new FakeRepoManager(workspaceDir);
    const createWorktree = repoManager.createTaskWorktree.bind(repoManager);
    repoManager.createTaskWorktree = async (repo, taskKey) => {
      worktreeKeys.push(taskKey);
      return createWorktree(repo, taskKey);
    };
    const taskFile = "/ws/injected/local-bump-deps-ab12cd34.md";
    const execute = createFleetTaskExecutor(
      {
        config: CONFIG,
        workspaceDir,
        skips: state.skips,
        repoManager,
        runTask: async (taskRef) => {
          refs.push(taskRef);
          return true;
        },
      },
      { repo: "backend", taskRef: taskFile },
    );

    await execute("local-bump-deps", { key: "local-bump-deps", components: [], labels: [] });

    // The injected task's CLI receives the markdown file path, while the
    // worktree/supervisor label still use the (unique) task key.
    expect(refs).toEqual([taskFile]);
    expect(worktreeKeys).toEqual(["local-bump-deps"]);
  });

  test("a relayed change for an already-actioned ticket is not re-implemented", async () => {
    const ran: string[] = [];
    const repoManager = new FakeRepoManager(workspaceDir);
    const execute = createFleetTaskExecutor({
      config: CONFIG,
      workspaceDir,
      skips: state.skips,
      repoManager,
      runTask: async (taskKey) => {
        ran.push(taskKey);
        return true;
      },
    });
    let actioned = true;
    const evaluate = createFleetTaskEvaluator({
      query: "status=todo",
      searchTasks: async () => ({ tasks: [{ key: "T-1", updated: "u1", labels: ["backend"] }] }),
      execute,
      // Mirrors the polling gate: true while the PR exists and the ticket is
      // unchanged. The relay event can be the worker's own post-PR transition.
      isTaskActionedUnchanged: async () => actioned,
    });

    expect(await evaluate("T-1")).toBe(true);
    expect(ran).toHaveLength(0);

    actioned = false;
    await evaluate("T-1");
    expect(ran).toEqual(["T-1"]);
  });
});
