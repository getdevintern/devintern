/**
 * Fleet wiring for stacked PR maintenance (`dependencies/stack-maintainer.ts`):
 * a polling acquirer, the GitHub adapter, and the git checkout the restack
 * runs in (a disposable worktree of the repo's bare clone).
 *
 * GitHub only: repos without a GitHub slug (GitLab, Bitbucket) are skipped,
 * so their stacked PRs keep their base until a human retargets them.
 */

import { startFirstTickInBackground } from "../acquirers/background-tick";
import { parseEnvInteger } from "../config/env-integer";
import type { StackHost, StackPrSnapshot } from "../dependencies/stack-maintainer";
import { STACK_NOTICE_MARKER, StackMaintainer } from "../dependencies/stack-maintainer";
import { createGitStack } from "../dependencies/stack-git";
import type { InjectedTaskStore } from "../state/injected-tasks";
import type { RunStore } from "../state/run-recorder";
import type { Acquirer } from "../../worker";
import type { WorkspaceConfig } from "./config";
import { gitHubSlugFromRemote } from "./env";
import { createFleetGitHubClientResolver } from "./fleet-event-acquirers";
import type { RepoManager } from "./repo-manager";

type GitHubClient = import("../code-host/github/reviews").GitHubReviewsClient;

/** Default seconds between stacked-PR passes (`WORKER_STACKED_PRS_INTERVAL_SECONDS`). */
export const DEFAULT_STACKED_PR_INTERVAL_SECONDS = 60;

/** The GitHub `owner/name` of a workspace repo, if it has one. */
function slugOf(config: WorkspaceConfig, repoName: string): string | undefined {
  const repo = config.repos.find((candidate) => candidate.name === repoName);
  return repo ? (repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote)) : undefined;
}

/** GitHub single-PR payload fields the adapter reads (untrusted). */
interface GitHubPrPayload {
  state?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown; sha?: unknown };
  base?: { ref?: unknown };
}

/** Parse a GitHub PR payload into a {@link StackPrSnapshot}; `null` when unusable. */
export function parseStackPr(number: number, data: GitHubPrPayload): StackPrSnapshot | null {
  const headRef = data.head?.ref;
  const headSha = data.head?.sha;
  const baseRef = data.base?.ref;
  if (typeof headRef !== "string" || typeof headSha !== "string" || typeof baseRef !== "string") {
    return null;
  }
  let state: StackPrSnapshot["state"];
  if (data.state === "open") {
    state = "open";
  } else if (data.state === "closed") {
    const merged =
      data.merged === true || (typeof data.merged_at === "string" && data.merged_at !== "");
    if (!merged && data.merged !== false) return null;
    state = merged ? "merged" : "closed";
  } else {
    return null;
  }
  return {
    number,
    state,
    headRef,
    headSha,
    baseRef,
    url: typeof data.html_url === "string" ? data.html_url : undefined,
  };
}

/** {@link StackHost} for GitHub repos, with ETag-cached PR reads. */
export function createGitHubStackHost(
  config: WorkspaceConfig,
  gh: (slug: string) => GitHubClient,
): StackHost {
  const cache = new Map<string, { etag?: string; data: GitHubPrPayload }>();
  const target = (repo: string): { slug: string; owner: string; name: string } | null => {
    const slug = slugOf(config, repo);
    if (!slug) return null;
    const [owner = "", name = ""] = slug.split("/");
    return { slug, owner, name };
  };
  return {
    async getPr(repo, prNumber) {
      const t = target(repo);
      if (!t) return null;
      const key = `${t.slug}#${prNumber}`;
      const cached = cache.get(key);
      const result = await gh(t.slug).conditionalGet<GitHubPrPayload>(
        `/repos/${t.slug}/pulls/${prNumber}`,
        t.owner,
        t.name,
        cached?.etag,
      );
      const data = result.notModified ? cached?.data : result.data;
      if (!data) return null;
      if (!result.notModified) cache.set(key, { etag: result.etag, data });
      return parseStackPr(prNumber, data);
    },
    async retarget(repo, prNumber, base) {
      const t = target(repo);
      if (!t) throw new Error(`repo ${repo} has no GitHub slug`);
      await gh(t.slug).updatePullRequestBase(t.owner, t.name, prNumber, base);
      cache.delete(`${t.slug}#${prNumber}`);
    },
    async postNotice(repo, prNumber, body) {
      const t = target(repo);
      if (!t) throw new Error(`repo ${repo} has no GitHub slug`);
      await gh(t.slug).upsertMarkedIssueComment(
        t.owner,
        t.name,
        prNumber,
        STACK_NOTICE_MARKER,
        body,
      );
    },
  };
}

