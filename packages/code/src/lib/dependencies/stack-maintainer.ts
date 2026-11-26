/**
 * Stacked PR maintenance: keep a stacked task's PR correct while the PR it is
 * stacked on moves, merges, or closes.
 *
 * A stacked task (see `gate.ts`, `stacked-base.ts`) opens its PR against its
 * dependency's branch. Each pass, for every settled stacked task:
 *
 * - **Base open, new commits** (e.g. review fixes, or the base was itself
 *   restacked): rebase the stacked branch onto the base's new head, stripping
 *   the commits of the base head it was last built on, and force-push with a
 *   lease. This also covers chains A → B → C: restacking B moves B's head, so
 *   C is restacked onto it on the same (or next) pass.
 * - **Base merged**: retarget the stacked PR to the branch the base merged
 *   into (normally the default branch) unless the host already did (GitHub
 *   retargets on its own when the base branch is deleted), then rebase it
 *   onto that branch, dropping the base's original commits. After a squash
 *   merge those commits are not on the default branch, so without this the PR
 *   shows the base's changes again and usually conflicts. The record is
 *   updated so later gating treats the PR as targeting its new base.
 * - **Base closed without merging**: post one comment on the stacked PR and
 *   record the block in the row's `stack_notice`, which the dependency gate
 *   reads (dependents show `blocked` in `worker queue`). The stacked task's own
 *   run is left as it was, so if the base is reopened (and merged) later the
 *   notice is cleared and maintenance resumes. The PR is not retargeted. The
 *   notice is also cleared once the PR is retargeted by hand off the base's
 *   branch, or the stacked PR itself merges or closes.
 *
 * A rebase that conflicts is aborted and left to the review poller's base
 * sync (a conflict-resolution agent run), which picks the PR up once the code
 * host reports it conflicting. Only providers whose {@link StackHost} answers
 * are maintained (GitHub today); others are skipped. A PR with a follow-up
 * agent run in progress (review fixes, CI fix, base sync) is not restacked
 * until that run finishes ({@link StackMaintainerOptions.isPrBusy}).
 */

import type { DependencyFacts } from "./gate";
import { classifyDependency } from "./gate";

/** A settled task stacked on another task's branch (see `InjectedTaskStore.listStackedLinks`). */
export interface StackLink {
  /** Row id of the stacked (dependent) task. */
  id: number;
  taskKey: string;
  repo: string;
  /** Task key of the base it is stacked on. */
  stackedOn: string;
  /** Base head SHA the stacked branch was last built on, when recorded. */
  baseHeadSha?: string;
  /** Set once the PR was told its base closed without merging. */
  notice?: string;
}

/**
 * Order links so each base comes before the links stacked on it (a chain
 * A → B → C lists B before C): restacking B moves the branch C is built on.
 */
export function orderStackLinks<T extends Pick<StackLink, "taskKey" | "stackedOn">>(
  links: readonly T[],
): T[] {
  const byKey = new Map(links.map((link) => [link.taskKey, link]));
  const ordered: T[] = [];
  const placed = new Set<string>();
  const place = (link: T, depth: number): void => {
    if (placed.has(link.taskKey)) return;
    const base = byKey.get(link.stackedOn);
    // The depth bound stops a corrupt stacked_on loop.
    if (base && depth < links.length) place(base, depth + 1);
    if (placed.has(link.taskKey)) return;
    placed.add(link.taskKey);
    ordered.push(link);
  };
  for (const link of links) place(link, 0);
  return ordered;
}

/** A PR as the code host reports it right now. */
export interface StackPrSnapshot {
  number: number;
  state: "open" | "merged" | "closed";
  /** Source branch. */
  headRef: string;
  /** Source branch tip; for a merged PR, its head when it merged. */
  headSha: string;
  /** Target branch; for a merged PR, the branch it merged into. */
  baseRef: string;
  url?: string;
}

