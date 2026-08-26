/**
 * Merge-conflict resolution for the agent's own PRs.
 *
 * When a watched PR falls behind its base and GitHub reports it conflicting
 * (`mergeable_state: "dirty"`), the worker merges the base branch into the PR
 * branch inside the review worktree. A clean merge is committed and pushed
 * directly; a conflicted merge hands the conflicted files to the agent to
 * resolve, then verifies nothing is left unmerged before pushing.
 *
 * Landing the fix is verified, not assumed: after a successful push the PR is
 * re-fetched (bounded window) to confirm GitHub sees the merge commit and no
 * longer reports conflicts, transient push rejections trigger a bounded
 * refresh-and-retry of the merge+push, and every failure path posts a comment
 * on the PR so a silent dead-end is impossible.
 *
 * Guardrails: only the agent's own PRs are handled (the review poller's
 * watch list), fork PRs are skipped, and pushes are never forced — retries
 * always build on top of whatever is actually published, so a human push
 * that lands mid-resolution is incorporated rather than fought.
 */

import { runAgent } from "./address-review";
import { GitHubAppAuth } from "./github-app-auth";
import { GitHubReviewsClient } from "./github-reviews";
import type { PullRequestInfo } from "./github-reviews";
import { Utils } from "./utils";

export interface ResolveConflictsOptions {
  verbose?: boolean;
  /** Skip pushing (dry runs / tests). */
  noPush?: boolean;
  /** Skip the PR outcome comment (tests). */
  noComment?: boolean;
  /** Source repository directory (defaults to the current directory). */
  cwd?: string;
  /** Injected agent runner (tests). Defaults to the shared review agent. */
  agentRunner?: (
    prompt: string,
    workDir: string,
    verbose: boolean,
  ) => Promise<{ success: boolean; output: string }>;
  /** Injected PR fetch (tests). Defaults to the GitHub API. */
  fetchPr?: (owner: string, repo: string, prNumber: number) => Promise<PullRequestInfo>;
  /**
   * Injected PR commenter (tests). Defaults to posting an issue comment on
   * the pull request via the GitHub API.
   */
  prCommenter?: (body: string) => Promise<void>;
  /** Abort safely if polling eligibility became stale before execution. */
  expectedHeadSha?: string;
  /**
   * Advisory only: GitHub's PR API reports a stale `base.sha` until it
   * recomputes the PR, so a mismatch against the fetched ref is logged, not
   * treated as a race — the fetched tip is what gets merged.
   */
  expectedBaseSha?: string;
  /**
   * Post-push verification: total re-fetches of the PR while waiting for
   * GitHub to recompute mergeability (default 4).
   */
  verifyAttempts?: number;
  /** Wait between post-push verification fetches in ms (default 3000). */
  verifyDelayMs?: number;
}

export interface ResolveConflictsResult {
  /** `resolved` = merge pushed; `clean` = base merged without conflicts. */
  outcome: "clean" | "resolved" | "skipped" | "failed" | "deferred";
  message: string;
}

/** Parse an `owner/repo` + PR number out of a GitHub PR URL. */
function parsePrUrl(prUrl: string): { owner: string; repo: string; prNumber: number } {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Not a GitHub PR URL: ${prUrl}`);
  }
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

/** Build the agent prompt for resolving a conflicted merge. */
export function buildConflictPrompt(options: {
  baseRef: string;
  branch: string;
  conflictedFiles: string[];
}): string {
  return `# Resolve Merge Conflicts

A merge of \`origin/${options.baseRef}\` into \`${options.branch}\` is in progress in this
repository and stopped on conflicts. Your job is to finish the merge.

Conflicted files:
${options.conflictedFiles.map((f) => `- ${f}`).join("\n")}

Instructions:
1. Inspect each conflicted file (\`git status\`, \`git diff\`) and resolve the conflict
   markers. Preserve the intent of BOTH sides: the branch's changes and the base's
   changes both belong in the result unless they are genuinely mutually exclusive —
   in that case prefer the base branch's newer conventions and adapt the branch's
   change to them.
2. Watch for semantic conflicts that merge cleanly textually but break the build
   (renamed functions, changed signatures, moved files). Check call sites of
   anything the base renamed or removed.
3. Run the project's typecheck and affected tests if available to verify the result.
4. Stage everything and complete the merge commit with:
   git add -A && git commit --no-edit
5. Do NOT push. Do NOT amend or rebase existing commits. Do NOT abort the merge.

When you are done, every conflict must be resolved and the merge commit created.`;
}

