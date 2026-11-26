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
import type { StackHost } from "../dependencies/stack-maintainer";
import { STACK_NOTICE_MARKER, StackMaintainer } from "../dependencies/stack-maintainer";
import { createGitStack } from "../dependencies/stack-git";
import { parseStackPr } from "../dependencies/stack-pr-snapshot";
import type { GitHubPrPayload } from "../dependencies/stack-pr-snapshot";
import type { InjectedTaskStore } from "../state/injected-tasks";
import { RunStore } from "../state/run-recorder";
import { Utils } from "../utils";
import type { Acquirer } from "../../worker";
import type { WorkspaceConfig } from "./config";
import { repoGitHubSlug } from "./env";
import { workspaceDbPath } from "./paths";
import {
  createFleetGitHubClientResolver,
  resolveFleetGitHubHosting,
} from "./fleet-event-acquirers";
import type { RepoManager } from "./repo-manager";

export { parseStackPr };

type GitHubClient = import("../code-host/github/reviews").GitHubReviewsClient;

/** Default seconds between stacked-PR passes (`WORKER_STACKED_PRS_INTERVAL_SECONDS`). */
export const DEFAULT_STACKED_PR_INTERVAL_SECONDS = 60;

/** The GitHub `owner/name` of a workspace repo, if it has one. */
function slugOf(config: WorkspaceConfig, repoName: string): string | undefined {
  const repo = config.repos.find((candidate) => candidate.name === repoName);
  return repo ? repoGitHubSlug(repo) : undefined;
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

/**
 * Whether an agent run (review follow-up, CI fix, base sync) is in progress on
 * a workspace repo's PR. Those runs record the GitHub slug, PR number and
 * branch but no task key, so they are matched on those.
 */
export function createPrBusyChecker(
  config: WorkspaceConfig,
  runStore: Pick<RunStore, "listRuns">,
): (repo: string, prNumber: number, branch: string) => boolean {
  return (repo, prNumber, branch) => {
    const names = new Set([repo.toLowerCase()]);
    const slug = slugOf(config, repo);
    if (slug) names.add(slug.toLowerCase());
    return runStore
      .listRuns({ status: "in_progress", limit: 1000 })
      .some(
        (run) =>
          run.repo !== undefined &&
          names.has(run.repo.toLowerCase()) &&
          (run.prNumber === prNumber || run.branch === branch),
      );
  };
}

/**
 * The head SHA of `origin/<branch>` in a repo's bare clone, fetched first so
 * it matches what a run starting now branches from; `null` when absent.
 */
export async function remoteHead(
  config: WorkspaceConfig,
  repoManager: Pick<RepoManager, "ensureBareClone" | "fetch">,
  repoName: string,
  branch: string,
): Promise<string | null> {
  const repo = config.repos.find((candidate) => candidate.name === repoName);
  if (!repo) return null;
  const clonePath = await repoManager.ensureBareClone(repo);
  await repoManager.fetch(repo.name);
  const result = await Utils.executeGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`],
    { cwd: clonePath },
  );
  return result.success ? result.output.trim() || null : null;
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

/**
 * GitHub client resolver for stacked-PR maintenance. Resolves the relay
 * hosting itself (`token-only` when the relay hosts the App, else
 * `app-first`) instead of reading the env override, which the fleet event
 * wiring only sets after this acquirer is built.
 */
export async function createStackedPrGitHubResolver(
  config: WorkspaceConfig,
  workspaceDir: string,
  Client?: typeof import("../code-host/github/reviews").GitHubReviewsClient,
): Promise<(slug: string) => GitHubClient> {
  const { usesHostedApp } = await resolveFleetGitHubHosting(workspaceDir);
  const ClientClass = Client ?? (await import("../code-host/github/reviews")).GitHubReviewsClient;
  return createFleetGitHubClientResolver(config, workspaceDir, usesHostedApp, ClientClass);
}

/** Build the fleet stacked-PR acquirer. */
export async function buildStackedPrAcquirer(options: {
  config: WorkspaceConfig;
  workspaceDir: string;
  store: InjectedTaskStore;
  /** Run registry for the busy check; defaults to the workspace DB. */
  runStore?: Pick<RunStore, "listRuns">;
  repoManager: RepoManager;
}): Promise<StackedPrAcquirer> {
  const { config, workspaceDir, store, repoManager } = options;
  const runStore = options.runStore ?? new RunStore(workspaceDbPath(workspaceDir));
  const gh = await createStackedPrGitHubResolver(config, workspaceDir);
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
    isPrBusy: createPrBusyChecker(config, runStore),
  });
  return new StackedPrAcquirer(
    maintainer,
    parseEnvInteger("WORKER_STACKED_PRS_INTERVAL_SECONDS", DEFAULT_STACKED_PR_INTERVAL_SECONDS, {
      min: 5,
    }),
    () => store.isClosed(),
  );
}