/** Code-host operations the maintainer needs. */
export interface StackHost {
  /** The PR's live state, or `null` when this host/repo is not supported. */
  getPr(repo: string, prNumber: number): Promise<StackPrSnapshot | null>;
  /** Change the PR's target branch. */
  retarget(repo: string, prNumber: number, base: string): Promise<void>;
  /** Post (or update) the maintainer's one explanatory comment on the PR. */
  postNotice(repo: string, prNumber: number, body: string): Promise<void>;
}

/** Outcome of one restack attempt. */
export type RestackResult =
  /** Rebased and force-pushed; `baseSha` is the base tip it now sits on. */
  | { kind: "restacked"; headSha: string; baseSha: string }
  /** Already built on the base tip; nothing pushed. */
  | { kind: "up-to-date"; baseSha: string }
  /** The rebase conflicted and was aborted; nothing pushed. */
  | { kind: "conflict"; detail: string }
  /** The branch moved (or the lease failed); retry on a later pass. */
  | { kind: "stale"; detail: string }
  /** The remote refused the push (hook, protection, permission); nothing pushed. */
  | { kind: "push-rejected"; detail: string };

/** Git operations the maintainer needs. */
export interface StackGit {
  /**
   * Rebase `branch` onto `origin/<onto>`, dropping every commit reachable
   * from the first of `oldBaseCandidates` that the branch contains (falling
   * back to its merge base with `onto`), then push with
   * `--force-with-lease=<branch>:<expectedHeadSha>`.
   */
  restack(input: {
    repo: string;
    branch: string;
    expectedHeadSha: string;
    onto: string;
    oldBaseCandidates: string[];
  }): Promise<RestackResult>;
}

/** Registry access the maintainer needs. */
export interface StackStore {
  listStackedLinks(): StackLink[];
  dependencyFacts(taskKeys: readonly string[]): DependencyFacts[];
  setStackedOn(id: number, stackedOnTaskKey: string | null): void;
  setStackBaseSha(id: number, sha: string | null): void;
  setStackNotice(id: number, notice: string | null): void;
}

export interface StackMaintainerOptions {
  store: StackStore;
  host: StackHost;
  git: StackGit;
  /**
   * Whether an agent run is working on this PR right now (a review follow-up,
   * CI fix, or base sync in its own worktree). Restacking under it would race
   * its push, so the link is retried on a later pass.
   */
  isPrBusy?: (repo: string, prNumber: number, branch: string) => boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** What one link's pass did (tests and logs). */
export type StackLinkOutcome =
  | "skipped"
  | "unchanged"
  | "restacked"
  | "retargeted"
  | "conflict"
  | "stale"
  | "rejected"
  | "busy"
  | "notified"
  | "unblocked";

/** Hidden marker opening the maintainer's comment, so it is posted once. */
export const STACK_NOTICE_MARKER = "<!-- devintern:stack-blocked -->";

function prNumberOf(facts: DependencyFacts | undefined): number | undefined {
  return facts?.pr?.number ?? facts?.latestRun?.prNumber;
}

/**
 * What a person can do when the PR a stack builds on closed without merging.
 * Shared by the closed-base PR notice and a stacked run's escalation.
 *
 * @param pr - The base PR, as Markdown (`[PR #12](url)` or `PR #12`)
 */
export function stackBaseRecoveryHint(baseTaskKey: string, pr: string): string {
  return `Reopen and merge ${pr}, or re-queue ${baseTaskKey} (\`devintern worker add --resume ${baseTaskKey}\`)`;
}

/** Render the comment posted when a stacked PR's base closed without merging. */
export function renderStackBlockedNotice(input: {
  baseTaskKey: string;
  basePrNumber: number;
  basePrUrl?: string;
  baseBranch: string;
}): string {
  const pr = input.basePrUrl
    ? `[PR #${input.basePrNumber}](${input.basePrUrl})`
    : `PR #${input.basePrNumber}`;
  return [
    STACK_NOTICE_MARKER,
    `⛔ This PR is blocked: it is stacked on ${input.baseTaskKey} (${pr}), which was closed without merging.`,
    "",
    `It still targets \`${input.baseBranch}\` and contains that PR's commits, so DevIntern will not retarget or restack it.`,
    `${stackBaseRecoveryHint(input.baseTaskKey, pr)}, or retarget this PR by hand.`,
  ].join("\n");
}

/**
 * Maintains stacked PRs. Stateless across passes except for small in-memory
 * caches; everything that must survive a restart is in {@link StackStore}.
 */
export class StackMaintainer {
  /**
   * Restacks that cannot succeed until a head or base moves (a conflict handed
   * to base sync, or a push the remote refused), per `repo#pr:head:base`.
   */
  private readonly settled = new Map<string, RestackResult>();
  /** Stacked PRs seen merged this process (final); never re-fetched. */
  private readonly merged = new Set<string>();

