/**
 * Fleet event handling: PR reviews, @mentions, and relay envelopes across
 * every repo in the workspace.
 *
 * The workspace worker has no ambient checkout, so every event run is a CLI
 * subprocess started from the repo's persistent PR-job checkout (default
 * branch) with that repo's composed environment. The subprocess does its work
 * in a branch-scoped PR worktree and never uses the base checkout, so PR jobs
 * are admitted as `pr_worktree`: jobs for different PRs on one repository run
 * in parallel (bounded by `max_concurrency_per_repo`) and alongside an
 * automation in the base checkout, while jobs on one PR stay serialized by
 * their exclusive key. The permission gate for mention-driven runs
 * (write/maintain/admin; a confirmed denial skips, an API error propagates so
the caller retries) therefore lives HERE, before the
 * subprocess: `devintern address-review` is a manual command and performs no
 * gating of its own.
 */

import { runAddressReviewViaCli, runResolveConflictsViaCli } from "../acquirers/review-polling";
import { runCiFixViaCli } from "../acquirers/ci-failure-watcher";
import { runAutoMergeViaCli } from "../acquirers/auto-merge-cli";
import type { AutoMergeResult } from "../review/auto-merge";
import { randomUUID } from "crypto";
import type { CiFixResult } from "../acquirers/ci-failure-watcher";
import type { AutomaticResolveResult } from "../acquirers/review-polling";
import type { TaskExecutionResult } from "../acquirers/task-polling";
import { DEFAULT_MERGE_SAFETY_POLICY } from "../review/merge-gate";
import { readRulesFile } from "../review/merge-safety-rules";
import { autoMergeRequireChecksFor, autoMergePathsFor, autoMergeReviewFor } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { buildFleetEventEnv, gitHubSlugFromRemote } from "./env";
import { toRoutableTask } from "./router";
import type { createGatedFleetTaskExecutor, FleetTask, RepoManagerLike } from "./fleet-executor";
import { JobNotStartedError } from "../worker/supervisor";
import type { TaskSupervisor } from "../worker/supervisor";
import { MAX_CONCURRENCY_PER_REPO_ENV } from "../utils/review-worktree";

/**
 * Supervisor exclusive key for one GitHub PR (`owner/repo#123`, lowercased
 * like `serializePrRun`), so jobs on the same PR never run at once.
 */
export function prExclusiveKey(slug: string, prNumber: number): string {
  return `${slug.toLowerCase()}#${prNumber}`;
}

/**
 * Upper bound on the repository fetch before a PR job. A hung remote fails
 * the job (retried like any other failure) instead of holding its slot.
 */
export const PR_JOB_FETCH_TIMEOUT_MS = 5 * 60_000;

/**
 * Environment for a PR job subprocess: the repo env plus the per-repo limit,
 * which sizes how many idle review worktrees the job's cleanup keeps.
 */
export function prJobEnv(
  config: WorkspaceConfig,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    [MAX_CONCURRENCY_PER_REPO_ENV]: String(config.workspace.execution.maxConcurrencyPerRepo),
  };
}

/**
 * Prepare a repo for a PR job: clone/fetch the bare repository and return the
 * PR-job checkout (default branch). PR jobs run their agents in their own
 * branch-scoped worktrees (`pr_worktree`), possibly while an automation is
 * working in the base checkout, so they never touch the base checkout; the CLI
 * starts from the PR-job checkout, which supplies the default branch's project
 * settings and the repository to create the PR worktree from.
 */
async function preparePrJobRepo(repoManager: RepoManagerLike, repo: RepoConfig): Promise<string> {
  await repoManager.ensureBareClone(repo);
  await repoManager.fetch(repo.name, { timeoutMs: PR_JOB_FETCH_TIMEOUT_MS });
  return repoManager.ensurePrJobWorktree(repo);
}

export interface FleetEventDeps {
  config: WorkspaceConfig;
  workspaceDir: string;
  repoManager: RepoManagerLike;
  /**
   * Permission gate backend (GitHub collaborator check; injected for tests).
   * Must reject on API errors rather than resolve `false`, so a transient
   * failure is retried instead of being treated as a denial.
   */
  userHasPushAccess: (owner: string, repo: string, username: string) => Promise<boolean>;
  /** Review runner (injected for tests; defaults to the CLI subprocess). */
  runReview?: (
    repo: string,
    prNumber: number,
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      signal?: AbortSignal;
    },
  ) => Promise<TaskExecutionResult>;
  /** CI-fix runner (injected for tests; defaults to the CLI subprocess). */
  runCiFix?: (
    repo: string,
    prNumber: number,
    feedbackPath: string,
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      expectedHeadSha?: string;
      signal?: AbortSignal;
    },
  ) => Promise<CiFixResult>;
  /** Base-sync runner (injected for tests; defaults to the CLI subprocess). */
  runResolve?: typeof runResolveConflictsViaCli;
  /** Auto-merge runner (injected for tests; defaults to the CLI subprocess). */
  runAutoMerge?: typeof runAutoMergeViaCli;
  verbose?: boolean;
  /** Shared workspace admission supervisor. */
  supervisor?: TaskSupervisor;
}

