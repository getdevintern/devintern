/**
 * Agent PR Reconciler
 *
 * Keeps the `agent_prs` registry (worker-state.ts) truthful against GitHub.
 * The dashboard's "N agent PRs open" count reads this registry, so a PR
 * closed outside the worker (merged by a human or closed from the GitHub UI)
 * must leave the registry within one poll cycle.
 *
 * The review poller fetches every watched PR's state on each tick anyway, so
 * `applyAgentPrFetch` folds reconciliation into that fetch (no extra API
 * call). `reconcileOpenAgentPrs` is the batch form: one conditional GET per
 * watched PR — 304s are rate-limit-free, so the steady-state sync costs
 * nothing against GitHub's limits (App installs or PATs alike) — and it
 * shares its fetch results with the caller's per-PR poll loop via `fresh`.
 */

import type { AgentPr, WorkerState } from "../state/worker-state";

/** The subset of a GitHub PR payload the poller and reconciler rely on. */
export interface PolledPr {
  state: string;
  /** GitHub's computed merge state; `"dirty"` means merge conflicts. */
  mergeable_state?: string;
  head?: { sha: string; ref?: string; repo?: { full_name: string } | null };
  base?: { sha: string; ref?: string };
}

/** Result of a conditional (ETag-cached) GitHub GET. */
export interface ConditionalResult<T> {
  data: T | null;
  etag?: string;
  notModified: boolean;
  /**
   * GitHub answered 404. This can mean either deletion or missing access for
   * this credential, so it cannot prove the PR should be unwatched.
   */
  gone?: boolean;
}

/** GitHub access the reconciler needs (satisfied by the review poller's client). */
export interface AgentPrReconcileGitHub {
  fetchPr(repo: string, prNumber: number, etag?: string): Promise<ConditionalResult<PolledPr>>;
}

/** One registry row closed by reconciliation. */
export interface AgentPrClosure {
  repo: string;
  prNumber: number;
  /** The PR's confirmed GitHub state. */
  reason: string;
}

export interface AgentPrReconcileSummary {
  /** Open registry rows examined (foreign repos excluded). */
  checked: number;
  /** Rows left open because GitHub could not be reached this pass. */
  failed: number;
  closed: AgentPrClosure[];
}

/** Cursor source holding the PR-state ETag shared by poller and reconciler. */
export function agentPrStateCursorSource(repo: string, prNumber: number): string {
  return `github:pr:${repo}#${prNumber}`;
}

/** Stable map key for a PR (same shape as the poller's in-memory cache). */
export function agentPrKey(repo: string, prNumber: number): string {
  return `${repo.toLowerCase()}#${prNumber}`;
}

/**
 * Apply one fetched PR state to the registry: persist the ETag cursor and
 * close the row only when GitHub confirms that it is no longer open.
 *
 * @returns The closure record, or `null` when the PR stays watched.
 */
export function applyAgentPrFetch(
  workerState: WorkerState,
  pr: { repo: string; prNumber: number },
  result: ConditionalResult<PolledPr>,
): AgentPrClosure | null {
  if (!result.notModified && result.etag) {
    workerState.setCursor(agentPrStateCursorSource(pr.repo, pr.prNumber), "state", result.etag);
  }
  if (result.data && result.data.state !== "open") {
    const reason = result.data.state;
    workerState.markAgentPrClosed(pr.repo, pr.prNumber);
    return { repo: pr.repo, prNumber: pr.prNumber, reason };
  }
  return null;
}

/**
 * Reconcile the open-PR registry with GitHub.
 *
 * Every watched row that belongs to an allowed repo is checked once; rows
 * whose PR is confirmed closed/merged are closed. Missing information,
 * including a 404 that may reflect access loss, leaves the row open.
 *
 * @param options.workerState - Registry store
 * @param options.github - GitHub client (the review poller's, so App auth applies)
 * @param options.watched - Open registry rows to verify
 * @param options.allowedRepos - Repos this worker manages; foreign rows are skipped
 * @param options.etagFor - Stored ETag per PR; defaults to the shared `github:pr:` cursor
 * @param options.fresh - Collect fetch results here (keyed by {@link agentPrKey})
 *                        so the caller can poll each PR without a second request
 */
export async function reconcileOpenAgentPrs(options: {
  workerState: WorkerState;
  github: AgentPrReconcileGitHub;
  watched: AgentPr[];
  allowedRepos?: string[];
  etagFor?: (repo: string, prNumber: number) => string | undefined;
  fresh?: Map<string, ConditionalResult<PolledPr>>;
}): Promise<AgentPrReconcileSummary> {
  const { workerState, github, watched, allowedRepos, fresh } = options;
  const etagFor =
    options.etagFor ??
    ((repo: string, prNumber: number) =>
      workerState.getCursor(agentPrStateCursorSource(repo, prNumber))?.etag);

  const summary: AgentPrReconcileSummary = { checked: 0, failed: 0, closed: [] };
  for (const pr of watched) {
    if (allowedRepos && allowedRepos.length > 0 && !allowedRepos.includes(pr.repo)) {
      continue;
    }
    summary.checked += 1;
    let result: ConditionalResult<PolledPr>;
    try {
      result = await github.fetchPr(pr.repo, pr.prNumber, etagFor(pr.repo, pr.prNumber));
    } catch {
      // Transient (network, rate limit): leave the row open and retry next
      // pass — reconciliation must never close a row on missing information.
      summary.failed += 1;
      continue;
    }
    const closure = applyAgentPrFetch(workerState, pr, result);
    if (closure) {
      summary.closed.push(closure);
      fresh?.delete(agentPrKey(pr.repo, pr.prNumber));
      continue;
    }
    if (result.gone) summary.failed += 1;
    if ((result.data || result.gone) && fresh) {
      fresh.set(agentPrKey(pr.repo, pr.prNumber), result);
    }
  }
  return summary;
}
