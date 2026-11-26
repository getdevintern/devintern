/**
 * Auto-merge for the agent's own pull requests (`devintern auto-merge`).
 *
 * A PR is merged only after passing every gate, cheapest first:
 *
 * 0. Preconditions (always): open, not a draft, not a fork, GitHub reports
 *    it mergeable (`mergeable_state` `clean`/`has_hooks`), and no reviewer's
 *    latest review requests changes.
 * 1. Path policy (deterministic, `merge-gate.ts`): a deny-glob hit blocks the
 *    merge outright; a PR touching only safe globs (and no review glob)
 *    merges with no agent run.
 *    CI checks (`ci-checks.ts`) run right after the path classification,
 *    before any merge or agent run, because safe-path-only PRs may merge
 *    without a passing check: no check failing or pending, and (for code
 *    PRs, unless `allowNoChecks`) at least one `success`. `clean` alone is
 *    not enough, since GitHub reports it for commits with no checks at all.
 *    These waits are reported as the "Ready" gate.
 * 2. Agent review (optional): PRs that touch anything outside the safe globs,
 *    or any review glob, merge only on an explicit `"safe": true` verdict. A missing, malformed,
 *    or negative verdict never merges.
 *
 * The merge call is pinned to the evaluated head SHA, and the PR is
 * re-fetched right before it, so commits pushed during the review can never
 * ride along. Every "not yet" condition returns `waiting` without side
 * effects, except CI waits, which post the status comment and the review
 * label so a PR held by missing or red CI says so; the worker re-evaluates
 * later.
 */

import { runAgent } from "./address";
import { parseChangeRequestUrl } from "../code-host/index";
import { listCheckRunsForRef, listLatestCommitStatuses } from "../code-host/github/commit-checks";
import { GitHubReviewsClient } from "../code-host/github/reviews";
import type {
  PullRequestFile,
  PullRequestInfo,
  PullRequestMergeResult,
} from "../code-host/github/reviews-types";
import { Utils } from "../utils";
import { AUTO_MERGE_COMMENT_MARKER, buildAutoMergeStatusComment } from "./auto-merge-comment";
import type { AutoMergeCommentStatus, LeftOpenReason } from "./auto-merge-comment";
import { evaluateCiChecks, normalizeCiChecks } from "./ci-checks";
import type { CiCheck, CiChecksProblem, CiChecksVerdict } from "./ci-checks";
import {
  classifyChangedPaths,
  DEFAULT_MERGE_SAFETY_POLICY,
  parseMergeSafetyVerdict,
} from "./merge-gate";
import type { AutoMergeMethod, MergePathPolicy, MergeSafetyPolicy } from "./merge-gate";
import { buildMergeSafetyPrompt } from "./merge-safety-prompt";
import { loadMergeSafetyRules, mergeSafetyPolicyLabel } from "./merge-safety-rules";

/** Full auto-merge policy for one repository. */
export interface AutoMergePolicy extends MergePathPolicy {
  /** Ask the agent about PRs that leave the safe paths (otherwise skip them). */
  review: boolean;
  method: AutoMergeMethod;
  /**
   * Label added to PRs left open for a human and removed when auto-merge
   * merges them. Unset or empty disables labeling.
   */
  reviewLabel?: string;
  /** Merge-safety review strictness; unset means `strict`. */
  reviewPolicy?: MergeSafetyPolicy;
  /**
   * `auto_merge_allow_no_checks`: a code PR may merge without a passing CI
   * check (failing or pending checks still block). Unset means false.
   */
  allowNoChecks?: boolean;
  /**
   * Operator-written review rules (`auto_merge_review_instructions`),
   * appended in a marked section that can only add restrictions.
   */
  reviewInstructions?: string;
  /**
   * Review diffs over {@link MAX_REVIEW_DIFF_CHARS} from the checkout
   * (`auto_merge_review_large_diffs`, default off). Off leaves them open for
   * a human. Diffs over {@link MAX_CHECKOUT_REVIEW_DIFF_CHARS} always stay open.
   */
  reviewLargeDiffs?: boolean;
  /** `custom` policy: inline rubric text (`auto_merge_rules`). */
  rules?: string;
  /**
   * `custom` policy: absolute path of the rubric file
   * (`auto_merge_rules_file`), read on every review.
   */
  rulesFile?: string;
}

/**
 * - `merged` / `would-merge` (dry run): every gate passed.
 * - `rejected`: a gate said no for this head SHA; terminal until new commits.
 * - `waiting`: not ready yet (CI, draft, review requested, head moved).
 * - `skipped`: never applicable (closed, fork, unsupported host).
 * - `failed`: an error; retried with a cap.
 * - `deferred`: agent usage limit; retried later.
 */
export type AutoMergeOutcome =
  | "merged"
  | "would-merge"
  | "rejected"
  | "waiting"
  | "skipped"
  | "failed"
  | "deferred";