/**
 * How many times the merge+push cycle may restart when a push is rejected
 * because the branch moved underneath us (or was rejected transiently).
 * Each retry re-fetches the branch and rebuilds the merge on top of it, so
 * a human push that lands mid-resolution is incorporated instead of fought.
 */
const MAX_SYNC_ATTEMPTS = 3;

/** Post-push verification defaults: fetches and spacing between them. */
const DEFAULT_VERIFY_ATTEMPTS = 4;
const DEFAULT_VERIFY_DELAY_MS = 3_000;

/** Failure comment variants, matched to how far the resolution got. */
type FailureKind =
  /** Nothing started (worktree/fetch problems); no changes were made. */
  | "setup"
  /** The merge was rolled back locally (agent failure, bad tree). */
  | "aborted"
  /** A merge exists locally but never reached the PR. */
  | "push-failed";

function failureCommentBody(kind: FailureKind, baseRef: string, detail: string): string {
  switch (kind) {
    case "setup":
      return `⚠️ devintern tried to sync this branch with \`${baseRef}\` but could not start safely (${detail}). No changes were made; manual resolution needed.`;
    case "aborted":
      return `⚠️ devintern attempted to resolve this branch's merge conflicts with \`${baseRef}\` but could not finish safely (${detail}). The merge was aborted; manual resolution needed.`;
    case "push-failed":
      return `⚠️ devintern resolved this branch's merge conflicts with \`${baseRef}\` but could not publish the merge to this PR (${detail}). No changes landed on the PR; manual action needed.`;
  }
}

/**
 * Sub-outcome of the post-push verification fetch.
 * - `clear`: GitHub reports the PR head at the pushed commit and mergeable.
 * - `unverified`: GitHub kept recomputing (or the API failed); best-effort.
 * - `head-moved`: the PR head does not carry the pushed merge commit.
 * - `dirty`: GitHub still reports conflicts after the whole window.
 */
type PushVerification =
  | { status: "clear" }
  | { status: "unverified"; reason: string }
  | { status: "head-moved"; headSha: string }
  | { status: "dirty" };

/**
 * Re-fetch the PR after pushing until GitHub confirms the merge landed and
 * recomputed mergeability. A definitive healthy answer ends the window
 * early; any other verdict (unknown, stale-looking conflict, head not yet
 * updated, API error) is remembered and given the rest of the window to
 * settle — GitHub recomputes asynchronously, so reacting to the first
 * non-clear answer would produce false alarms.
 */
async function verifyPushLandedOnPr(params: {
  fetchPr: () => Promise<PullRequestInfo>;
  pushedSha: string;
  attempts: number;
  delayMs: number;
}): Promise<PushVerification> {
  const attempts = Math.max(1, params.attempts);
  let pending: PushVerification | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && params.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, params.delayMs));
    }
    let pr: PullRequestInfo;
    try {
      pr = await params.fetchPr();
    } catch (error) {
      // Rate limits and hiccups must not turn a landed fix into a failure.
      pending = { status: "unverified", reason: (error as Error).message };
      continue;
    }
    if (pr.head?.sha !== params.pushedSha) {
      pending = { status: "head-moved", headSha: pr.head?.sha ?? "" };
      continue;
    }
    const state = pr.mergeable_state;
    // Missing/unknown means GitHub is still recomputing after the push.
    if (!state || state === "unknown") {
      pending = { status: "unverified", reason: "mergeable state stayed unknown" };
      continue;
    }
    if (state === "dirty") {
      // Could be a stale computation or a base that moved again mid-run;
      // let the window decide rather than the first answer.
      pending = { status: "dirty" };
      continue;
    }
    return { status: "clear" };
  }
  return pending ?? { status: "unverified", reason: "verification window exhausted" };
}

/**
 * Classify a rejected push as worth another merge+push cycle. Divergence
 * markers mirror the non-fast-forward handling in `Utils.pushCurrentBranch`.
 */
function isTransientPushRejection(message: string): boolean {
  return (
    message.includes("non-fast-forward") ||
    message.includes("fetch first") ||
    message.includes("Updates were rejected") ||
    message.includes("[rejected]") ||
    message.includes("stale info")
  );
}

/**
 * Catch one PR branch up with its base, resolving conflicts with the agent
 * when needed.
 *
 * @param prUrl - GitHub PR URL
 * @param options - Push/comment suppression and injected agent runner
 */