type AddressPr = (slug: string, prNumber: number) => Promise<TaskExecutionResult>;

/**
 * Serialize feedback handling per PR and collapse events received while a run
 * is active into one follow-up reconciliation. Relay, review polling, and
 * mention sweeping can all observe the same GitHub action; the follow-up run
 * re-fetches feedback after the active run has persisted its addressed marks.
 *
 * A `false` outcome from any run wins (a run did not complete cleanly);
 * otherwise the last outcome is reported, so a follow-up run that succeeded
 * clears an earlier `"deferred"`. A `"skipped"` outcome (retry gate) passes
 * through like any other non-failure.
 */
export function coalescePrFeedbackRuns(addressPr: AddressPr): AddressPr {
  const active = new Map<
    string,
    { rerunRequested: boolean; promise: Promise<TaskExecutionResult> }
  >();

  return async (slug, prNumber) => {
    const key = `${slug.toLowerCase()}#${prNumber}`;
    const existing = active.get(key);
    if (existing) {
      existing.rerunRequested = true;
      return existing.promise;
    }

    const state = {
      rerunRequested: false,
      promise: Promise.resolve(false as TaskExecutionResult),
    };
    state.promise = (async () => {
      try {
        let ok: TaskExecutionResult = true;
        do {
          state.rerunRequested = false;
          const outcome = await addressPr(slug, prNumber);
          if (outcome === false || ok === false) {
            ok = false;
          } else {
            ok = outcome;
          }
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
    const invoke = async (signal?: AbortSignal) => {
      const base = await preparePrJobRepo(repoManager, repo);
      return runReview(slug, prNumber, {
        cwd: base,
        env: prJobEnv(config, buildFleetEventEnv(config, repo, workspaceDir)),
        signal,
      });
    };
    try {
      if (deps.supervisor) {
        return await deps.supervisor.schedule({
          id: randomUUID(),
          source: "github:feedback",
          repo: repo.name,
          kind: "review",
          label: `${slug}#${prNumber}`,
          checkoutClass: "pr_worktree",
          exclusiveKey: prExclusiveKey(slug, prNumber),
          run: invoke,
        });
      }
      return invoke();
    } catch (error) {
      if (error instanceof JobNotStartedError) return "deferred";
      throw error;
    }
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
    const invoke = async (signal?: AbortSignal) => {
      const base = await preparePrJobRepo(repoManager, repo);
      // Read at run time so a live reload of the conflict agent applies.
      const agentSelection = config.workspace.conflictAgent;
      return runResolve(slug, prNumber, {
        cwd: base,
        env: prJobEnv(config, buildFleetEventEnv(config, repo, workspaceDir, { agentSelection })),
        harnessPin: agentSelection?.harness,
        expectedHeadSha: expected.headSha,
        expectedBaseSha: expected.baseSha,
        signal,
      });
    };
    try {
      if (deps.supervisor) {
        return await deps.supervisor.schedule({
          id: randomUUID(),
          source: "github:conflict",
          repo: repo.name,
          kind: "conflict",
          label: `${slug}#${prNumber}`,
          checkoutClass: "pr_worktree",
          exclusiveKey: prExclusiveKey(slug, prNumber),
          run: invoke,
        });
      }
      return invoke();
    } catch (error) {
      if (error instanceof JobNotStartedError) {
        return { outcome: "deferred", message: error.message, capacity: true };
      }
      throw error;
    }
  };
}

/**
 * Fingerprint of the auto-merge policy that decides a repo's PRs (safe, deny,
 * and review paths, `require_checks`,
 * review switch, review policy, operator instructions, and `custom` rules,
 * including the current contents of a rules file; not the merge method or
 * review label, which don't change the decision, so renaming the label
 * doesn't re-evaluate every PR). Changing it re-evaluates PRs that were
 * decided under the previous policy, so editing or fixing a rules file
 * re-checks the PRs it held.
 */
export function fleetAutoMergePolicyFingerprint(
  config: WorkspaceConfig,
  slug: string,
  workspaceDir: string,
): string {
  const settings = config.workspace.autoMerge;
  const repo = repoBySlug(config, slug);
  const { reviewPaths, ...paths } = repo
    ? autoMergePathsFor(settings, repo)
    : {
        safePaths: settings.safePaths,
        denyPaths: settings.denyPaths,
        reviewPaths: settings.reviewPaths,
      };
  const review = autoMergeReviewFor(settings, repo ?? {}, workspaceDir);
  const requireChecks = autoMergeRequireChecksFor(settings, repo ?? {});
  let rules: string | undefined = review.rules;
  if (review.rulesFile) {
    const loaded = readRulesFile(review.rulesFile);
    rules = `${review.rulesFile}\n${loaded.ok ? loaded.text : `unavailable: ${loaded.problem}`}`;
  }
  // The default policy without instructions hashes as before, so upgrading
  // does not re-evaluate every PR.
  const material = JSON.stringify({
    ...paths,
    // Only when set, so workspaces without review paths hash as before.
    ...(reviewPaths.length > 0 ? { reviewPaths } : {}),
    review: settings.review,
    ...(review.reviewPolicy === DEFAULT_MERGE_SAFETY_POLICY
      ? {}
      : { reviewPolicy: review.reviewPolicy }),
    ...(review.reviewInstructions ? { reviewInstructions: review.reviewInstructions } : {}),
    ...(rules === undefined ? {} : { rules }),
    // Only when on, so the default hashes as before; switching it re-checks held PRs.
    ...(requireChecks ? { requireChecks } : {}),
  });
  return Bun.hash(material).toString(16);
}

/**
 * Build the fleet auto-merge runner: the repo's live policy (repo path lists
 * replace the workspace's), its checkout and env, and the shared supervisor.
 */
export function createFleetAutoMerge(
  deps: FleetEventDeps,
): (
  slug: string,
  prNumber: number,
  expectedHeadSha: string,
  options?: { lastAttempt: boolean; onStart?: () => void; runId?: number; ciWaitPosted?: string },
) => Promise<AutoMergeResult> {
  const { config, workspaceDir, repoManager } = deps;
  const runAutoMerge = deps.runAutoMerge ?? runAutoMergeViaCli;
  return async (slug, prNumber, expectedHeadSha, options) => {
    const repo = repoBySlug(config, slug);
    if (!repo) {
      return {
        outcome: "skipped",
        message: "repository is not configured in this workspace",
        reviewed: false,
      };
    }
    const invoke = async (signal?: AbortSignal) => {
      // Admitted: the repo's slot is ours, so the check is no longer waiting.
      options?.onStart?.();
      const base = await preparePrJobRepo(repoManager, repo);
      // Read at run time so live reloads of the policy and agent apply.
      const settings = config.workspace.autoMerge;
      const agentSelection = settings.agent;
      return runAutoMerge(slug, prNumber, {
        policy: {
          ...autoMergePathsFor(settings, repo),
          ...autoMergeReviewFor(settings, repo, workspaceDir),
          review: settings.review,
          method: settings.method,
          reviewLabel: settings.reviewLabel,
          recheckOnPush: settings.recheckOnPush,
          ...(autoMergeRequireChecksFor(settings, repo) ? { requireChecks: true } : {}),
        },
        expectedHeadSha,
        lastAttempt: options?.lastAttempt ?? false,
        ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        ...(options?.ciWaitPosted !== undefined ? { ciWaitPosted: options.ciWaitPosted } : {}),
        cwd: base,
        env: prJobEnv(config, buildFleetEventEnv(config, repo, workspaceDir, { agentSelection })),
        harnessPin: agentSelection?.harness,
        signal,
      });
    };
    try {
      if (deps.supervisor) {
        return await deps.supervisor.schedule({
          id: randomUUID(),
          source: "github:auto-merge",
          repo: repo.name,
          kind: "auto_merge",
          label: `${slug}#${prNumber}`,
          checkoutClass: "pr_worktree",
          exclusiveKey: prExclusiveKey(slug, prNumber),
          run: invoke,
        });
      }
      return await invoke();
    } catch (error) {
      if (error instanceof JobNotStartedError) {
        return { outcome: "deferred", message: error.message, reviewed: false };
      }
      throw error;
    }
  };
}

/** Build the fleet CI-fix runner using the repo checkout and shared run gate. */
export function createFleetCiFix(
  deps: FleetEventDeps,
): (
  slug: string,
  prNumber: number,
  feedbackPath: string,
  expectedHeadSha?: string,
) => Promise<CiFixResult> {
  const runCiFix = deps.runCiFix ?? runCiFixViaCli;
  return async (slug, prNumber, feedbackPath, expectedHeadSha) => {
    const repo = repoBySlug(deps.config, slug);
    if (!repo) {
      console.warn(`⚠️  [fleet] CI failure for ${slug}#${prNumber} has no workspace repo.`);
      return false;
    }
    const invoke = async (signal?: AbortSignal) => {
      const base = await preparePrJobRepo(deps.repoManager, repo);
      return runCiFix(slug, prNumber, feedbackPath, {
        cwd: base,
        env: prJobEnv(deps.config, buildFleetEventEnv(deps.config, repo, deps.workspaceDir)),
        ...(expectedHeadSha ? { expectedHeadSha } : {}),
        signal,
      });
    };
    if (deps.supervisor) {
      try {
        return await deps.supervisor.schedule({
          id: randomUUID(),
          source: "github:ci",
          repo: repo.name,
          kind: "ci_fix",
          label: `${slug}#${prNumber}`,
          checkoutClass: "pr_worktree",
          exclusiveKey: prExclusiveKey(slug, prNumber),
          run: invoke,
        });
      } catch (error) {
        if (error instanceof JobNotStartedError) return "deferred";
        throw error;
      }
    }
    return invoke();
  };
}

/**
 * Build the fleet mention handler: permission-gate the mentioning user, then
 * run the review pipeline for that PR.
 *
 * A confirmed denial returns `"skipped"` (an intentional no-op). A permission
 * API error propagates: the relay classifies it as transient and retries it
 * within its bounded budget, and the polling sweep retries it through its
 * attempt ledger. A 5xx or rate limit must not permanently drop a valid
 * @mention.
 *
 * @returns The review run outcome, or `"skipped"` when the actor lacks access.
 */
export function createFleetMentionHandler(
  deps: FleetEventDeps,
  sharedAddressPr?: AddressPr,
): (
  slug: string,
  comment: { user: { login: string } },
  prNumber: number,
) => Promise<TaskExecutionResult> {
  const addressPr = sharedAddressPr ?? coalescePrFeedbackRuns(createFleetAddressPr(deps));

  return async (slug, comment, prNumber) => {
    const [owner, name] = slug.split("/") as [string, string];
    const actor = comment.user.login;

    const hasAccess = await deps.userHasPushAccess(owner, name, actor);
    if (!hasAccess) {
      console.log(
        `⛔ [fleet] Skipping mention on ${slug}#${prNumber}: @${actor} does not have push access ` +
          "(mention-triggered automation requires write, maintain, or admin permission)",
      );
      return "skipped";
    }

    console.log(`📌 [fleet] @mention on ${slug}#${prNumber} by @${actor}`);
    return addressPr(slug, prNumber);
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
  execute: ReturnType<typeof createGatedFleetTaskExecutor>;
  /**
   * Actioned gate mirroring the polling acquirer: `true` when a task already
   * produced a PR and has not changed since. A relayed `task.changed` can be
   * the worker's own post-PR transition, so without this check the ticket
   * would be re-implemented and could get a duplicate PR.
   */
  isTaskActionedUnchanged?: (taskKey: string, updated?: string) => Promise<boolean>;
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
    if (
      options.isTaskActionedUnchanged &&
      (await options.isTaskActionedUnchanged(taskKey, task.updated))
    ) {
      console.log(`⏭️  [fleet] relay task ${taskKey} is already actioned; not re-implementing.`);
      return true;
    }
    console.log(`📌 [fleet] relay task ${taskKey} is ready`);
    // A ticket its blockers hold back ("waiting") is left to the poller, which
    // re-checks it every tick.
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
 * Dispatch a relayed `task.changed` to its exact team when one is present.
 * Legacy team-less envelopes retain source-only routing, but only when that
 * tracker maps unambiguously to one configured source.
 */
export function createFleetRelayTaskDispatcher(options: {
  sources: FleetRelayTaskSource[];
  verbose?: boolean;
}): (taskKey: string, tracker?: string, team?: string) => Promise<void> {
  return async (taskKey, tracker, team) => {
    const normalized = tracker?.trim().toLowerCase();
    let candidates = normalized
      ? options.sources.filter((source) => source.tracker.toLowerCase() === normalized)
      : options.sources;
    if (team !== undefined) {
      candidates = candidates.filter((source) => source.label === team);
      const source = candidates[0];
      if (candidates.length === 1 && source) {
        if (await source.evaluate(taskKey)) return;
        if (options.verbose) {
          console.log(`   [fleet] relay task ${taskKey} does not match team '${team}'; ignoring.`);
        }
        return;
      }
      console.warn(
        `⚠️  [fleet] relay task ${taskKey} targets unknown or removed team '${team}'` +
          `${tracker ? ` for ${tracker}` : ""}; ignoring the envelope.`,
      );
      return;
    }
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