export const AUTO_MERGE_OUTCOMES: readonly AutoMergeOutcome[] = [
  "merged",
  "would-merge",
  "rejected",
  "waiting",
  "skipped",
  "failed",
  "deferred",
];

export interface AutoMergeResult {
  outcome: AutoMergeOutcome;
  message: string;
  /** Whether the agent review ran (tokens were spent). */
  reviewed: boolean;
  /** `deferred` on an agent usage limit: when the quota returns (ms epoch). */
  retryAt?: number;
  /**
   * `waiting` on the head commit's CI checks: the PR got a status comment
   * and the review label, and is checked again on the same commit.
   */
  ciWait?: boolean;
  /** With {@link AutoMergeResult.ciWait}: which CI problem the PR waits on. */
  ciWaitProblem?: CiChecksProblem;
  /**
   * `waiting` on an `unstable`/`blocked` state whose CI checks could not be
   * read, so whether the checks are the hold is unknown (retry soon).
   */
  ciChecksUnread?: boolean;
}

/** GitHub operations on one PR (injected for tests). */
export interface AutoMergeGitHub {
  getPullRequest(): Promise<PullRequestInfo>;
  listFiles(): Promise<PullRequestFile[]>;
  listReviews(): Promise<Array<{ state: string; user: { login: string } | null }>>;
  getDiff(): Promise<string>;
  /** Every check run and legacy commit status on `sha`; throws when it cannot read them all. */
  listCiChecks(sha: string): Promise<CiCheck[]>;
  merge(sha: string, method: AutoMergeMethod): Promise<PullRequestMergeResult>;
  /** Create or edit the PR's auto-merge status comment. */
  upsertStatusComment(body: string): Promise<void>;
  /** Add a label to the PR (GitHub creates a missing label). */
  addLabel(label: string): Promise<void>;
  /** Remove a label from the PR; absent labels are not an error. */
  removeLabel(label: string): Promise<void>;
}

export interface AutoMergeOptions {
  policy: AutoMergePolicy;
  /** Head SHA the worker's precheck saw; a different head means `waiting`. */
  expectedHeadSha?: string;
  /** Evaluate every gate (including the agent review) but do not merge. */
  dryRun?: boolean;
  /**
   * This is the head's final allowed attempt (the worker gives up after it):
   * a failure is stated on the PR instead of ending silently.
   */
  lastAttempt?: boolean;
  /** Skip PR comments (tests). */
  noComment?: boolean;
  /**
   * {@link ciWaitKey} of the CI wait this head's status comment already
   * shows (from the worker's previous check): the same wait again skips
   * re-posting it.
   */
  ciWaitPosted?: string;
  /** Time limit for reading the head commit's CI checks (default {@link CI_CHECKS_TIMEOUT_MS}). */
  ciChecksTimeoutMs?: number;
  verbose?: boolean;
  /** Source repository directory for the review worktree. */
  cwd?: string;
  github?: AutoMergeGitHub;
  /**
   * Agent runner (tests); defaults to the shared review agent. The verdict
   * is parsed from `stdout`, which falls back to `output` when absent.
   */
  agentRunner?: (
    prompt: string,
    workDir: string,
    verbose: boolean,
  ) => Promise<{ success: boolean; output: string; stdout?: string }>;
  /** Review checkout (tests); defaults to the branch-scoped review worktree. */
  worktree?: {
    prepare(
      branch: string,
    ): Promise<{ success: boolean; path?: string; error?: string; inUse?: boolean }>;
    remove(path: string): Promise<void>;
  };
  /**
   * Make the PR's base commit available in the review checkout (tests);
   * defaults to {@link ensureBaseCommit}. Used only for diffs too large to
   * inline in the prompt.
   */
  baseCommit?: (
    workDir: string,
    base: PullRequestRefs,
  ) => Promise<{ success: boolean; error?: string }>;
}

/** Base and head of a pull request, as validated commit SHAs. */
export interface PullRequestRefs {
  baseRef: string;
  baseSha: string;
  headSha: string;
}

/**
 * Diffs above this size are not inlined in the prompt: the agent inspects
 * them with `git diff` in the review checkout instead.
 */
export const MAX_REVIEW_DIFF_CHARS = 150_000;

/**
 * Hard ceiling for a checkout review: diffs above it always stay open for a
 * human, even with `auto_merge_review_large_diffs` on. Kept near what one
 * agent context can hold (~100k tokens), so paging the whole diff does not
 * rely on the harness keeping hundreds of thousands of tokens of output.
 */
export const MAX_CHECKOUT_REVIEW_DIFF_CHARS = 400_000;

/** Upper bound for one base-commit fetch into the review checkout. */
const FETCH_TIMEOUT_MS = 120_000;

/** A full, lowercase SHA-1 commit id. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * A changed path a checkout review accepts: an allowlist of characters that
 * are inert in an unquoted POSIX shell word, with no path segment starting
 * with `-` (which a command could read as an option). Any other path leaves
 * the PR open, so a crafted filename cannot become shell syntax even if the
 * agent strays from the paging commands and types it, quoted or not.
 */
