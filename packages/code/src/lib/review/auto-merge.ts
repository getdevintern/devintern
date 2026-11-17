/**
 * Auto-merge for the agent's own pull requests (`devintern auto-merge`).
 *
 * A PR is merged only after passing every gate, cheapest first:
 *
 * 0. Preconditions (always): open, not a draft, not a fork, GitHub reports
 *    it mergeable with passing checks (`mergeable_state` `clean`/`has_hooks`),
 *    and no reviewer's latest review requests changes.
 * 1. Path policy (deterministic, `merge-gate.ts`): a deny-glob hit blocks the
 *    merge outright; a PR touching only safe globs merges with no agent run.
 * 2. Agent review (optional): PRs that touch anything outside the safe globs
 *    merge only on an explicit `"safe": true` verdict. A missing, malformed,
 *    or negative verdict never merges.
 *
 * The merge call is pinned to the evaluated head SHA, and the PR is
 * re-fetched right before it, so commits pushed during the review can never
 * ride along. Every "not yet" condition returns `waiting` without side
 * effects; the worker re-evaluates later.
 */

import { runAgent } from "./address";
import { parseChangeRequestUrl } from "../code-host/index";
import { GitHubReviewsClient } from "../code-host/github/reviews";
import type {
  PullRequestFile,
  PullRequestInfo,
  PullRequestMergeResult,
} from "../code-host/github/reviews";
import { loadPrompt } from "../prompts/loader";
import { untrustedContentBlock } from "../prompts/untrusted-content";
import { Utils } from "../utils";
import { AUTO_MERGE_COMMENT_MARKER, buildAutoMergeStatusComment } from "./auto-merge-comment";
import type { AutoMergeCommentStatus, LeftOpenReason } from "./auto-merge-comment";
import { classifyChangedPaths, parseMergeSafetyVerdict } from "./merge-gate";
import type { AutoMergeMethod, MergePathPolicy } from "./merge-gate";

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
}

/** GitHub operations on one PR (injected for tests). */
export interface AutoMergeGitHub {
  getPullRequest(): Promise<PullRequestInfo>;
  listFiles(): Promise<PullRequestFile[]>;
  listReviews(): Promise<Array<{ state: string; user: { login: string } | null }>>;
  getDiff(): Promise<string>;
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
    prepare(branch: string): Promise<{ success: boolean; path?: string; error?: string }>;
    remove(path: string): Promise<void>;
  };
}

/** Diffs above this size are not sent to the agent (rejected instead). */
export const MAX_REVIEW_DIFF_CHARS = 150_000;

/** `mergeable_state` values meaning "mergeable and checks passing". */
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