  constructor(private readonly options: StackMaintainerOptions) {}

  private log(message: string): void {
    (this.options.log ?? console.log)(message);
  }

  private warn(message: string): void {
    (this.options.warn ?? console.warn)(message);
  }

  /** One pass over every stacked link; per-link failures are logged, not thrown. */
  async tick(): Promise<Map<string, StackLinkOutcome>> {
    const outcomes = new Map<string, StackLinkOutcome>();
    // Heads this pass pushed, per `repo#branch`: the host's API can lag a
    // push, and a link stacked on a just-restacked base must see the new head.
    const pushed = new Map<string, string>();
    for (const link of this.options.store.listStackedLinks()) {
      try {
        outcomes.set(link.taskKey, await this.maintain(link, pushed));
      } catch (error) {
        this.warn(
          `⚠️  [stacked-prs] ${link.taskKey}: could not maintain its stacked PR: ${(error as Error).message}`,
        );
        outcomes.set(link.taskKey, "skipped");
      }
    }
    return outcomes;
  }

  private async maintain(link: StackLink, pushed: Map<string, string>): Promise<StackLinkOutcome> {
    const { store, host } = this.options;
    const [dependent, base] = store.dependencyFacts([link.taskKey, link.stackedOn]);
    if (!dependent || dependent.latestRun?.status !== "succeeded") return "skipped";
    if (dependent.pr?.state === "merged") return this.settleStackedPr(link, "merged");
    const prNumber = prNumberOf(dependent);
    const basePrNumber = prNumberOf(base);
    if (prNumber === undefined || basePrNumber === undefined || !base) return "skipped";
    const mergedKey = `${link.repo}#${prNumber}`;
    if (this.merged.has(mergedKey)) return "skipped";

    // A closed stacked PR is fetched again each pass (ETag-cached) so a reopen
    // resumes maintenance; only a merge is final.
    const pr = await host.getPr(link.repo, prNumber);
    if (!pr) return "skipped";
    if (pr.state !== "open") {
      if (pr.state === "merged") this.merged.add(mergedKey);
      return this.settleStackedPr(link, pr.state);
    }
    const basePr = await host.getPr(link.repo, basePrNumber);
    if (!basePr) return "skipped";
    const label = `${link.taskKey} PR #${prNumber}`;
    const baseLabel = `${link.stackedOn} PR #${basePrNumber}`;

    if (basePr.state === "closed") return this.notifyClosedBase(link, pr, basePr, base);
    if (link.notice) {
      await this.clearNotice(
        link,
        pr,
        `${link.stackedOn} PR #${basePr.number} is ${basePr.state === "merged" ? "merged" : "open again"}`,
      );
    }

    if (this.options.isPrBusy?.(link.repo, prNumber, pr.headRef)) {
      this.log(`   [stacked-prs] ${label} has an agent run in progress; retrying next pass`);
      return "busy";
    }

    if (basePr.state === "open") {
      if (pr.baseRef !== basePr.headRef) {
        // Retargeted by hand somewhere else: no longer ours to restack.
        return "skipped";
      }
      const baseHead = pushed.get(`${link.repo}#${basePr.headRef}`) ?? basePr.headSha;
      if (link.baseHeadSha === baseHead) return "unchanged";
      const result = await this.restack(link, pr, basePr.headRef, [link.baseHeadSha]);
      return this.settleOpenRestack(link, pr, result, pushed, `${baseLabel} moved`);
    }

    return this.followMergedBase(link, pr, basePr, base, pushed);
  }