const SHELL_SAFE_PATH = /^(?!-)(?!.*\/-)[A-Za-z0-9._\/@+=,:-]+$/;

/** Transcript label for the merge-safety agent (distinct from review replies). */
export const MERGE_SAFETY_REVIEW_LOG_LABEL = "merge-safety-review";

/** Time limit for reading the head commit's check runs and statuses. */
export const CI_CHECKS_TIMEOUT_MS = 60_000;

/** Prefix of messages for waits reported under the "Ready" gate (gate 1 in the docs). */
const READY_GATE_PREFIX = "Ready gate: ";

/**
 * `mergeable_state` values meaning "mergeable"; with no checks at all GitHub
 * still reports `clean`, so CI is checked separately (`ciChecksGate`).
 */
const MERGEABLE_STATES = new Set(["clean", "has_hooks"]);

/** Human explanation for a `mergeable_state` that is not ready. */
function describeMergeableState(state: string | undefined): string {
  switch (state) {
    case "dirty":
      return "the branch conflicts with its base";
    case "behind":
      return "the branch is behind its base";
    case "blocked":
      return "branch protection blocks the merge (required reviews or checks)";
    case "unstable":
      return "checks are failing or still running";
    case "draft":
      return "the pull request is a draft";
    default:
      return "GitHub is still computing mergeability";
  }
}

/** Reviewers whose most recent decisive review requests changes. */
export function outstandingChangeRequests(
  reviews: ReadonlyArray<{ state: string; user: { login: string } | null }>,
): string[] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    // Comments do not change a reviewer's decision; dismissals clear it.
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(login, review.state);
  }
  return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login);
}

/** HTTP status embedded in a GitHub client error message, if any. */
function gitHubErrorStatus(error: unknown): number | undefined {
  const match = /GitHub API error \((\d{3})\)/.exec(
    error instanceof Error ? error.message : String(error),
  );
  return match ? Number(match[1]) : undefined;
}

function defaultGitHub(owner: string, repo: string, prNumber: number): AutoMergeGitHub {
  const client = new GitHubReviewsClient();
  return {
    getPullRequest: () => client.getPullRequest(owner, repo, prNumber),
    listFiles: () => client.listPullRequestFiles(owner, repo, prNumber),
    listReviews: () => client.listPullRequestReviews(owner, repo, prNumber),
    getDiff: () => client.getPullRequestDiff(owner, repo, prNumber),
    listCiChecks: async (sha) => {
      const [runs, statuses] = await Promise.all([
        listCheckRunsForRef(client, owner, repo, sha),
        listLatestCommitStatuses(client, owner, repo, sha),
      ]);
      if (!runs.complete || !statuses.complete) {
        throw new Error("GitHub returned only part of the commit's checks");
      }
      return normalizeCiChecks(runs.checkRuns, statuses.statuses);
    },
    merge: (sha, method) => client.mergePullRequest(owner, repo, prNumber, { sha, method }),
    upsertStatusComment: (body) =>
      client.upsertMarkedIssueComment(owner, repo, prNumber, AUTO_MERGE_COMMENT_MARKER, body),
    addLabel: (label) => client.addIssueLabels(owner, repo, prNumber, [label]),
    removeLabel: (label) => client.removeIssueLabel(owner, repo, prNumber, label),
  };
}

type Precondition = Pick<AutoMergeResult, "outcome" | "message">;

/** Gate 0 without `mergeable_state`: open, not a fork, not a draft, head unchanged. */
function identityFailure(
  pr: PullRequestInfo,
  baseRepo: string,
  expectedHeadSha: string | undefined,
): Precondition | null {
  if (pr.state !== "open") return { outcome: "skipped", message: `PR is ${pr.state}` };
  if (pr.head.repo && pr.head.repo.full_name.toLowerCase() !== baseRepo.toLowerCase()) {
    return { outcome: "skipped", message: "fork PRs are never auto-merged" };
  }
  if (pr.draft) return { outcome: "waiting", message: describeMergeableState("draft") };
  if (expectedHeadSha && pr.head.sha !== expectedHeadSha) {
    return { outcome: "waiting", message: "PR head moved since it was checked" };
  }
  return null;
}

/** Gate 0's `mergeable_state` part; `null` means GitHub reports the PR mergeable. */
function mergeableStateFailure(pr: PullRequestInfo): Precondition | null {
  if (MERGEABLE_STATES.has(pr.mergeable_state ?? "")) return null;
  return { outcome: "waiting", message: describeMergeableState(pr.mergeable_state) };
}

/** Gate 0 on a freshly fetched PR; `null` means ready. */
function preconditionFailure(
  pr: PullRequestInfo,
  baseRepo: string,
  expectedHeadSha: string | undefined,
): Precondition | null {
  return identityFailure(pr, baseRepo, expectedHeadSha) ?? mergeableStateFailure(pr);
}

