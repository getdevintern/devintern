/**
 * Team-PR base sync discovery (`sync_team_prs`), driven by the review poller.
 *
 * For each opted-in repo the sweep lists open PRs (ETag-conditional) and
 * hands each eligible teammate PR to the poller's normal base-sync path. It
 * owns only discovery and eligibility; execution, mode, schedule window,
 * quiet period, retry backoff, defer caps, and credential-failure policy stay
 * with {@link import("./review-polling").ReviewPollingAcquirer} through the
 * {@link TeamPrSweepHost} callbacks.
 *
 * Trust model: foreign branches are someone else's code. Eligibility is
 * narrowed to the repository's team (`author_association`, checked on the
 * list entry, re-checked on the fresh per-PR payload, and again by the
 * poller right before execution); drafts and forks never run; review
 * feedback is never addressed; work happens in a branch-scoped review
 * worktree with lease-verified, never-forced pushes; and enabling the flag
 * requires an explicit agent sandbox (`assertTeamPrSyncSandbox`). A genuinely
 * conflicting merge still hands a teammate's code to the sandboxed agent —
 * branch protection decides what lands.
 */

import { agentPrKey, classifyAgentPrState } from "../review/agent-pr-reconciler";
import type { ConditionalResult, PolledPr } from "../review/agent-pr-reconciler";
import type { WorkerState } from "../state/worker-state";

/** Open-PR list entry used to discover teammates' PRs for base sync. */
export interface PolledPrListItem {
  number: number;
  /** Drafts are excluded from team-PR base sync. */
  draft?: boolean;
  /** See {@link PolledPr.author_association}. */
  author_association?: string;
  /** Head repository; a different full name marks a fork PR (skipped). */
  head?: { repo?: { full_name: string } | null };
}

/**
 * Page size the built-in GitHub client requests when listing a repo's open
 * PRs. A list this long means GitHub truncated it: PRs past the first page
 * are invisible to team-PR discovery.
 */
export const OPEN_PR_LIST_PAGE_SIZE = 100;

/**
 * `author_association` values that count as the repository's team for
 * team-PR base sync. Anything else (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
 * `NONE`, …) is an outside author whose branch is never auto-synced.
 */
export const TEAM_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "MAINTAIN",
]);

/** True when `author_association` marks the PR author as part of the repo team. */
export function isTeamAuthor(association?: string): boolean {
  return association !== undefined && TEAM_AUTHOR_ASSOCIATIONS.has(association.toUpperCase());
}

/** Durable ETag cursor for a repo's open-PR list (team-PR discovery). */
export function teamPrListCursorSource(repo: string): string {
  return `github:open-prs:${repo}`;
}

/**
 * Durable ETag cursor for a teammate PR's state. Distinct from
 * `agentPrStateCursorSource` so the two caches never share a validator.
 */
export function teamPrStateCursorSource(repo: string, prNumber: number): string {
  return `github:team-pr:${repo}#${prNumber}`;
}

/** Request group a sweep reports success/failure for. */
export type TeamPrSweepStage = "open-prs" | "pr-state";

/** Poller services one sweep needs (per tick). */
export interface TeamPrSweepHost {
  workerState: Pick<WorkerState, "getCursor" | "setCursor">;
  listOpenPullRequests(repo: string, etag?: string): Promise<ConditionalResult<PolledPrListItem[]>>;
  fetchPr(repo: string, prNumber: number, etag?: string): Promise<ConditionalResult<PolledPr>>;
  /** Run the poller's base-sync path for an eligible teammate PR. */
  syncBase(repo: string, prNumber: number, pr: PolledPr): Promise<void>;
  /** Clear a worker-restart exhaustion row when the PR leaves the watch. */
  resolveBaseSync?(repo: string, prNumber: number): void;
  /** A request stage completed (credential recovery bookkeeping). */
  onSuccess(repo: string, stage: TeamPrSweepStage): void;
  /** A request stage threw; apply the poller's failure policy. */
  onFailure(
    repo: string,
    prNumber: number | undefined,
    error: unknown,
    stage: TeamPrSweepStage,
  ): void;
  /** GitHub returned 404 for one PR (maybe lost access). */
  warnPrInaccessible(repo: string, prNumber: number): void;
  /** GitHub returned 404 for the repo's open-PR list. */
  warnListInaccessible(repo: string): void;
}