  /** Base merged: move the PR to the branch the base merged into, then restack. */
  private async followMergedBase(
    link: StackLink,
    pr: StackPrSnapshot,
    basePr: StackPrSnapshot,
    base: DependencyFacts,
    pushed: Map<string, string>,
  ): Promise<StackLinkOutcome> {
    const { store, host } = this.options;
    const prNumber = pr.number;
    const label = `${link.taskKey} PR #${prNumber}`;
    const baseLabel = `${link.stackedOn} PR #${basePr.number}`;
    const target = basePr.baseRef;
    if (pr.baseRef === basePr.headRef) {
      await host.retarget(link.repo, prNumber, target);
      this.log(`🎯 [stacked-prs] ${label} retargeted to ${target}: ${baseLabel} merged`);
    } else if (pr.baseRef !== target) {
      // Neither the base's branch nor its merge target: a human chose it.
      return "skipped";
    } else {
      this.log(`   [stacked-prs] ${label} already targets ${target} (${baseLabel} merged)`);
    }
    const result = await this.restack(link, pr, target, [basePr.headSha, link.baseHeadSha]);
    if (result.kind === "stale") {
      this.log(`   [stacked-prs] ${label} moved while restacking; retrying next pass`);
      return "stale";
    }
    if (result.kind === "restacked") {
      pushed.set(`${link.repo}#${pr.headRef}`, result.headSha);
      this.log(`🧱 [stacked-prs] ${label} restacked onto ${target} (${short(result.baseSha)})`);
    } else if (result.kind === "conflict") {
      this.log(
        `⚠️  [stacked-prs] ${label} conflicts with ${target}; leaving it to base sync ` +
          `(conflict resolution): ${result.detail}`,
      );
    }
    // A rejected push was already warned about in restack(); hand the link off
    // like a conflict so it is not rebased and refused again every pass.
    // The PR now targets the base's merge target. If that is the base's own
    // stack base (the base merged into another task's branch), keep stacking
    // on that task; otherwise it is no longer stacked.
    const next = base.stackBase;
    const nextBranch = next ? (next.pr?.branch ?? next.latestRun?.branch) : undefined;
    const stackedOn = next && nextBranch === target ? next.key : null;
    store.setStackedOn(link.id, stackedOn);
    store.setStackBaseSha(link.id, null);
    if (result.kind === "push-rejected") return "rejected";
    return result.kind === "conflict" ? "conflict" : "retargeted";
  }

  private async restack(
    link: StackLink,
    pr: StackPrSnapshot,
    onto: string,
    candidates: Array<string | undefined>,
  ): Promise<RestackResult> {
    const key = `${link.repo}#${pr.number}:${pr.headSha}:${onto}:${candidates.join(",")}`;
    const settled = this.settled.get(key);
    if (settled?.kind === "conflict")
      return { kind: "conflict", detail: "already handed to base sync" };
    if (settled) return { kind: "push-rejected", detail: "already reported" };
    const result = await this.options.git.restack({
      repo: link.repo,
      branch: pr.headRef,
      expectedHeadSha: pr.headSha,
      onto,
      oldBaseCandidates: candidates.filter((sha): sha is string => Boolean(sha)),
    });
    if (result.kind === "conflict") this.settled.set(key, result);
    if (result.kind === "push-rejected") {
      this.settled.set(key, result);
      this.warn(
        `⚠️  [stacked-prs] ${link.taskKey} PR #${pr.number}: the remote rejected the restack push ` +
          `onto ${onto}; not retrying until the PR or its base moves. Restack it by hand ` +
          `or fix the push permission: ${result.detail}`,
      );
    }
    return result;
  }