/**
 * `mergeable_state` values GitHub uses when commit checks hold the PR:
 * `unstable` (a non-required check is failing or pending) and `blocked`
 * (a required check has not passed, or another branch-protection rule).
 */
const CI_HELD_STATES = new Set(["unstable", "blocked"]);

/** Context shared by the gate helpers for one evaluation. */
interface GateContext {
  options: AutoMergeOptions;
  github: AutoMergeGitHub;
  baseRepo: string;
  prNumber: number;
  pr: PullRequestInfo;
}

/** Outcome of gates 1 and 2: merge (with why) or stop (with a result). */
type MergeDecision =
  | { kind: "merge"; reason: string; viaReview: boolean; reviewed: boolean }
  | {
      kind: "stop";
      outcome: AutoMergeOutcome;
      message: string;
      reviewed: boolean;
      /** Set when the PR is left open: what its status comment explains. */
      leftOpen?: LeftOpenReason;
      /** Waiting on CI checks (see {@link AutoMergeResult.ciWait}). */
      ciWait?: boolean;
      /** With `ciWait`: the CI problem. */
      ciWaitProblem?: CiChecksProblem;
    };

const stop = (outcome: AutoMergeOutcome, message: string, reviewed = false): MergeDecision => ({
  kind: "stop",
  outcome,
  message,
  reviewed,
});

type StopDecision = Extract<MergeDecision, { kind: "stop" }>;

/** A rejection: the PR stays open, and its status comment says why. */
const leaveOpen = (message: string, leftOpen: LeftOpenReason, reviewed = false): StopDecision => ({
  kind: "stop",
  outcome: "rejected",
  message,
  reviewed,
  leftOpen,
});

/** Reject after `ms` with `message`; the timer never outlives the race. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CI part of the Ready gate; `null` means CI lets the PR merge. Runs after
 * the path classification because a safe-path-only PR (`safeOnly`) needs no
 * passing check. Failing or pending checks always wait; a read error fails
 * closed as a retryable failure.
 */
async function ciChecksGate(ctx: GateContext, safeOnly: boolean): Promise<MergeDecision | null> {
  const read = await readCiChecks(ctx);
  if (!read.ok) {
    const detail = `The CI check status for this commit could not be read: ${read.error}.`;
    return {
      kind: "stop",
      outcome: "failed",
      message: `${READY_GATE_PREFIX}${detail}`,
      reviewed: false,
      leftOpen: { kind: "ci-checks", problem: "unreadable", detail },
    };
  }
  const verdict = evaluateCiChecks(read.checks, {
    requireSuccess: !safeOnly && !ctx.options.policy.allowNoChecks,
  });
  return verdict.ready ? null : ciWaitDecision(verdict);
}

