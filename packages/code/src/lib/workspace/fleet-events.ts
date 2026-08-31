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
import type { AutomaticResolveResult } from "../review-polling-acquirer";
import type { AddressReviewResult } from "../address-review";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { buildRepoEnv, gitHubSlugFromRemote } from "./env";
import { RELAY_BOT_LOGIN } from "../relay-connect";
import { toRoutableTask } from "./router";
import type { createFleetTaskExecutor, FleetTask, RepoManagerLike } from "./workspace-worker";

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
      onResult?: (result: AddressReviewResult) => void;
    },
  ) => Promise<boolean>;
  /** Base-sync runner (injected for tests; defaults to the CLI subprocess). */
  runResolve?: typeof runResolveConflictsViaCli;
  /** Relay reaction request (injected for tests; defaults to the HTTP call). */
  requestRelayReactions?: (repo: string, result: AddressReviewResult) => Promise<void>;
  verbose?: boolean;
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
 * Ask the relay to mark comments as addressed under the relay App identity
 * (devintern-ai) when the run was triggered by a mention of that identity but
 * the local credentials could not (or should not) react. Failures are logged
 * and non-fatal: the local hooray remains the primary marker.
 */
async function requestRelayReactionsViaHttp(
  workspaceDir: string,
  repo: string,
  result: AddressReviewResult,
): Promise<void> {
  if (!result.aliasMentioned || result.unmarkedComments.length === 0) {
    return;
  }
  const { loadRelayState } = await import("../relay-connect");
  const relayState = loadRelayState(workspaceDir);
  if (!relayState?.relayToken || !relayState.relayUrl) {
    return;
  }
  try {
    const response = await fetch(`${relayState.relayUrl.replace(/\/+$/, "")}/v1/reactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relayState.relayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo, comments: result.unmarkedComments }),
    });
    if (!response.ok) {
      console.warn(
        `⚠️  [relay] could not mark ${result.unmarkedComments.length} comment(s) as @${RELAY_BOT_LOGIN}: HTTP ${response.status}`,
      );
      return;
    }
    const body = (await response.json()) as { results?: Array<{ id: number; marked: boolean }> };
    const marked = body.results?.filter((r) => r.marked).length ?? 0;
    if (marked > 0) {
      console.log(`🎉 [relay] @${RELAY_BOT_LOGIN} marked ${marked} comment(s) as addressed`);
    }
  } catch (error) {
    console.warn(`⚠️  [relay] reaction request failed: ${(error as Error).message}`);
  }
}

/**
 * Build the fleet review runner: address a PR's feedback from the repo's
 * base worktree. Used for the agent's own PRs (no gate needed) and as the
 * execution half of gated mention handling.
 *
 * @returns Handler resolving false when the slug maps to no workspace repo.
 */
export function createFleetAddressPr(
  deps: FleetEventDeps,
): (slug: string, prNumber: number) => Promise<boolean> {
  const { config, workspaceDir, repoManager } = deps;
  const runReview = deps.runReview ?? runAddressReviewViaCli;
  const requestRelayReactions =
    deps.requestRelayReactions ??
    ((repo: string, result: AddressReviewResult) =>
      requestRelayReactionsViaHttp(workspaceDir, repo, result));

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
    let cliResult: AddressReviewResult | undefined;
    const ok = await runReview(slug, prNumber, {
      cwd: base,
      env: buildRepoEnv(repo, workspaceDir),
      onResult: (result: AddressReviewResult) => {
        cliResult = result;
      },
    });
    if (cliResult) {
      await requestRelayReactions(slug, cliResult);
    }
    return ok;
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
    return runResolve(slug, prNumber, {
      cwd: base,
      env: buildRepoEnv(repo, workspaceDir),
      expectedHeadSha: expected.headSha,
      expectedBaseSha: expected.baseSha,
    });
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
): (slug: string, comment: { user: { login: string } }, prNumber: number) => Promise<void> {
  const addressPr = createFleetAddressPr(deps);

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
 * Build the relay task evaluator: re-run the fleet query (detect-then-
 * evaluate, same as polling), and execute the task through the shared fleet
 * executor when it is ready.
 */
export function createFleetTaskEvaluator(options: {
  query: string;
  searchTasks: (query: string) => Promise<{ tasks: FleetTask[] }>;
  execute: ReturnType<typeof createFleetTaskExecutor>;
  verbose?: boolean;
}): (taskKey: string) => Promise<void> {
  return async (taskKey) => {
    const { tasks } = await options.searchTasks(options.query);
    const task = tasks.find((candidate) => candidate.key === taskKey);
    if (!task) {
      if (options.verbose) {
        console.log(`   [fleet] task ${taskKey} changed but does not match the fleet query.`);
      }
      return;
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
  };
}
