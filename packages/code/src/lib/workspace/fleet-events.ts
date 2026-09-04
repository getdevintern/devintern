/**
 * Fleet event handling: PR reviews, @mentions, and relay envelopes across
 * every repo in the workspace.
 *
 * The workspace worker has no ambient checkout, so every event run is a CLI
 * subprocess in the repo's persistent base worktree with that repo's composed
 * environment. The permission gate for mention-driven runs
 * (write/maintain/admin, fails closed) therefore lives HERE, before the
 * subprocess: `devintern address-review` is a manual command and performs no
 * gating of its own.
 */

import { runAddressReviewViaCli, runResolveConflictsViaCli } from "../review-polling-acquirer";
import { runCiFixViaCli } from "../ci-failure-watcher-acquirer";
import type { AutomaticResolveResult } from "../review-polling-acquirer";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { buildRepoEnv, gitHubSlugFromRemote } from "./env";
import { toRoutableTask } from "./router";
import type { createFleetTaskExecutor, FleetTask, RepoManagerLike } from "./workspace-worker";
import type { RunCoordinator } from "../run-coordinator";

export interface FleetEventDeps {
  config: WorkspaceConfig;
  workspaceDir: string;
  repoManager: RepoManagerLike;
  /** Permission gate backend (GitHub collaborator check; injected for tests). */
  userHasPushAccess: (owner: string, repo: string, username: string) => Promise<boolean>;
  /** Review runner (injected for tests; defaults to the CLI subprocess). */
  runReview?: (
    repo: string,
    prNumber: number,
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
    },
  ) => Promise<boolean>;
  /** CI-fix runner (injected for tests; defaults to the CLI subprocess). */
  runCiFix?: (
    repo: string,
    prNumber: number,
    feedbackPath: string,
    opts: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
  /** Base-sync runner (injected for tests; defaults to the CLI subprocess). */
  runResolve?: typeof runResolveConflictsViaCli;
  verbose?: boolean;
  /** Process-level agent-run gate; only set when scheduled estimation exists. */
  coordinator?: RunCoordinator;
}

type AddressPr = (slug: string, prNumber: number) => Promise<boolean>;

/**
 * Serialize feedback handling per PR and collapse events received while a run
 * is active into one follow-up reconciliation. Relay, review polling, and
 * mention sweeping can all observe the same GitHub action; the follow-up run
 * re-fetches feedback after the active run has persisted its addressed marks.
 */
export function coalescePrFeedbackRuns(addressPr: AddressPr): AddressPr {
  const active = new Map<string, { rerunRequested: boolean; promise: Promise<boolean> }>();

  return async (slug, prNumber) => {
    const key = `${slug.toLowerCase()}#${prNumber}`;
    const existing = active.get(key);
    if (existing) {
      existing.rerunRequested = true;
      return existing.promise;
    }

    const state = { rerunRequested: false, promise: Promise.resolve(false) };
    state.promise = (async () => {
      try {
        let ok = true;
        do {
          state.rerunRequested = false;
          ok = (await addressPr(slug, prNumber)) && ok;
        } while (state.rerunRequested);
        return ok;
      } finally {
        active.delete(key);
      }
    })();
    active.set(key, state);
    return state.promise;
  };
}

/**
 * Resolve which workspace repo a GitHub `owner/repo` slug belongs to.
 *
 * An explicit `[repos.env].GITHUB_REPO` wins; otherwise the slug is parsed
 * from the remote URL.
 */
export function repoBySlug(config: WorkspaceConfig, slug: string): RepoConfig | undefined {
  const wanted = slug.toLowerCase();
  return config.repos.find((repo) => {
    const configured = repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote);
    return configured?.toLowerCase() === wanted;
  });
}

/** GitHub slugs of all workspace repos with a GitHub remote (deduped). */
export function fleetGitHubSlugs(config: WorkspaceConfig): string[] {
  const slugs = config.repos
    .map((repo) => repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))
    .filter((slug): slug is string => Boolean(slug));
  return [...new Set(slugs)];
}

/**
 * Build the fleet review runner: address a PR's feedback from the repo's
 * base worktree. Used for the agent's own PRs (no gate needed) and as the
 * execution half of gated mention handling.
 *
 * @returns Handler resolving false when the slug maps to no workspace repo.
 */
export function createFleetAddressPr(deps: FleetEventDeps): AddressPr {
  const { config, workspaceDir, repoManager } = deps;
  const runReview = deps.runReview ?? runAddressReviewViaCli;

  return async (slug, prNumber) => {
    const repo = repoBySlug(config, slug);
    if (!repo) {
      console.warn(
        `⚠️  [fleet] PR event for ${slug}#${prNumber} matches no workspace repo; skipping.`,
      );
      return false;
    }
    await repoManager.ensureBareClone(repo);
    await repoManager.fetch(repo.name);
    const base = await repoManager.ensureBaseWorktree(repo);
    const invoke = () =>
      runReview(slug, prNumber, {
        cwd: base,
        env: buildRepoEnv(repo, workspaceDir),
      });
    return deps.coordinator ? deps.coordinator.run(invoke) : invoke();
  };
}

/** Build the fleet base-sync runner using the same per-repo checkout/env as reviews. */
export function createFleetResolveConflicts(
  deps: FleetEventDeps,
): (
  slug: string,
  prNumber: number,
  expected: { headSha: string; baseSha: string },
) => Promise<AutomaticResolveResult> {
  const { config, workspaceDir, repoManager } = deps;
  const runResolve = deps.runResolve ?? runResolveConflictsViaCli;
  return async (slug, prNumber, expected) => {
    const repo = repoBySlug(config, slug);
    if (!repo) {
      return { outcome: "skipped", message: "repository is not configured in this workspace" };
    }
    await repoManager.ensureBareClone(repo);
    await repoManager.fetch(repo.name);
    const base = await repoManager.ensureBaseWorktree(repo);
    const invoke = () =>
      runResolve(slug, prNumber, {
        cwd: base,
        env: buildRepoEnv(repo, workspaceDir),
        expectedHeadSha: expected.headSha,
        expectedBaseSha: expected.baseSha,
      });
    return deps.coordinator ? deps.coordinator.run(invoke) : invoke();
  };
}