/** The head commit's checks, read under the time limit. */
async function readCiChecks(
  ctx: GateContext,
): Promise<{ ok: true; checks: CiCheck[] } | { ok: false; error: string }> {
  const timeoutMs = ctx.options.ciChecksTimeoutMs ?? CI_CHECKS_TIMEOUT_MS;
  try {
    const checks = await withTimeout(
      ctx.github.listCiChecks(ctx.pr.head.sha),
      timeoutMs,
      `timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
    return { ok: true, checks };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Gate 0 when GitHub reports `unstable` or `blocked`: if a failing or
 * pending check on the head is why, the PR waits with that reason in its
 * status comment and label (as the CI part of the Ready gate would).
 * `hold: null` when the checks don't explain the state (another protection
 * rule, or they could not be read, flagged by `checksRead: false`): the
 * plain `mergeable_state` wait applies.
 */
async function ciHoldFromMergeableState(
  ctx: GateContext,
): Promise<{ hold: MergeDecision | null; checksRead: boolean }> {
  if (!CI_HELD_STATES.has(ctx.pr.mergeable_state ?? "")) return { hold: null, checksRead: true };
  const read = await readCiChecks(ctx);
  if (!read.ok) return { hold: null, checksRead: false };
  // Failing and pending checks are reported before the success requirement.
  const verdict = evaluateCiChecks(read.checks, { requireSuccess: false });
  return { hold: verdict.ready ? null : ciWaitDecision(verdict), checksRead: true };
}

/** A wait on the head commit's CI checks (status comment, label, dashboard). */
function ciWaitDecision(verdict: Extract<CiChecksVerdict, { ready: false }>): MergeDecision {
  return {
    kind: "stop",
    outcome: "waiting",
    message: `${READY_GATE_PREFIX}${verdict.message}`,
    reviewed: false,
    leftOpen: { kind: "ci-checks", problem: verdict.problem, detail: verdict.message },
    ciWait: true,
    ciWaitProblem: verdict.problem,
  };
}

/**
 * Identity of a CI wait for "already posted" checks. Pending checks are one
 * wait however the list of running checks shrinks; other problems are keyed
 * by their message, so a changed failure list updates the comment.
 */
export function ciWaitKey(problem: CiChecksProblem | undefined, message: string): string {
  return problem === "pending" ? "ci-pending" : message;
}

/** Paths that passed the path policy: safe-only, or what the agent reviews. */
type PathsAdmitted =
  | { kind: "safe" }
  | { kind: "review"; files: PullRequestFile[]; outsideSafe: string[]; reviewMatches: string[] };

/**
 * Path part of gate 1: a final rejection (deny path, unevaluable, or code
 * paths with agent review disabled) or what the rest of the gates check.
 * Runs before any CI wait, so a PR that can never merge automatically gets
 * its rejection instead of a (retried) CI wait.
 */
async function pathGate(ctx: GateContext): Promise<StopDecision | PathsAdmitted> {
  const { options, github, pr } = ctx;
  const { policy } = options;

  const files = await github.listFiles();
  if (pr.changed_files !== undefined && files.length < pr.changed_files) {
    const detail = `GitHub listed only ${files.length} of ${pr.changed_files} changed files`;
    return leaveOpen(`${detail}; too large to evaluate`, { kind: "not-evaluable", detail });
  }
  const classification = classifyChangedPaths(
    files.map((file) => ({ path: file.filename, previousPath: file.previous_filename })),
    policy,
  );
  if (classification.kind === "denied") {
    const { path, pattern } = classification;
    return leaveOpen(`${path} matches deny pattern ${pattern}`, { kind: "denied", path, pattern });
  }
  if (classification.kind === "invalid") {
    return leaveOpen(classification.reason, {
      kind: "not-evaluable",
      detail: classification.reason,
    });
  }
  if (classification.kind === "safe") return { kind: "safe" };
  const { outside, reviewMatches } = classification;
  // A review-path match goes to its own prompt list, even if it is also outside the safe paths.
  const outsideSafe = outside.filter((path) => !reviewMatches.includes(path));
  // With review disabled a code PR can never merge automatically.
  if (!policy.review) {
    return leaveOpen(
      `${outside.length} changed path(s) need review (e.g. ${outside[0]}) ` +
        "and agent review is disabled",
      { kind: "outside-safe-paths", paths: outsideSafe, reviewPathMatches: reviewMatches },
    );
  }
  return { kind: "review", files, outsideSafe, reviewMatches };
}

/** Gates 1 (path policy, then CI checks) and 2 (agent review). */
async function decideMerge(ctx: GateContext): Promise<MergeDecision> {
  const { options, github, baseRepo, prNumber, pr } = ctx;
  const { policy } = options;

  const paths = await pathGate(ctx);
  if (paths.kind === "stop") return paths;
  if (paths.kind === "safe") {
    const ciWait = await ciChecksGate(ctx, true);
    if (ciWait) return ciWait;
    const reason = "every change is inside the configured safe paths";
    console.log(`✅ ${baseRepo}#${prNumber}: ${reason}; no agent review needed`);
    return { kind: "merge", reason, viaReview: false, reviewed: false };
  }
  const { files, outsideSafe, reviewMatches } = paths;
  const ciWait = await ciChecksGate(ctx, false);
  if (ciWait) return ciWait;

  const reviewPolicy = policy.reviewPolicy ?? DEFAULT_MERGE_SAFETY_POLICY;
  const policyLabel = mergeSafetyPolicyLabel(reviewPolicy, policy);
  // Custom rules are read now, not at config load, so file edits apply to
  // the next review. Unusable rules fail closed: the PR stays open.
  let rules: string | undefined;
  if (reviewPolicy === "custom") {
    const loaded = loadMergeSafetyRules(policy);
    if (!loaded.ok) {
      const where = policy.rulesFile ? ` (${policy.rulesFile})` : "";
      return leaveOpen(`merge-safety rules unavailable: ${loaded.problem}${where}`, {
        kind: "rules-unavailable",
        policy: policyLabel,
        problem: loaded.problem,
      });
    }
    rules = loaded.text;
  }
  const diff = await github.getDiff();
  // Too large to inline: left open, unless the policy opts in to a checkout
  // review where the agent diffs base...head itself.
  let refs: PullRequestRefs | undefined;
  if (diff.length > MAX_REVIEW_DIFF_CHARS) {
    if (!policy.reviewLargeDiffs || diff.length > MAX_CHECKOUT_REVIEW_DIFF_CHARS) {
      const limit = policy.reviewLargeDiffs
        ? MAX_CHECKOUT_REVIEW_DIFF_CHARS
        : MAX_REVIEW_DIFF_CHARS;
      const detail = `the diff is ${diff.length} characters, above the ${limit}-character review limit`;
      return leaveOpen(detail, { kind: "not-evaluable", detail });
    }
    if (!COMMIT_SHA.test(pr.base.sha) || !COMMIT_SHA.test(pr.head.sha)) {
      const detail =
        "the diff is too large to inline and GitHub did not report valid base and head commits";
      return leaveOpen(detail, { kind: "not-evaluable", detail });
    }
    const unsafePath = files
      .flatMap((file) => [file.filename, file.previous_filename ?? ""])
      .find((path) => path !== "" && !SHELL_SAFE_PATH.test(path));
    if (unsafePath !== undefined) {
      const detail =
        `the diff is too large to inline and the changed path ${JSON.stringify(unsafePath)} ` +
        "is not shell-safe (only letters, digits, and . _ / @ + = , : - are allowed, " +
        "and no path segment may start with -)";
      return leaveOpen(detail, { kind: "not-evaluable", detail });
    }
    refs = { baseRef: pr.base.ref, baseSha: pr.base.sha, headSha: pr.head.sha };
  }
  console.log(
    `🔎 ${baseRepo}#${prNumber}: ${outsideSafe.length} path(s) outside the safe paths, ` +
      `${reviewMatches.length} matching review paths; asking the agent` +
      (refs ? ` (diff of ${diff.length} characters reviewed from the checkout)` : ""),
  );
  const verdict = await reviewWithAgent({
    options,
    branch: pr.head.ref,
    headSha: pr.head.sha,
    refs,
    prompt: buildMergeSafetyPrompt({
      repository: baseRepo,
      prNumber,
      title: pr.title,
      reviewPaths: outsideSafe,
      alwaysReviewPaths: reviewMatches,
      diff,
      ...(refs ? { notInlined: { baseSha: refs.baseSha, headSha: refs.headSha } } : {}),
      policy: reviewPolicy,
      instructions: policy.reviewInstructions,
      rules,
    }),
  });
  if (verdict.kind === "base-unavailable") {
    const detail = `the diff is too large to inline and the base commit could not be prepared for review (${verdict.message})`;
    return leaveOpen(detail, { kind: "not-evaluable", detail });
  }
  if (verdict.kind !== "verdict") return stop(verdict.kind, verdict.message, verdict.ran);
  if (!verdict.safe) {
    return leaveOpen(
      `agent review: ${verdict.reason}`,
      {
        kind: "agent-unsafe",
        reason: verdict.reason,
        policy: policyLabel,
        ...(reviewMatches.length > 0 ? { reviewPathMatches: reviewMatches } : {}),
      },
      true,
    );
  }
  return { kind: "merge", reason: verdict.reason, viaReview: true, reviewed: true };
}

/** Re-check, merge pinned to the evaluated head, and announce it. */
async function mergeAtHead(
  ctx: GateContext,
  decision: Extract<MergeDecision, { kind: "merge" }>,
): Promise<Pick<AutoMergeResult, "outcome" | "message">> {
  const { options, github, baseRepo, pr } = ctx;
  const { policy, dryRun = false, verbose = false } = options;
  const message = decision.viaReview ? `agent review: ${decision.reason}` : decision.reason;

  // Re-check right before merging: the review can take minutes.
  const stale = preconditionFailure(await github.getPullRequest(), baseRepo, pr.head.sha);
  if (stale) return stale;
  if (dryRun) return { outcome: "would-merge", message };

  let merge: PullRequestMergeResult;
  try {
    merge = await github.merge(pr.head.sha, policy.method);
  } catch (error) {
    const status = gitHubErrorStatus(error);
    if (status === 409) return { outcome: "waiting", message: "PR head moved before the merge" };
    if (status === 405) {
      return {
        outcome: "waiting",
        message: `GitHub refused the merge: ${(error as Error).message}`,
      };
    }
    throw error;
  }
  if (!merge.merged) {
    return {
      outcome: "failed",
      message: `GitHub did not merge the PR: ${merge.message ?? "no reason given"}`,
    };
  }
  await postStatus(ctx, {
    kind: "merged",
    method: policy.method,
    headSha: pr.head.sha,
    ...(decision.viaReview ? { agentReason: decision.reason } : {}),
  });
  if (verbose) console.log(`   merge commit ${merge.sha ?? "(unknown)"}`);
  return { outcome: "merged", message };
}

/**
 * Evaluate one PR against the auto-merge gates and merge it when all pass.
 *
 * @param prUrl - GitHub pull request URL
 * @param options - Policy and injected dependencies
 */
export async function autoMergePr(
  prUrl: string,
  options: AutoMergeOptions,
): Promise<AutoMergeResult> {
  const identity = parseChangeRequestUrl(prUrl, {
    gitlabBaseUrl: process.env.GITLAB_CODE_HOST_URL,
  });
  if (!identity) throw new Error(`Not a supported pull-request URL: ${prUrl}`);
  if (identity.provider !== "github") {
    return {
      outcome: "skipped",
      message: `auto-merge supports GitHub pull requests only (got ${identity.provider})`,
      reviewed: false,
    };
  }
  const baseRepo = identity.projectPath;
  const [owner = "", repo = ""] = baseRepo.split("/");
  const prNumber = identity.number;
  const github = options.github ?? defaultGitHub(owner, repo, prNumber);

  // Gate 0: preconditions.
  const pr = await github.getPullRequest();
  const notReady = identityFailure(pr, baseRepo, options.expectedHeadSha);
  if (notReady) return { ...notReady, reviewed: false };
  const blockers = outstandingChangeRequests(await github.listReviews());
  if (blockers.length > 0) {
    return {
      outcome: "waiting",
      message: `changes requested by ${blockers.join(", ")}`,
      reviewed: false,
    };
  }

  const ctx: GateContext = { options, github, baseRepo, prNumber, pr };
  const notMergeable = mergeableStateFailure(pr);
  let decision: MergeDecision;
  if (notMergeable) {
    const { hold, checksRead } = await ciHoldFromMergeableState(ctx);
    if (!hold) {
      // The checks no longer explain the hold (e.g. they passed, but a
      // required approval still blocks): replace the CI wait the PR shows.
      if (checksRead && options.ciWaitPosted !== undefined) {
        await postStatus(ctx, {
          kind: "github-hold",
          headSha: pr.head.sha,
          detail: notMergeable.message,
        });
      }
      return { ...notMergeable, reviewed: false, ...(checksRead ? {} : { ciChecksUnread: true }) };
    }
    // A rejection on the changed paths is final and wins over the CI wait,
    // as in decideMerge. Safe-only PRs need no passing check, which the
    // hold (failing or pending checks only) already respects.
    const paths = await pathGate(ctx);
    decision = paths.kind === "stop" ? paths : hold;
  } else {
    decision = await decideMerge(ctx);
  }
  const result: AutoMergeResult =
    decision.kind === "stop"
      ? {
          outcome: decision.outcome,
          message: decision.message,
          reviewed: decision.reviewed,
          ...(decision.ciWait ? { ciWait: true } : {}),
          ...(decision.ciWaitProblem ? { ciWaitProblem: decision.ciWaitProblem } : {}),
        }
      : { ...(await mergeAtHead(ctx, decision)), reviewed: decision.reviewed };
  const finalFailure = result.outcome === "failed" && options.lastAttempt;
  // A CI wait the PR already shows (same head, same reason) is not re-posted.
  const alreadyPosted =
    decision.kind === "stop" &&
    decision.ciWait === true &&
    ciWaitKey(decision.ciWaitProblem, decision.message) === options.ciWaitPosted;
  // Pending checks usually resolve on their own: the comment explains the
  // wait, but the review label (a call for a human) is not added for it.
  const labelLeftOpen = !(decision.kind === "stop" && decision.ciWaitProblem === "pending");
  if (alreadyPosted) {
    // The status comment is already in place; re-add the label (idempotent)
    // in case it was removed while the PR still waits.
    if (labelLeftOpen) await syncReviewLabel(ctx, true);
  } else if (decision.kind === "stop" && decision.leftOpen && result.outcome !== "failed") {
    // Failures (an unreadable check status) are retried: only the final
    // attempt below posts, like any other failure.
    await postStatus(
      ctx,
      { kind: "left-open", headSha: pr.head.sha, reason: decision.leftOpen },
      { syncLabel: labelLeftOpen },
    );
  } else if (finalFailure) {
    // The worker stops retrying this head after this attempt.
    await postStatus(ctx, {
      kind: "left-open",
      headSha: pr.head.sha,
      reason: {
        kind: "not-evaluable",
        detail: `the automatic check kept failing (${result.message})`,
      },
    });
  }
  return result;
}

type AgentReview =
  | { kind: "verdict"; ran: true; safe: boolean; reason: string }
  | { kind: "failed" | "waiting"; ran: boolean; message: string }
  | { kind: "base-unavailable"; ran: false; message: string };

/**
 * Make `base.baseSha` available in the review checkout and check that it
 * shares history with the head, so `git diff base...head` works. Fetches
 * the commit by SHA, then the base branch, only when it is missing. Writes
 * no refs (fetches land in `FETCH_HEAD`).
 */
export async function ensureBaseCommit(
  workDir: string,
  refs: PullRequestRefs,
  options: { verbose?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
  const git = (args: string[], timeoutMs?: number) =>
    Utils.executeGitCommand(args, { cwd: workDir, verbose: options.verbose, timeoutMs });
  const hasCommit = async () => (await git(["cat-file", "-e", `${refs.baseSha}^{commit}`])).success;
  if (!(await hasCommit())) {
    const bySha = await git(["fetch", "--no-tags", "origin", refs.baseSha], FETCH_TIMEOUT_MS);
    // The base branch name comes from the PR payload: only a well-formed,
    // non-option branch name is passed to git.
    const refOk =
      !refs.baseRef.startsWith("-") &&
      (await git(["check-ref-format", "--branch", refs.baseRef])).success;
    let fetchError = bySha.error;
    if (!bySha.success && refOk) {
      const byRef = await git(
        ["fetch", "--no-tags", "origin", `refs/heads/${refs.baseRef}`],
        FETCH_TIMEOUT_MS,
      );
      fetchError = byRef.error || fetchError;
    }
    if (!(await hasCommit())) {
      return {
        success: false,
        error: `could not fetch base commit ${refs.baseSha}${fetchError ? `: ${fetchError.trim()}` : ""}`,
      };
    }
  }
  const mergeBase = await git(["merge-base", refs.baseSha, refs.headSha]);
  if (!mergeBase.success || !COMMIT_SHA.test(mergeBase.output.trim())) {
    return {
      success: false,
      error: `no merge base between ${refs.baseSha} and ${refs.headSha}`,
    };
  }
  return { success: true };
}

async function reviewWithAgent(params: {
  options: AutoMergeOptions;
  branch: string;
  headSha: string;
  /** Set when the diff is not inlined: the base must exist in the checkout. */
  refs?: PullRequestRefs;
  prompt: string;
}): Promise<AgentReview> {
  const { options, branch, headSha, refs, prompt } = params;
  const verbose = options.verbose ?? false;
  const worktree = options.worktree ?? {
    // Read-only review of a CI-green PR: no package install needed.
    prepare: (name: string) =>
      Utils.prepareReviewWorktree(name, { verbose, cwd: options.cwd, installDependencies: false }),
    remove: async (path: string) => {
      const removed = await Utils.removeReviewWorktree(path, { verbose, cwd: options.cwd });
      if (!removed.success) {
        console.warn(`⚠️  Failed to remove review worktree ${path}: ${removed.error}`);
      }
    },
  };
  const prepared = await worktree.prepare(branch);
  if (prepared.inUse) {
    // Another job holds this branch's worktree: not ready yet, not a failure.
    return { kind: "waiting", ran: false, message: `worktree busy: ${prepared.error}` };
  }
  if (!prepared.success || !prepared.path) {
    return {
      kind: "failed",
      ran: false,
      message: `worktree preparation failed: ${prepared.error}`,
    };
  }
  const workDir = prepared.path;
  try {
    if (!options.worktree) {
      const head = await Utils.executeGitCommand(["rev-parse", "HEAD"], { cwd: workDir });
      if (!head.success || head.output.trim() !== headSha) {
        return { kind: "waiting", ran: false, message: "PR head moved while preparing the review" };
      }
    }
    if (refs) {
      const base = options.baseCommit
        ? await options.baseCommit(workDir, refs)
        : await ensureBaseCommit(workDir, refs, { verbose });
      if (!base.success) {
        return { kind: "base-unavailable", ran: false, message: base.error ?? "unknown error" };
      }
    }
    const injected = options.agentRunner;
    const run = injected
      ? await injected(prompt, workDir, verbose).then((result) => ({
          ...result,
          stdout: result.stdout ?? result.output,
        }))
      : await runAgent(prompt, workDir, verbose, {
          label: MERGE_SAFETY_REVIEW_LOG_LABEL,
          origin: "auto_merge",
        });
    if (!run.success) {
      return { kind: "failed", ran: true, message: "merge-safety agent run failed" };
    }
    // Only stdout counts: stderr may echo the prompt (and so the PR diff).
    const verdict = parseMergeSafetyVerdict(run.stdout ?? "");
    if (!verdict) {
      return { kind: "failed", ran: true, message: "merge-safety agent returned no verdict" };
    }
    return { kind: "verdict", ran: true, ...verdict };
  } finally {
    await worktree.remove(workDir);
  }
}

/**
 * Create or edit the PR's status comment and sync the review label: added
 * when the PR is left open, removed on merge. Never in dry runs; failures
 * only warn.
 */
async function postStatus(
  ctx: GateContext,
  status: AutoMergeCommentStatus,
  options: { syncLabel?: boolean } = {},
): Promise<void> {
  if (ctx.options.dryRun || ctx.options.noComment) return;
  try {
    await ctx.github.upsertStatusComment(buildAutoMergeStatusComment(status));
  } catch (error) {
    console.warn(`⚠️  Failed to update the auto-merge status comment: ${(error as Error).message}`);
  }
  if (options.syncLabel === false) return;
  await syncReviewLabel(ctx, status.kind === "left-open");
}

/** Add (left open) or remove the review label; never in dry runs; failures only warn. */
async function syncReviewLabel(ctx: GateContext, leftOpen: boolean): Promise<void> {
  if (ctx.options.dryRun || ctx.options.noComment) return;
  const label = ctx.options.policy.reviewLabel?.trim();
  if (!label) return;
  try {
    await (leftOpen ? ctx.github.addLabel(label) : ctx.github.removeLabel(label));
  } catch (error) {
    console.warn(
      `⚠️  Failed to ${leftOpen ? "add" : "remove"} the ${label} label: ${(error as Error).message}`,
    );
  }
}
