import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import {
  coalescePrFeedbackRuns,
  createFleetAddressPr,
  createFleetMentionHandler,
  createFleetResolveConflicts,
  createFleetTaskEvaluator,
  fleetGitHubSlugs,
  repoBySlug,
} from "../src/lib/workspace/fleet-events";
import { createFleetTaskExecutor } from "../src/lib/workspace/workspace-worker";
import type { RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { createRepoRunLock, openWorkspaceState } from "../src/lib/workspace/state";
import type { WorkspaceState } from "../src/lib/workspace/state";

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
    const path = join(this.root, "worktrees", repo.name, "base");
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
  const resolutions: Array<{
    slug: string;
    prNumber: number;
    cwd?: string;
    expectedHeadSha?: string;
    expectedBaseSha?: string;
  }> = [];

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
    runResolve: async (
      slug: string,
      prNumber: number,
      opts: {
        cwd?: string;
        env?: Record<string, string | undefined>;
        expectedHeadSha?: string;
        expectedBaseSha?: string;
      } = {},
    ) => {
      resolutions.push({
        slug,
        prNumber,
        cwd: opts.cwd,
        expectedHeadSha: opts.expectedHeadSha,
        expectedBaseSha: opts.expectedBaseSha,
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
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("addressPr runs the review from the repo's base worktree with its env", async () => {
    const addressPr = createFleetAddressPr(deps());
    const ok = await addressPr("acme/backend", 42);

    expect(ok).toBe(true);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].cwd).toBe(join(workspaceDir, "worktrees", "backend", "base"));
    expect(reviews[0].env.GITHUB_REPO).toBe("acme/backend");
    expect(repoManager.calls).toContain("fetch:backend");
  });

  test("addressPr skips slugs outside the workspace", async () => {
    const addressPr = createFleetAddressPr(deps());
    expect(await addressPr("acme/unknown", 7)).toBe(false);
    expect(reviews).toHaveLength(0);
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
        cwd: join(workspaceDir, "worktrees", "backend", "base"),
        expectedHeadSha: "head1",
        expectedBaseSha: "base1",
      },
    ]);
    expect(repoManager.calls).toContain("fetch:backend");
  });

  test("mention handler gates on push access and fails closed", async () => {
    const handle = createFleetMentionHandler(deps());

    pushAccess = false;
    await handle("acme/backend", { user: { login: "driveby" } }, 5);
    expect(reviews).toHaveLength(0);

    pushAccess = new Error("api down");
    await handle("acme/backend", { user: { login: "maintainer" } }, 5);
    expect(reviews).toHaveLength(0);

    pushAccess = true;
    await handle("acme/backend", { user: { login: "maintainer" } }, 5);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].prNumber).toBe(5);
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
      repoLock: (name) => createRepoRunLock(name, workspaceDir),
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
});
