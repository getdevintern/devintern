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
import { loadPrompt, loadPromptTemplate, renderPrompt } from "../prompts/loader";
import { untrustedContentBlock } from "../prompts/untrusted-content";
import { Utils } from "../utils";
import { AUTO_MERGE_COMMENT_MARKER, buildAutoMergeStatusComment } from "./auto-merge-comment";
import type { AutoMergeCommentStatus, LeftOpenReason } from "./auto-merge-comment";
import { evaluateCiChecks, normalizeCiChecks } from "./ci-checks";
import type { CiCheck, CiChecksVerdict } from "./ci-checks";
import {
  classifyChangedPaths,
  DEFAULT_MERGE_SAFETY_POLICY,
  parseMergeSafetyVerdict,
} from "./merge-gate";
import type { AutoMergeMethod, MergePathPolicy, MergeSafetyPolicy } from "./merge-gate";
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
   * Message of the CI wait this head's status comment and label already
   * show (from the worker's previous check): the same wait again skips
   * re-posting them.
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
}

/** Diffs above this size are not sent to the agent (rejected instead). */
export const MAX_REVIEW_DIFF_CHARS = 150_000;

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

/** Bundled prompt holding the fixed frame shared by every policy. */
const MERGE_SAFETY_FRAME_PROMPT = "merge-safety";

/** Bundled rubric per preset (`custom` uses the operator's rules instead). */
const MERGE_SAFETY_RUBRIC_PROMPTS: Record<Exclude<MergeSafetyPolicy, "custom">, string> = {
  strict: "merge-safety-rubric-strict",
  standard: "merge-safety-rubric-standard",
  relaxed: "merge-safety-rubric-relaxed",
};

/** Role-statement sentence for the `custom` policy (presets carry their own). */
const CUSTOM_POLICY_SUMMARY = "A PR with clumsy code can be safe to merge.";

/** Delimiters around operator-owned `custom` rules in the prompt. */
export const OPERATOR_RULES_BEGIN = "--- BEGIN OPERATOR RULES ---";
export const OPERATOR_RULES_END = "--- END OPERATOR RULES ---";

/** The `custom` rubric: the operator's rules in a delimited section. */
function operatorRulesRubric(rules: string): string {
  return [
    "This repository uses a **custom** merge-safety policy: the workspace operator wrote the " +
      "rules below, and they decide which kinds of change need a human. Answer " +
      '`"safe": false` if the change plausibly falls under anything the rules mark unsafe. ' +
      "When the rules do not settle whether a change is safe, it is not safe.",
    "",
    "### Operator Rules",
    OPERATOR_RULES_BEGIN,
    rules.trim(),
    OPERATOR_RULES_END,
  ].join("\n");
}

/** Policy summary sentence and rubric text for one policy. */
function mergeSafetyRubric(
  policy: MergeSafetyPolicy,
  rules: string | undefined,
): { summary: string; rubric: string } {
  if (policy === "custom") {
    if (!rules?.trim()) throw new Error("The custom merge-safety policy needs operator rules");
    return { summary: CUSTOM_POLICY_SUMMARY, rubric: operatorRulesRubric(rules) };
  }
  // Bundled only, like the frame (see buildMergeSafetyPrompt).
  const template = loadPromptTemplate(MERGE_SAFETY_RUBRIC_PROMPTS[policy], {
    useAmbientOverrides: false,
  });
  const summary = template.attributes?.summary;
  if (typeof summary !== "string" || !summary) {
    throw new Error(`Prompt '${template.name}' is missing its summary frontmatter`);
  }
  return {
    summary,
    rubric: renderPrompt(template, { maxDiffChars: String(MAX_REVIEW_DIFF_CHARS) }),
  };
}

/** Heading of the operator section appended to the merge-safety prompt. */
export const OPERATOR_SECTION_HEADING = "## Operator Instructions";