/** In-memory discovery state for team-PR base sync across opted-in repos. */
export class TeamPrSweeper {
  /** Last open-PR list per opted-in repo (lowercased slug); lets a 304 reuse it. */
  private lists = new Map<string, PolledPrListItem[]>();
  /** Repos whose open-PR list currently sits at the page-size cap (warned once). */
  private capWarned = new Set<string>();
  /** Teammate PRs currently watched for base sync (`agentPrKey` form). */
  private watched = new Set<string>();
  /** PRs already announced as non-team authored (log once, not per tick). */
  private skippedAuthors = new Set<string>();
  /** Last usable state payload per watched teammate PR (304 reuse). */
  private prCache = new Map<string, PolledPr>();
  /** Last logged sync scope, so enable/disable changes log once. */
  private scopeLabel = "";

  constructor(private readonly logName: string) {}

  /** Watched teammate PR keys (tests/diagnostics). */
  watchedKeys(): string[] {
    return [...this.watched].sort();
  }

  /**
   * Drop state for repos no longer opted in (live reload, or the mode turned
   * `disabled`) and log scope changes once.
   */
  prune(activeRepos: string[]): void {
    const active = new Set(activeRepos.map((repo) => repo.toLowerCase()));
    const label = [...active].sort().join(", ");
    if (label !== this.scopeLabel) {
      console.log(
        label
          ? `🌐 [${this.logName}] team-PR base sync enabled on: ${label}`
          : `🌐 [${this.logName}] team-PR base sync disabled`,
      );
      this.scopeLabel = label;
    }
    const repoOf = (key: string) => key.slice(0, key.lastIndexOf("#"));
    for (const repo of this.lists.keys()) if (!active.has(repo)) this.lists.delete(repo);
    for (const repo of this.capWarned) if (!active.has(repo)) this.capWarned.delete(repo);
    for (const key of this.watched) if (!active.has(repoOf(key))) this.watched.delete(key);
    for (const key of this.skippedAuthors) {
      if (!active.has(repoOf(key))) this.skippedAuthors.delete(key);
    }
    for (const key of this.prCache.keys()) if (!active.has(repoOf(key))) this.prCache.delete(key);
  }

  /**
   * List one opted-in repo's open PRs (reusing the cached list on 304) and
   * base-sync each eligible teammate PR. `ownKeys` are the agent's own PRs,
   * which already go through the full pipeline.
   */
  async sweep(repo: string, ownKeys: ReadonlySet<string>, host: TeamPrSweepHost): Promise<void> {
    const repoKey = repo.toLowerCase();
    const listSource = teamPrListCursorSource(repo);
    const cachedList = this.lists.get(repoKey);

    let result: ConditionalResult<PolledPrListItem[]>;
    try {
      // Only revalidate when this process holds the list: a persisted ETag
      // from a previous run would otherwise yield a 304 with nothing to reuse.
      result = await host.listOpenPullRequests(
        repo,
        cachedList ? host.workerState.getCursor(listSource)?.etag : undefined,
      );
    } catch (error) {
      host.onFailure(repo, undefined, error, "open-prs");
      return;
    }
    if (result.gone) {
      host.warnListInaccessible(repo);
      return;
    }
    let items: PolledPrListItem[];
    if (result.notModified) {
      if (!cachedList) return;
      items = cachedList;
    } else {
      if (!result.data) return;
      items = result.data;
      this.lists.set(repoKey, items);
      if (result.etag) host.workerState.setCursor(listSource, "state", result.etag);
      this.checkPageCap(repo, items.length);
    }
    host.onSuccess(repo, "open-prs");

    const listed = new Set<string>();
    for (const item of items) {
      const key = agentPrKey(repo, item.number);
      listed.add(key);
      if (ownKeys.has(key)) {
        // The main review poller owns this PR. Stop any team-sweep tracking
        // without clearing its base-sync escalation: the sweep never watches
        // own PRs, so leaving this branch says nothing about their conflicts.
        this.forget(key);
        continue;
      }
      // Drafts signal work in progress; forks are not ours to push to.
      const headRepo = item.head?.repo?.full_name;
      if (item.draft === true || (headRepo && headRepo.toLowerCase() !== repoKey)) {
        this.unwatch(key, host);
        continue;
      }
      if (!isTeamAuthor(item.author_association)) {
        this.noteNonTeamAuthor(repo, item.number, item.author_association, host, {
          clearBaseSync: item.author_association !== undefined,
        });
        continue;
      }
      if (!this.watched.has(key)) {
        this.watched.add(key);
        console.log(`👀 [${this.logName}] watching ${repo}#${item.number} (open PR) for base sync`);
      }
      try {
        await this.pollPr(repo, item.number, host);
        host.onSuccess(repo, "pr-state");
      } catch (error) {
        host.onFailure(repo, item.number, error, "pr-state");
      }
    }

    const prefix = `${repoKey}#`;
    for (const key of this.watched) {
      if (!key.startsWith(prefix) || listed.has(key)) continue;
      this.unwatch(key, host);
      console.log(`👋 [${this.logName}] ${key} left the open-PR list; no longer watching`);
    }
    for (const key of this.skippedAuthors) {
      if (key.startsWith(prefix) && !listed.has(key)) this.skippedAuthors.delete(key);
    }
  }