export async function resolveConflictsOnPr(
  prUrl: string,
  options: ResolveConflictsOptions = {},
): Promise<ResolveConflictsResult> {
  const { verbose = false, noPush = false, noComment = false, cwd } = options;
  const agentRunner = options.agentRunner ?? runAgent;

  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  console.log(`🔀 Resolving merge conflicts on ${owner}/${repo}#${prNumber}`);

  let githubClient: GitHubReviewsClient | undefined;
  const getClient = () => (githubClient ??= new GitHubReviewsClient());
  const postComment =
    options.prCommenter ??
    ((body: string) => getClient().postPullRequestComment(owner, repo, prNumber, body));
  const fetchPrNow = options.fetchPr ?? (() => getClient().getPullRequest(owner, repo, prNumber));

  let baseRef = "";

  async function failWith(kind: FailureKind, message: string): Promise<ResolveConflictsResult> {
    console.error(`❌ ${message}`);
    if (!noComment) {
      await postOutcomeComment(postComment, failureCommentBody(kind, baseRef, message));
    }
    return { outcome: "failed", message };
  }

  const pr = await fetchPrNow(owner, repo, prNumber);

  if (pr.state !== "open") {
    return { outcome: "skipped", message: `PR is ${pr.state}` };
  }
  if (options.expectedHeadSha && pr.head.sha !== options.expectedHeadSha) {
    return { outcome: "deferred", message: "PR head changed before execution" };
  }
  if (options.expectedBaseSha && pr.base.sha !== options.expectedBaseSha) {
    return { outcome: "deferred", message: "PR base changed before execution" };
  }
  const baseRepo = `${owner}/${repo}`;
  if (pr.head.repo && pr.head.repo.full_name !== baseRepo) {
    return {
      outcome: "skipped",
      message: `fork PR (${pr.head.repo.full_name}); conflicts must be resolved by the author`,
    };
  }

  const branch = pr.head.ref;
  baseRef = pr.base.ref;

  // The lease guards each push atomically. It starts as the caller's
  // expectation (the SHA eligibility was validated against) and is re-anchored
  // whenever a retry observes the branch moved forward — so retries stay
  // fast-forward pushes on top of whatever is actually published.
  let leaseSha = options.expectedHeadSha;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`🔁 Retry ${attempt - 1}/${MAX_SYNC_ATTEMPTS - 1}: rebuilding the merge`);
    }

    const worktree = await Utils.prepareReviewWorktree(branch, { verbose, cwd });
    if (!worktree.success || !worktree.path) {
      return await failWith("setup", `worktree preparation failed: ${worktree.error}`);
    }
    const workDir = worktree.path;

    if (leaseSha) {
      const preparedHead = await Utils.executeGitCommand(["rev-parse", "HEAD"], { cwd: workDir });
      if (!preparedHead.success || preparedHead.output.trim() !== leaseSha) {
        return { outcome: "deferred", message: "PR head changed during worktree preparation" };
      }
    }

    // Commit attribution for the merge commit (matches address-review).
    if (!process.env.GITHUB_TOKEN) {
      const appAuth = GitHubAppAuth.fromEnvironment();
      if (appAuth) {
        try {
          const author = await appAuth.getGitAuthor();
          await Utils.executeGitCommand(["config", "user.name", author.name], { cwd: workDir });
          await Utils.executeGitCommand(["config", "user.email", author.email], { cwd: workDir });
        } catch {
          // Local git config applies.
        }
      }
    }

    // A merge needs the common ancestor. Repos can be shallow from CI-style
    // checkouts or from older devintern versions whose review fetch used
    // --depth=1 (which shallows the whole repo); unshallow before merging.
    const shallow = await Utils.executeGitCommand(["rev-parse", "--is-shallow-repository"], {
      cwd: workDir,
    });
    if (shallow.output.trim() === "true") {
      await Utils.executeGitCommand(["fetch", "--unshallow", "origin"], { cwd: workDir, verbose });
    }
    const baseFetch = await Utils.fetchRemoteBranch(baseRef, { cwd: workDir, verbose });
    if (!baseFetch.success) {
      return await failWith("setup", `base fetch failed: ${baseFetch.error}`);
    }
    // GitHub's PR API can report a stale `base.sha` long after the branch
    // advanced (it only updates when GitHub recomputes the PR). Deferring on a
    // mismatch would retry forever against a deterministic mismatch, so the
    // freshly fetched ref is the source of truth for what to merge.
    if (options.expectedBaseSha) {
      const fetchedBase = await Utils.executeGitCommand(["rev-parse", `origin/${baseRef}`], {
        cwd: workDir,
      });
      if (fetchedBase.success && fetchedBase.output.trim() !== options.expectedBaseSha) {
        console.log(
          `ℹ️  GitHub reports base ${baseRef} at ${options.expectedBaseSha.slice(0, 7)} but ` +
            `origin/${baseRef} is at ${fetchedBase.output.trim().slice(0, 7)}; syncing to the actual tip`,
        );
      }
    }

    const mergeTarget = `origin/${baseRef}`;
    const merge = await Utils.executeGitCommand(["merge", mergeTarget, "--no-edit"], {
      cwd: workDir,
      verbose,
    });

    let outcome: "clean" | "resolved";
    if (merge.success) {
      // Includes the already-up-to-date case: nothing to push, nothing to say.
      const status = await Utils.executeGitCommand(["status", "--porcelain"], { cwd: workDir });
      const ahead = await Utils.executeGitCommand(
        ["rev-list", "--count", `origin/${branch}..HEAD`],
        { cwd: workDir },
      );
      if (status.success && status.output.trim() === "" && ahead.output.trim() === "0") {
        return { outcome: "skipped", message: "already up to date with base" };
      }
      outcome = "clean";
      console.log(`✅ origin/${baseRef} merged cleanly`);
    } else {
      const conflicted = await Utils.executeGitCommand(["diff", "--name-only", "--diff-filter=U"], {
        cwd: workDir,
      });
      const conflictedFiles = conflicted.output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (conflictedFiles.length === 0) {
        // No unmerged paths: either the merge failed for a non-conflict
        // reason (e.g. dirty tree) or `git rerere` auto-staged a previously
        // recorded resolution (the merge command still exits non-zero).
        // MERGE_HEAD distinguishes the two.
        const mergeHead = await Utils.executeGitCommand(
          ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          { cwd: workDir },
        );
        if (!mergeHead.success) {
          await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
          return await failWith("aborted", `merge failed: ${merge.error}`);
        }
        // rerere replayed an earlier identical resolution; finish the merge.
        console.log(`♻️  Conflicts auto-resolved from a previous identical merge; committing`);
        await Utils.executeGitCommand(["add", "-A"], { cwd: workDir });
        const commit = await Utils.executeGitCommand(["commit", "--no-edit"], { cwd: workDir });
        if (!commit.success) {
          await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
          return await failWith("aborted", `merge commit failed: ${commit.error}`);
        }
        outcome = "resolved";
      } else {
        console.log(`⚔️  ${conflictedFiles.length} conflicted file(s); handing to the agent`);
        const agentResult = await agentRunner(
          buildConflictPrompt({ baseRef, branch, conflictedFiles }),
          workDir,
          verbose,
        );

        // Trust the tree, not the agent's word: nothing may be left unmerged.
        const unmerged = await Utils.executeGitCommand(["diff", "--name-only", "--diff-filter=U"], {
          cwd: workDir,
        });
        const stillConflicted = unmerged.output.trim() !== "";
        const mergeHead = await Utils.executeGitCommand(
          ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          { cwd: workDir },
        );

        if (!agentResult.success || stillConflicted) {
          await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
          const message = stillConflicted
            ? "agent left unresolved conflicts; merge aborted"
            : "agent run failed; merge aborted";
          return await failWith("aborted", message);
        }

        if (mergeHead.success) {
          // Agent resolved but did not commit; finish the merge.
          await Utils.executeGitCommand(["add", "-A"], { cwd: workDir });
          const commit = await Utils.executeGitCommand(["commit", "--no-edit"], { cwd: workDir });
          if (!commit.success) {
            await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
            return await failWith("aborted", `merge commit failed: ${commit.error}`);
          }
        }
        outcome = "resolved";
      }
    }

    if (noPush) {
      return { outcome, message: "merge committed (push skipped)" };
    }

    // Refresh the remote head immediately before pushing and use it as the
    // atomic lease (`--force-with-lease`) even when no explicit expectation
    // was provided — an interactive run gets the same race protection.
    const headFetch = await Utils.executeGitCommand(
      ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: workDir, verbose },
    );
    if (!headFetch.success) {
      return await failWith("push-failed", `head fetch before push failed: ${headFetch.error}`);
    }
    const remoteHead = await Utils.executeGitCommand(["rev-parse", `origin/${branch}`], {
      cwd: workDir,
    });
    if (!remoteHead.success) {
      return await failWith("push-failed", `could not read remote head: ${remoteHead.error}`);
    }
    const remoteTip = remoteHead.output.trim();
    if (leaseSha && remoteTip !== leaseSha) {
      return { outcome: "deferred", message: "PR head changed before push" };
    }

    // The exact lease makes the head check above atomic with the push. The
    // push helper also verifies that HEAD descends from the leased commit.
    const push = await Utils.pushCurrentBranch({
      cwd: workDir,
      expectedBranch: branch,
      expectedRemoteSha: leaseSha ?? remoteTip,
      verbose,
    });
    if (!push.success) {
      if (leaseSha) {
        const refreshed = await Utils.executeGitCommand(
          ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          { cwd: workDir, verbose },
        );
        const moved = refreshed.success
          ? await Utils.executeGitCommand(["rev-parse", `origin/${branch}`], { cwd: workDir })
          : null;
        const newTip = moved?.success ? moved.output.trim() : null;
        if (newTip && newTip !== leaseSha) {
          // Only incorporate forward movement: building on top of a human's
          // new commits keeps the eventual push a fast-forward. Anything else
          // (rollback, history rewrite) is left alone for a fresh attempt.
          const forward = await Utils.executeGitCommand(
            ["merge-base", "--is-ancestor", leaseSha, newTip],
            { cwd: workDir },
          );
          if (forward.success && attempt < MAX_SYNC_ATTEMPTS) {
            console.log(
              `🔁 Branch moved forward during resolution (${leaseSha.slice(0, 7)} → ${newTip.slice(0, 7)}); retrying on top of it`,
            );
            leaseSha = newTip;
            continue;
          }
          console.warn(`⚠️  Leaving the branch alone after concurrent movement during push`);
          return { outcome: "deferred", message: "PR head changed during push" };
        }
      } else if (
        attempt < MAX_SYNC_ATTEMPTS &&
        isTransientPushRejection(`${push.message} ${push.hookError ?? ""}`)
      ) {
        console.log(
          `🔁 Push rejected transiently (${push.message}); refreshing and retrying the merge`,
        );
        continue;
      }
      return await failWith("push-failed", `push rejected: ${push.message}`);
    }

    // The push was accepted. Verify GitHub actually sees the fix before
    // declaring success: re-fetch the PR until the head carries the pushed
    // commit and mergeability has been recomputed (bounded window).
    const pushedRev = await Utils.executeGitCommand(["rev-parse", "HEAD"], { cwd: workDir });
    const verification = await verifyPushLandedOnPr({
      fetchPr: () => fetchPrNow(owner, repo, prNumber),
      pushedSha: pushedRev.success ? pushedRev.output.trim() : "",
      attempts: options.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS,
      delayMs: options.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS,
    });

    if (verification.status === "head-moved") {
      return await failWith(
        "push-failed",
        `the PR head does not include the pushed merge commit (GitHub reports ${verification.headSha.slice(0, 7) || "no head"})`,
      );
    }
    if (verification.status === "dirty") {
      return await failWith(
        "push-failed",
        "GitHub still reports merge conflicts after the push (the base likely advanced again); re-run resolve-conflicts",
      );
    }

    if (verification.status === "unverified") {
      console.warn(
        `⚠️  Could not confirm PR state after push (${verification.reason}); the remote accepted the merge commit.`,
      );
    }
    if (!noComment) {
      await postOutcomeComment(postComment, successCommentBody(outcome, baseRef));
    }
    const baseMessage =
      outcome === "clean"
        ? `caught up with ${baseRef} (clean merge)`
        : `conflicts with ${baseRef} resolved and pushed`;
    const verifiedNote =
      verification.status === "clear"
        ? "; verified conflict-free on the PR"
        : "; GitHub has not confirmed mergeability yet";
    console.log(`✅ ${baseMessage}${verifiedNote}`);
    return { outcome, message: `${baseMessage}${verifiedNote}` };
  }

  // Unreachable: every iteration returns or continues.
  return { outcome: "failed", message: "resolution attempts exhausted" };
}

function successCommentBody(outcome: "clean" | "resolved", baseRef: string): string {
  return outcome === "clean"
    ? `🔀 Merged \`${baseRef}\` into this branch (no conflicts).`
    : `🔀 This branch had merge conflicts with \`${baseRef}\`; devintern resolved them and pushed the merge. Please double-check the resolution.`;
}

async function postOutcomeComment(
  post: (body: string) => Promise<void>,
  body: string,
): Promise<void> {
  try {
    await post(body);
  } catch (error) {
    console.warn(`⚠️  Failed to post conflict-resolution comment: ${(error as Error).message}`);
  }
}