/**
 * Whether a GitHub repo's branch is the branch some stacked task builds on,
 * per the injected-task registry (the auto-merge guard's second source).
 */
export function createStackedBaseChecker(
  config: WorkspaceConfig,
  store: Pick<InjectedTaskStore, "isClosed" | "listStackedLinks" | "dependencyFacts">,
): (slug: string, baseRef: string) => boolean {
  return (slug, baseRef) => {
    if (store.isClosed()) return false;
    const links = store
      .listStackedLinks()
      .filter((link) => slugOf(config, link.repo)?.toLowerCase() === slug.toLowerCase());
    if (links.length === 0) return false;
    return store
      .dependencyFacts(links.map((link) => link.stackedOn))
      .some((facts) => (facts.pr?.branch ?? facts.latestRun?.branch) === baseRef);
  };
}

/** Polls stacked links and runs one {@link StackMaintainer} pass per tick. */
export class StackedPrAcquirer implements Acquirer {
  readonly name = "poll:stacked-prs";
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly maintainer: Pick<StackMaintainer, "tick">,
    private readonly intervalSeconds: number,
    private readonly isClosed: () => boolean = () => false,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    startFirstTickInBackground(this.name, () => this.tick());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy || this.isClosed()) return;
    this.busy = true;
    try {
      await this.maintainer.tick();
    } catch (error) {
      console.warn(`⚠️  [${this.name}] pass failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

/** Build the fleet stacked-PR acquirer. */
export async function buildStackedPrAcquirer(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  store: InjectedTaskStore;
  runStore: Pick<RunStore, "latestRunByTaskKey" | "finishRun">;
  repoManager: RepoManager;
}): Promise<StackedPrAcquirer> {
  const { config, workspaceDir, store, runStore, repoManager } = options;
  const { GITHUB_AUTH_MODE_ENV, GitHubReviewsClient } = await import("../code-host/github/reviews");
  const gh = createFleetGitHubClientResolver(
    config,
    workspaceDir,
    process.env[GITHUB_AUTH_MODE_ENV] === "token-only",
    GitHubReviewsClient,
  );
  const maintainer = new StackMaintainer({
    store,
    host: createGitHubStackHost(config, gh),
    git: createGitStack({
      checkout: async (repoName) => {
        const repo = config.repos.find((candidate) => candidate.name === repoName);
        if (!repo) throw new Error(`unknown repo ${repoName}`);
        await repoManager.ensureBareClone(repo);
        await repoManager.fetch(repo.name);
        const cwd = await repoManager.createTaskWorktree(repo, "restack");
        return { cwd, release: () => repoManager.removeTaskWorktree(repo.name, cwd) };
      },
    }),
    escalate: (taskKey, reason) => {
      const run = runStore.latestRunByTaskKey([taskKey]).get(taskKey);
      if (run && run.status === "succeeded") runStore.finishRun(run.id, "escalated", reason);
    },
  });
  return new StackedPrAcquirer(
    maintainer,
    parseEnvInteger("WORKER_STACKED_PRS_INTERVAL_SECONDS", DEFAULT_STACKED_PR_INTERVAL_SECONDS, {
      min: 5,
    }),
    () => store.isClosed(),
  );
}