  private settleOpenRestack(
    link: StackLink,
    pr: StackPrSnapshot,
    result: RestackResult,
    pushed: Map<string, string>,
    why: string,
  ): StackLinkOutcome {
    const label = `${link.taskKey} PR #${pr.number}`;
    switch (result.kind) {
      case "restacked":
        pushed.set(`${link.repo}#${pr.headRef}`, result.headSha);
        this.options.store.setStackBaseSha(link.id, result.baseSha);
        this.log(`🧱 [stacked-prs] ${label} restacked onto ${short(result.baseSha)}: ${why}`);
        return "restacked";
      case "up-to-date":
        this.options.store.setStackBaseSha(link.id, result.baseSha);
        return "unchanged";
      case "conflict":
        this.log(
          `⚠️  [stacked-prs] ${label} conflicts with its base; leaving it to base sync ` +
            `(conflict resolution): ${result.detail}`,
        );
        return "conflict";
      case "stale":
        return "stale";
      case "push-rejected":
        return "rejected";
    }
  }

  private async notifyClosedBase(
    link: StackLink,
    pr: StackPrSnapshot,
    basePr: StackPrSnapshot,
    base: DependencyFacts,
  ): Promise<StackLinkOutcome> {
    if (pr.baseRef !== basePr.headRef) {
      // Retargeted by hand off the closed base: no longer ours, and no longer
      // blocked by it.
      if (link.notice) {
        await this.clearNotice(link, pr, `now targets ${pr.baseRef}`);
        return "unblocked";
      }
      return "skipped";
    }
    if (link.notice) return "unchanged";
    // Reuse the dependency gate's wording for a closed base.
    const status = classifyDependency({
      ...base,
      pr: { number: basePr.number, url: basePr.url, branch: basePr.headRef, state: "closed" },
    });
    const reason =
      status.state === "blocked"
        ? status.reason
        : `${link.stackedOn} PR #${basePr.number} closed without merging`;
    await this.options.host.postNotice(
      link.repo,
      pr.number,
      renderStackBlockedNotice({
        baseTaskKey: link.stackedOn,
        basePrNumber: basePr.number,
        basePrUrl: basePr.url ?? base.pr?.url,
        baseBranch: pr.baseRef,
      }),
    );
    const notice = `blocked: ${reason}`;
    this.options.store.setStackNotice(link.id, notice);
    this.warn(`⛔ [stacked-prs] ${link.taskKey} PR #${pr.number} ${notice}`);
    return "notified";
  }

  /**
   * The stacked PR itself merged or closed: its own PR state now decides its
   * dependents (the gate ignores the stack block), so drop the stale block.
   * `stacked_on` stays: the gate still needs it to tell whether a merge into
   * the base's branch reached the default branch.
   */
  private settleStackedPr(link: StackLink, state: "merged" | "closed"): StackLinkOutcome {
    if (link.notice) {
      this.options.store.setStackNotice(link.id, null);
      link.notice = undefined;
      this.log(`   [stacked-prs] ${link.taskKey} PR ${state}; cleared its stack block`);
    }
    return "skipped";
  }

  /**
   * The closed-base block no longer applies (the base was reopened or merged,
   * or the PR was retargeted by hand): lift it and replace the PR comment.
   */
  private async clearNotice(link: StackLink, pr: StackPrSnapshot, why: string): Promise<void> {
    await this.options.host.postNotice(
      link.repo,
      pr.number,
      [STACK_NOTICE_MARKER, `✅ ${why}; this PR is no longer blocked by DevIntern.`].join("\n"),
    );
    this.options.store.setStackNotice(link.id, null);
    link.notice = undefined;
    this.log(`   [stacked-prs] ${link.taskKey} PR #${pr.number} unblocked: ${why}`);
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