/** Build the fleet CI-fix runner using the repo checkout and shared run gate. */
export function createFleetCiFix(
  deps: FleetEventDeps,
): (slug: string, prNumber: number, feedbackPath: string) => Promise<boolean> {
  const runCiFix = deps.runCiFix ?? runCiFixViaCli;
  return async (slug, prNumber, feedbackPath) => {
    const repo = repoBySlug(deps.config, slug);
    if (!repo) {
      console.warn(`⚠️  [fleet] CI failure for ${slug}#${prNumber} has no workspace repo.`);
      return false;
    }
    await deps.repoManager.ensureBareClone(repo);
    await deps.repoManager.fetch(repo.name);
    const base = await deps.repoManager.ensureBaseWorktree(repo);
    const invoke = () =>
      runCiFix(slug, prNumber, feedbackPath, {
        cwd: base,
        env: buildRepoEnv(repo, deps.workspaceDir),
      });
    return deps.coordinator ? deps.coordinator.run(invoke) : invoke();
  };
}

/**
 * Build the fleet mention handler: permission-gate the mentioning user, then
 * run the review pipeline for that PR.
 *
 * The gate fails closed: API errors count as "no access".
 */
export function createFleetMentionHandler(
  deps: FleetEventDeps,
  sharedAddressPr?: AddressPr,
): (slug: string, comment: { user: { login: string } }, prNumber: number) => Promise<void> {
  const addressPr = sharedAddressPr ?? coalescePrFeedbackRuns(createFleetAddressPr(deps));

  return async (slug, comment, prNumber) => {
    const [owner, name] = slug.split("/") as [string, string];
    const actor = comment.user.login;

    let hasAccess = false;
    try {
      hasAccess = await deps.userHasPushAccess(owner, name, actor);
    } catch {
      hasAccess = false;
    }
    if (!hasAccess) {
      console.log(
        `⛔ [fleet] Skipping mention on ${slug}#${prNumber}: @${actor} does not have push access ` +
          "(mention-triggered automation requires write, maintain, or admin permission)",
      );
      return;
    }

    console.log(`📌 [fleet] @mention on ${slug}#${prNumber} by @${actor}`);
    await addressPr(slug, prNumber);
  };
}

/**
 * Build one source's relay task evaluator: re-run that source's query
 * (detect-then-evaluate, same as polling), and execute the task through the
 * source's fleet executor when it is ready.
 *
 * @returns Whether the task matched this source's query.
 */
export function createFleetTaskEvaluator(options: {
  query: string | (() => string | undefined);
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  execute: ReturnType<typeof createFleetTaskExecutor>;
  verbose?: boolean;
}): (taskKey: string) => Promise<boolean> {
  return async (taskKey) => {
    const rawQuery = options.query;
    const query = typeof rawQuery === "function" ? rawQuery() : rawQuery;
    if (!query) {
      if (options.verbose) {
        console.log(`   [fleet] task ${taskKey} changed but task_query is not configured.`);
      }
      return false;
    }
    const { tasks } = await options.searchTasks(query);
    const task = tasks.find((candidate) => candidate.key === taskKey);
    if (!task) {
      if (options.verbose) {
        console.log(`   [fleet] task ${taskKey} changed but does not match the fleet query.`);
      }
      return false;
    }
    console.log(`📌 [fleet] relay task ${taskKey} is ready`);
    await options.execute(
      taskKey,
      toRoutableTask({
        key: task.key,
        labels: task.labels ?? [],
        components: task.components ?? [],
      }),
    );
    return true;
  };
}

/** One team's (or the defaults source's) relay evaluate step. */
export interface FleetRelayTaskSource {
  /** Human-readable scope for logs (team name). */
  label?: string;
  /** Tracker source emitted by relay envelopes (jira, linear, ...). */
  tracker: string;
  evaluate: (taskKey: string) => Promise<boolean>;
}

/**
 * Dispatch a relayed `task.changed` across every configured tracker source:
 * The relay currently identifies tracker type, not an individual team
 * registration. A tracker type mapped to exactly one workspace source is
 * safe to dispatch. Multiple teams using that same tracker remain polling-
 * only for instant events, avoiding first-match routing when task keys
 * overlap across boards or tracker accounts.
 */
export function createFleetRelayTaskDispatcher(options: {
  sources: FleetRelayTaskSource[];
  verbose?: boolean;
}): (taskKey: string, tracker?: string) => Promise<void> {
  return async (taskKey, tracker) => {
    const normalized = tracker?.trim().toLowerCase();
    const candidates = normalized
      ? options.sources.filter((source) => source.tracker.toLowerCase() === normalized)
      : options.sources;
    if (candidates.length > 1) {
      console.warn(
        `⚠️  [fleet] relay task ${taskKey} from ${tracker ?? "an unknown tracker"} maps to ` +
          `${candidates.length} team sources; ignoring the envelope and relying on polling.`,
      );
      return;
    }
    const source = candidates[0];
    if (source && (await source.evaluate(taskKey))) {
      return;
    }
    if (options.verbose) {
      console.log(`   [fleet] relay task ${taskKey} matches no tracker source; ignoring.`);
    }
  };
}