/** Build the agent's merge-safety prompt (bundled template only). */
export function buildMergeSafetyPrompt(options: {
  repository: string;
  prNumber: number;
  title: string;
  reviewPaths: string[];
  diff: string;
}): string {
  // Trust boundary: the agent runs in a checkout of the PR, so a
  // repository-controlled prompt override could force `"safe": true`.
  return loadPrompt(
    "merge-safety",
    {
      repository: options.repository,
      prNumber: String(options.prNumber),
      prTitle: untrustedContentBlock(options.title, "pull request title"),
      reviewPaths: untrustedContentBlock(
        options.reviewPaths.map((path) => `- ${path}`).join("\n"),
        "changed paths",
      ),
      prDiff: untrustedContentBlock(`\`\`\`diff\n${options.diff}\n\`\`\``, "pull request diff"),
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
    merge: (sha, method) => client.mergePullRequest(owner, repo, prNumber, { sha, method }),
    upsertStatusComment: (body) =>
      client.upsertMarkedIssueComment(owner, repo, prNumber, AUTO_MERGE_COMMENT_MARKER, body),
    addLabel: (label) => client.addIssueLabels(owner, repo, prNumber, [label]),
    removeLabel: (label) => client.removeIssueLabel(owner, repo, prNumber, label),
  };
}

/** Gate 0 on a freshly fetched PR; `null` means ready. */
function preconditionFailure(
  pr: PullRequestInfo,
  baseRepo: string,
  expectedHeadSha: string | undefined,
): Pick<AutoMergeResult, "outcome" | "message"> | null {
  if (pr.state !== "open") return { outcome: "skipped", message: `PR is ${pr.state}` };
  if (pr.head.repo && pr.head.repo.full_name.toLowerCase() !== baseRepo.toLowerCase()) {
    return { outcome: "skipped", message: "fork PRs are never auto-merged" };
  }
  if (pr.draft) return { outcome: "waiting", message: describeMergeableState("draft") };
  if (expectedHeadSha && pr.head.sha !== expectedHeadSha) {
    return { outcome: "waiting", message: "PR head moved since it was checked" };
  }
  if (!MERGEABLE_STATES.has(pr.mergeable_state ?? "")) {
    return { outcome: "waiting", message: describeMergeableState(pr.mergeable_state) };
  }
  return null;
}

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
      /** Set for rejections: what the PR's status comment explains. */
      leftOpen?: LeftOpenReason;
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

/** Gates 1 (path policy) and 2 (agent review). */
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
    const reason = "every change is inside the configured safe paths";
    console.log(`✅ ${baseRepo}#${prNumber}: ${reason}; no agent review needed`);
    return { kind: "merge", reason, viaReview: false, reviewed: false };
  }
  if (!policy.review) {
    return leaveOpen(
      `${classification.outside.length} changed path(s) outside the safe paths ` +
        `(e.g. ${classification.outside[0]}) and agent review is disabled`,
      { kind: "outside-safe-paths", paths: classification.outside },
    );
  }

  const diff = await github.getDiff();
  if (diff.length > MAX_REVIEW_DIFF_CHARS) {
    const detail = `the diff is ${diff.length} characters, above the ${MAX_REVIEW_DIFF_CHARS}-character review limit`;
    return leaveOpen(detail, { kind: "not-evaluable", detail });
  }
  console.log(
    `🔎 ${baseRepo}#${prNumber}: ${classification.outside.length} path(s) outside the safe ` +
      "paths; asking the agent",
  );
  const verdict = await reviewWithAgent({
    options,
    branch: pr.head.ref,
    headSha: pr.head.sha,
    prompt: buildMergeSafetyPrompt({
      repository: baseRepo,
      prNumber,
      title: pr.title,
      reviewPaths: classification.outside,
      diff,
    }),
  });
  if (verdict.kind !== "verdict") return stop(verdict.kind, verdict.message, verdict.ran);
  if (!verdict.safe) {
    return leaveOpen(
      `agent review: ${verdict.reason}`,
      { kind: "agent-unsafe", reason: verdict.reason },
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
  const notReady = preconditionFailure(pr, baseRepo, options.expectedHeadSha);
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
  const decision = await decideMerge(ctx);
  const result: AutoMergeResult =
    decision.kind === "stop"
      ? { outcome: decision.outcome, message: decision.message, reviewed: decision.reviewed }
      : { ...(await mergeAtHead(ctx, decision)), reviewed: decision.reviewed };
  if (decision.kind === "stop" && decision.leftOpen) {
    await postStatus(ctx, { kind: "left-open", headSha: pr.head.sha, reason: decision.leftOpen });
  } else if (result.outcome === "failed" && options.lastAttempt) {
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
    prepare: (name: string) => Utils.prepareReviewWorktree(name, { verbose, cwd: options.cwd }),
    remove: async (path: string) => {
      const removed = await Utils.removeReviewWorktree(path, { verbose, cwd: options.cwd });
      if (!removed.success) {
        console.warn(`⚠️  Failed to remove review worktree ${path}: ${removed.error}`);
      }
    },
  };
  const prepared = await worktree.prepare(branch);
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
      : await runAgent(prompt, workDir, verbose);
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
  const label = ctx.options.policy.reviewLabel?.trim();
  if (!label) return;
  const leftOpen = status.kind === "left-open";
  try {
    await (leftOpen ? ctx.github.addLabel(label) : ctx.github.removeLabel(label));
  } catch (error) {
    console.warn(
      `⚠️  Failed to ${leftOpen ? "add" : "remove"} the ${label} label: ${(error as Error).message}`,
    );
  }
}