  /** Warn once while a repo's list sits at the page-size cap. */
  private checkPageCap(repo: string, length: number): void {
    const repoKey = repo.toLowerCase();
    if (length < OPEN_PR_LIST_PAGE_SIZE) {
      this.capWarned.delete(repoKey);
      return;
    }
    if (this.capWarned.has(repoKey)) return;
    this.capWarned.add(repoKey);
    console.warn(
      `⚠️  [${this.logName}] ${repo}'s open-PR list hit the ${OPEN_PR_LIST_PAGE_SIZE}-PR page ` +
        "cap; open PRs past the first page are not discovered for team-PR base sync",
    );
  }

  /** Base-sync-only polling for one teammate PR (never feedback addressing). */
  private async pollPr(repo: string, prNumber: number, host: TeamPrSweepHost): Promise<void> {
    const key = agentPrKey(repo, prNumber);
    const source = teamPrStateCursorSource(repo, prNumber);
    const cached = this.prCache.get(key);
    const result = await host.fetchPr(
      repo,
      prNumber,
      cached ? host.workerState.getCursor(source)?.etag : undefined,
    );
    if (result.gone) {
      this.prCache.delete(key);
      host.warnPrInaccessible(repo, prNumber);
      return;
    }
    const pr = result.notModified ? cached : (result.data ?? undefined);
    if (!pr) return;
    // Only a confirmed terminal state (or an explicit draft) means the PR is
    // no longer watched. An unusable `state` must not be read as "not open":
    // that would clear the escalation while the PR may still conflict.
    const lifecycle = classifyAgentPrState(pr.state);
    if (pr.draft === true || lifecycle === "closed" || lifecycle === "merged") {
      // Closed/merged/draft PRs drop out of the watch set via the list.
      this.prCache.delete(key);
      host.resolveBaseSync?.(repo, prNumber);
      return;
    }
    if (lifecycle === null) return;
    // Re-check the team gate on the fresh per-PR payload: the list entry can
    // be stale, and eligibility must hold at sync time. A missing association
    // cannot prove the author is outside the team, so wait for a usable one.
    if (pr.author_association === undefined) return;
    if (!isTeamAuthor(pr.author_association)) {
      this.noteNonTeamAuthor(repo, prNumber, pr.author_association, host);
      return;
    }
    if (!result.notModified) {
      this.prCache.set(key, pr);
      if (result.etag) host.workerState.setCursor(source, "state", result.etag);
    }
    await host.syncBase(repo, prNumber, pr);
  }

  /** Log a non-team author skip once per PR, and stop watching it. */
  private noteNonTeamAuthor(
    repo: string,
    prNumber: number,
    association: string | undefined,
    host: TeamPrSweepHost,
    options: { clearBaseSync?: boolean } = {},
  ): void {
    const key = agentPrKey(repo, prNumber);
    // Keep the log-once marker: only a real unwatch drops it.
    this.watched.delete(key);
    this.prCache.delete(key);
    // A missing association cannot prove the author is outside the team, so it
    // must not clear an escalation row for a PR that may still conflict.
    if (options.clearBaseSync ?? association !== undefined) {
      host.resolveBaseSync?.(repo, prNumber);
    }
    if (this.skippedAuthors.has(key)) return;
    this.skippedAuthors.add(key);
    console.log(
      `🚧 [${this.logName}] skipping ${repo}#${prNumber} for base sync (non-team author: ` +
        `${association ?? "unknown"})`,
    );
  }

  /**
   * Stop tracking a PR. Leaving the watch means no base sync will run for it,
   * so any earlier restart-exhaustion row no longer describes live work.
   */
  private unwatch(key: string, host: TeamPrSweepHost): void {
    this.forget(key);
    const separator = key.lastIndexOf("#");
    const prNumber = Number(key.slice(separator + 1));
    if (Number.isSafeInteger(prNumber)) {
      host.resolveBaseSync?.(key.slice(0, separator), prNumber);
    }
  }

  /** Drop in-memory tracking for a PR without touching its escalation row. */
  private forget(key: string): void {
    this.watched.delete(key);
    this.prCache.delete(key);
    this.skippedAuthors.delete(key);
  }
}