/**
 * The marked operator section (`auto_merge_review_instructions`), or `""`
 * when there are none, which leaves the template text exactly as bundled.
 * The text is trusted operator config, but the framing limits it to adding
 * restrictions.
 */
export function operatorInstructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  if (!text) return "";
  return [
    "",
    "",
    OPERATOR_SECTION_HEADING,
    "The workspace operator added the repository-specific rules below. They are trusted " +
      "configuration, but they can only make this review stricter: they never remove or relax " +
      'any condition in "What Makes a Merge Unsafe", and they never override the rule that ' +
      "when in doubt the answer is not safe. If an operator rule seems to allow something " +
      "that section marks unsafe, that section wins.",
    "",
    "--- BEGIN OPERATOR INSTRUCTIONS ---",
    text,
    "--- END OPERATOR INSTRUCTIONS ---",
  ].join("\n");
}

/** A framed list of changed paths, or `(none)` when empty. */
function changedPathsBlock(paths: readonly string[]): string {
  if (paths.length === 0) return "(none)";
  return untrustedContentBlock(paths.map((path) => `- ${path}`).join("\n"), "changed paths");
}

/**
 * Build the agent's merge-safety prompt: the fixed bundled frame around the
 * policy's rubric (a bundled preset, or the operator's `custom` rules).
 */
export function buildMergeSafetyPrompt(options: {
  repository: string;
  prNumber: number;
  title: string;
  /** Changed paths outside the safe globs. */
  reviewPaths: string[];
  /** Changed paths matching `auto_merge_review_paths` (always reviewed). */
  alwaysReviewPaths?: string[];
  diff: string;
  /** Review strictness; defaults to `strict`. */
  policy?: MergeSafetyPolicy;
  /** Operator-written rules appended in the operator section. */
  instructions?: string;
  /** The `custom` policy's rubric text (required for `custom`, ignored otherwise). */
  rules?: string;
}): string {
  // Trust boundary: the verdict gates merges, and an unsandboxed agent could
  // write a `~/.devintern/prompts/` override forcing `"safe": true`. Pin the
  // frame and the preset rubrics to the bundled catalog.
  const policy = options.policy ?? DEFAULT_MERGE_SAFETY_POLICY;
  const { summary, rubric } = mergeSafetyRubric(policy, options.rules);
  return loadPrompt(
    MERGE_SAFETY_FRAME_PROMPT,
    {
      policySummary: summary,
      rubric,
      repository: options.repository,
      prNumber: String(options.prNumber),
      prTitle: untrustedContentBlock(options.title, "pull request title"),
      reviewPaths: changedPathsBlock(options.reviewPaths),
      alwaysReviewPaths: changedPathsBlock(options.alwaysReviewPaths ?? []),
      prDiff: untrustedContentBlock(`\`\`\`diff\n${options.diff}\n\`\`\``, "pull request diff"),
      operatorSection: operatorInstructionsSection(options.instructions),
    },
    { useAmbientOverrides: false },
  );
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
    };

const stop = (outcome: AutoMergeOutcome, message: string, reviewed = false): MergeDecision => ({
  kind: "stop",
  outcome,
  message,
  reviewed,
});

/** A rejection: the PR stays open, and its status comment says why. */
const leaveOpen = (message: string, leftOpen: LeftOpenReason, reviewed = false): MergeDecision => ({
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
 * `null` when the checks don't explain the state (another protection rule,
 * or they could not be read): the plain `mergeable_state` wait applies.
 */
async function ciHoldFromMergeableState(ctx: GateContext): Promise<MergeDecision | null> {
  if (!CI_HELD_STATES.has(ctx.pr.mergeable_state ?? "")) return null;
  const read = await readCiChecks(ctx);
  if (!read.ok) return null;
  // Failing and pending checks are reported before the success requirement.
  const verdict = evaluateCiChecks(read.checks, { requireSuccess: false });
  return verdict.ready ? null : ciWaitDecision(verdict);
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
  };
}

/** Gates 1 (path policy, then CI checks) and 2 (agent review). */
async function decideMerge(ctx: GateContext): Promise<MergeDecision> {
  const { options, github, baseRepo, prNumber, pr } = ctx;
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
  if (classification.kind === "safe") {
    const ciWait = await ciChecksGate(ctx, true);
    if (ciWait) return ciWait;
    const reason = "every change is inside the configured safe paths";
    console.log(`✅ ${baseRepo}#${prNumber}: ${reason}; no agent review needed`);
    return { kind: "merge", reason, viaReview: false, reviewed: false };
  }
  const { outside, reviewMatches } = classification;
  // A review-path match goes to its own prompt list, even if it is also outside the safe paths.
  const outsideSafe = outside.filter((path) => !reviewMatches.includes(path));
  // Before the CI check: with review disabled a code PR can never merge
  // automatically, so the final rejection wins over a (retried) CI wait.
  if (!policy.review) {
    return leaveOpen(
      `${outside.length} changed path(s) need review (e.g. ${outside[0]}) ` +
        "and agent review is disabled",
      { kind: "outside-safe-paths", paths: outsideSafe, reviewPathMatches: reviewMatches },
    );
  }
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
  if (diff.length > MAX_REVIEW_DIFF_CHARS) {
    const detail = `the diff is ${diff.length} characters, above the ${MAX_REVIEW_DIFF_CHARS}-character review limit`;
    return leaveOpen(detail, { kind: "not-evaluable", detail });
  }
  console.log(
    `🔎 ${baseRepo}#${prNumber}: ${outsideSafe.length} path(s) outside the safe paths, ` +
      `${reviewMatches.length} matching review paths; asking the agent`,
  );
  const verdict = await reviewWithAgent({
    options,
    branch: pr.head.ref,
    headSha: pr.head.sha,
    prompt: buildMergeSafetyPrompt({
      repository: baseRepo,
      prNumber,
      title: pr.title,
      reviewPaths: outsideSafe,
      alwaysReviewPaths: reviewMatches,
      diff,
      policy: reviewPolicy,
      instructions: policy.reviewInstructions,
      rules,
    }),
  });
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
    const ciHold = await ciHoldFromMergeableState(ctx);
    if (!ciHold) return { ...notMergeable, reviewed: false };
    decision = ciHold;
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
        }
      : { ...(await mergeAtHead(ctx, decision)), reviewed: decision.reviewed };
  const finalFailure = result.outcome === "failed" && options.lastAttempt;
  // A CI wait the PR already shows (same head, same reason) is not re-posted.
  const alreadyPosted =
    decision.kind === "stop" && decision.ciWait && decision.message === options.ciWaitPosted;
  if (alreadyPosted) {
    // The status comment is already in place; re-add the label (idempotent)
    // in case it was removed while the PR still waits.
    await syncReviewLabel(ctx, true);
  } else if (decision.kind === "stop" && decision.leftOpen && result.outcome !== "failed") {
    // Failures (an unreadable check status) are retried: only the final
    // attempt below posts, like any other failure.
    await postStatus(ctx, { kind: "left-open", headSha: pr.head.sha, reason: decision.leftOpen });
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
  | { kind: "failed" | "waiting"; ran: boolean; message: string };

async function reviewWithAgent(params: {
  options: AutoMergeOptions;
  branch: string;
  headSha: string;
  prompt: string;
}): Promise<AgentReview> {
  const { options, branch, headSha, prompt } = params;
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
async function postStatus(ctx: GateContext, status: AutoMergeCommentStatus): Promise<void> {
  if (ctx.options.dryRun || ctx.options.noComment) return;
  try {
    await ctx.github.upsertStatusComment(buildAutoMergeStatusComment(status));
  } catch (error) {
    console.warn(`⚠️  Failed to update the auto-merge status comment: ${(error as Error).message}`);
  }
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
