import { unlinkSync, writeFileSync } from "fs";
import { UsageLimitError } from "@devintern/agent-harness";
import { captureError } from "@devintern/utils";
import { GitHubReviewsClient } from "../code-host/github/reviews";
import { WorkerState } from "../state/worker-state";
import { formatReviewPrompt } from "../review/formatter";
import { Utils } from "../utils";
import {
  processReviewComment,
  processReviewEvent,
  shouldProcessReview,
} from "../code-host/github/webhook";
import type {
  IssueCommentEvent,
  ProcessedReviewComment,
  PullRequestReviewEvent,
  WebhookServerConfig,
} from "../../types/github-webhooks";

import { debugLog, handleUsageLimit, resolveActiveHarness, reviewQueue, runtime } from "./runtime";
import type { ReviewGitContext } from "./review-git";
import {
  commitUncommittedReviewChanges,
  configureReviewGitAuthor,
  countCommitsAhead,
  filterAddressedReviewComments,
  prepareRepository,
  publishReviewChanges,
  resolveReviewGitAuthor,
  restoreReviewBranch,
  runTriggeredAutoReview,
} from "./review-git";
import { runAgentHarnessForReview } from "./agent-review";

/**
 * Trigger phrases that indicate the reviewer wants an auto-review loop
 * instead of addressing specific comments.
 */
const AUTO_REVIEW_TRIGGER_PHRASES = [
  "enhance",
  "improve",
  "improve pr",
  "improve this",
  "improve this pr",
  "make it better",
  "polish",
  "refine",
  "clean up",
  "cleanup",
  "self-review",
  "self review",
  "auto-review",
  "auto review",
  "review yourself",
  "review it",
];

/**
 * Detect auto-review trigger phrases in a review body (after stripping bot mention).
 *
 * @param reviewBody - Review summary comment body
 * @param botName - Bot login used to strip `@mentions`
 */
function isAutoReviewTrigger(reviewBody: string | null, botName?: string): boolean {
  if (!reviewBody) return false;

  // Remove bot mention if present (e.g., "@devintern[bot]" or "@devintern")
  let normalizedBody = reviewBody.toLowerCase().trim();
  if (botName) {
    // Strip [bot] suffix from botName if present to get the base name
    const baseBotName = botName.toLowerCase().replace(/\[bot\]$/, "");

    // Remove various forms of bot mention (with and without [bot] suffix)
    normalizedBody = normalizedBody
      .replace(new RegExp(`@${baseBotName}\\[bot\\]`, "g"), "")
      .replace(new RegExp(`@${baseBotName}`, "g"), "")
      .trim();
  }

  // Check if the remaining text matches a trigger phrase
  return AUTO_REVIEW_TRIGGER_PHRASES.some(
    (phrase) => normalizedBody === phrase || normalizedBody === phrase + ".",
  );
}

/**
 * Run {@link processReviewAsync} with SQLite queue status updates.
 *
 * @param eventId - Persisted queue event id, if any
 * @param event - Pull request review webhook payload
 * @param config - Server configuration
 */
export async function processReviewWithPersistence(
  eventId: string | undefined,
  event: PullRequestReviewEvent,
  config: WebhookServerConfig,
): Promise<void> {
  // Mark as processing
  if (eventId && runtime.queue) {
    runtime.queue.markProcessing(eventId);
  }

  try {
    await processReviewAsync(event, config);

    // Mark as completed (removes from queue)
    if (eventId && runtime.queue) {
      runtime.queue.markCompleted(eventId);
    }
  } catch (error) {
    if (error instanceof UsageLimitError) {
      // Deferred by an account-global usage limit — fail over to the next
      // harness (or pause and re-queue for after reset) instead of counting
      // a failure.
      handleUsageLimit(error.resetHint);
      if (eventId && runtime.queue) {
        runtime.queue.requeuePending(eventId);
      }
      reviewQueue
        .add(() => processReviewWithPersistence(eventId, event, config))
        .catch((e) => console.error("❌ Error reprocessing deferred review:", e));
      return;
    }
    // Mark as failed (will retry if under max retries)
    if (eventId && runtime.queue) {
      runtime.queue.markFailed(eventId, (error as Error).message);
    }
    throw error; // Re-throw so the queue's catch handler logs it
  }
}

/**
 * Run {@link processIssueCommentAsync} with SQLite queue status updates.
 *
 * @param eventId - Persisted queue event id, if any
 * @param event - Issue comment webhook payload
 * @param config - Server configuration
 */
export async function processIssueCommentWithPersistence(
  eventId: string | undefined,
  event: IssueCommentEvent,
  config: WebhookServerConfig,
): Promise<void> {
  if (eventId && runtime.queue) {
    runtime.queue.markProcessing(eventId);
  }

  try {
    await processIssueCommentAsync(event, config);

    if (eventId && runtime.queue) {
      runtime.queue.markCompleted(eventId);
    }
  } catch (error) {
    if (error instanceof UsageLimitError) {
      handleUsageLimit(error.resetHint);
      if (eventId && runtime.queue) {
        runtime.queue.requeuePending(eventId);
      }
      reviewQueue
        .add(() => processIssueCommentWithPersistence(eventId, event, config))
        .catch((e) => console.error("❌ Error reprocessing deferred PR comment:", e));
      return;
    }
    if (eventId && runtime.queue) {
      runtime.queue.markFailed(eventId, (error as Error).message);
    }
    // Usage-limit deferrals are re-queued, not failures; everything else is a
    // PR-comment processing the user expected to happen.
    if (!(error instanceof UsageLimitError)) {
      captureError(error, {
        stage: "webhook-comment",
        pr: `${event.repository.full_name}#${event.issue.number}`,
        eventId,
      });
    }
    throw error; // Re-throw so the queue's catch handler logs it
  }
}

/**
 * Process a top-level PR comment by adapting it into a review-shaped event and
 * routing it through the same batch pipeline as `commented`/`changes_requested`
 * reviews. Fetches the PR to resolve the head branch (the issue_comment payload
 * doesn't carry it), then defers the bot-mention gate to {@link processReviewAsync}.
 *
 * @param event - Issue comment webhook payload (already confirmed to be on a PR)
 * @param config - Server configuration
 */
export async function processIssueCommentAsync(
  event: IssueCommentEvent,
  config: WebhookServerConfig,
): Promise<void> {
  const [owner, repo] = event.repository.full_name.split("/");
  const prNumber = event.issue.number;

  console.log(`\n📋 Resolving PR #${prNumber} for comment on ${owner}/${repo}`);

  const githubClient = new GitHubReviewsClient({ preferAppAuth: true });
  const pr = await githubClient.getPullRequest(owner, repo, prNumber);

  // Adapt the comment into a synthetic "commented" review so the existing
  // review pipeline (comment fetch, mention gate, worktree, agent, push) applies
  // unchanged. The comment body becomes the review body, which is where the
  // mention check and auto-review trigger look.
  const syntheticEvent: PullRequestReviewEvent = {
    action: "submitted",
    review: {
      id: event.comment.id,
      user: event.comment.user,
      body: event.comment.body,
      state: "commented",
      commit_id: pr.head.sha,
      submitted_at: event.comment.created_at,
      html_url: event.comment.html_url,
    },
    pull_request: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      html_url: pr.html_url,
      user: event.issue.user,
      head: { ref: pr.head.ref, sha: pr.head.sha, repo: event.repository },
      base: { ref: pr.base.ref, sha: "", repo: event.repository },
    },
    repository: event.repository,
    sender: event.sender,
    installation: event.installation,
  };

  await processReviewAsync(syntheticEvent, config);
}

/**
 * Add hooray reactions to top-level review comments after a successful fix.
 *
 * @param client - GitHub reviews client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param comments - Comments to mark as addressed
 * @param verbose - Log reaction failures when true
 */
async function markCommentsAsAddressed(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  comments: ProcessedReviewComment[],
  _verbose = false,
): Promise<void> {
  if (comments.length === 0) {
    return;
  }

  // Local dedupe marker: record every in-scope comment (replies included) so
  // the thread dedupes fully. Reactions skip replies — the thread root carries
  // the single human-readable 🎉.
  const workerState = new WorkerState();
  try {
    workerState.markCommentsAddressed(
      `${owner}/${repo}`,
      "review",
      comments.map((c) => c.id),
    );
  } finally {
    workerState.close();
  }

  const topLevelComments = comments.filter((c) => !c.isReply);
  const replyCount = comments.length - topLevelComments.length;

  if (replyCount > 0) {
    console.log(`   Skipping ${replyCount} reply comment(s) (only marking top-level)`);
  }

  if (topLevelComments.length === 0) {
    console.log(`   No top-level comments to mark`);
    return;
  }

  console.log(`🎉 Marking ${topLevelComments.length} comment(s) as addressed...`);
  let successCount = 0;
  let failCount = 0;

  for (const comment of topLevelComments) {
    try {
      await client.addReactionToComment(owner, repo, comment.id, "hooray");
      successCount++;
    } catch (error) {
      failCount++;
      // Cosmetic only — dedupe is local, so a reaction failure can never
      // cause the comment to be re-processed.
      console.warn(
        `   ⚠️  Failed to add reaction to comment ${comment.id}: ${(error as Error).message}`,
      );
    }
  }

  if (successCount > 0) {
    console.log(`🎉 Reacted to ${successCount} comment(s) (visual feedback)`);
  }
  if (failCount > 0) {
    console.warn(`⚠️  Failed to mark ${failCount} comment(s) (cosmetic only)`);
  }
}

/**
 * Process a `changes_requested` review: worktree, agent, commit, push, reactions.
 *
 * @param event - Pull request review webhook payload
 * @param config - Server configuration
 */
async function processReviewAsync(
  event: PullRequestReviewEvent,
  config: WebhookServerConfig,
): Promise<void> {
  const [owner, repo] = event.repository.full_name.split("/");
  const prNumber = event.pull_request.number;
  const branch = event.pull_request.head.ref;

  console.log(`\n📋 Processing review for ${owner}/${repo}#${prNumber}`);

  try {
    // Initialize GitHub client (App-first so the bot identity resolves)
    const githubClient = new GitHubReviewsClient({ preferAppAuth: true });

    // Get GitHub App author info if available (for commit attribution). In serve
    // mode we always prefer the bot identity when App credentials exist, even if
    // a GITHUB_TOKEN is also set.
    const gitAuthor = await resolveReviewGitAuthor(config);

    // Fetch ALL review comments for the PR (not just from this review)
    console.log("📥 Fetching review comments...");
    const allRawComments = await githubClient.getPullRequestReviewComments(owner, repo, prNumber);

    console.log(`   Found ${allRawComments.length} total comment(s)`);

    // Local dedupe: filter out comments this worker already addressed. GitHub
    // reactions are visual feedback only and carry no gating meaning.
    const { rawComments, alreadyAddressed } = filterAddressedReviewComments(
      owner,
      repo,
      allRawComments,
    );

    if (alreadyAddressed > 0) {
      console.log(`   ${alreadyAddressed} already addressed (skipping)`);
    }
    console.log(`   ${rawComments.length} remaining to address`);

    // Check bot mention requirement (deferred from handleWebhook to avoid blocking 200 response)
    // Use ALL comments (before filtering addressed) so we don't miss mentions in addressed comments
    const allProcessedComments = allRawComments.map(processReviewComment);
    const botName = await githubClient.getBotUsername(owner, repo);
    debugLog(config, `Bot username: ${botName || "unknown"}`);

    if (
      !shouldProcessReview(event, {
        requireBotMention: true,
        botName: botName || undefined,
        comments: allProcessedComments,
      })
    ) {
      const reason = botName
        ? `No @${botName} mention found in review`
        : "No bot mention found in review";
      console.log(`⏭️  Skipping review: ${reason}`);
      return;
    }

    if (botName) {
      console.log(`   Bot mention: @${botName} detected`);
    }

    // Permission gate: only users who can push to the repo may direct the
    // agent. Anyone can comment on a public repo; without this check a
    // drive-by @mention from a read-only user would trigger an agent run.
    // Fails closed on API errors.
    const actor = event.review.user.login;
    const actorHasPushAccess = await githubClient.userHasPushAccess(owner, repo, actor);
    if (!actorHasPushAccess) {
      console.log(
        `⛔ Skipping review: @${actor} does not have push access to ${owner}/${repo} ` +
          `(mention-triggered automation requires write, maintain, or admin permission)`,
      );
      return;
    }
    debugLog(config, `Permission gate passed for @${actor}`);

    // Process unaddressed comments for feedback
    const processedComments = rawComments.map(processReviewComment);

    // Build feedback object
    const feedback = processReviewEvent(event, processedComments);

    // Prepare the single reusable worktree for this review
    console.log(`🌿 Preparing worktree for branch: ${branch}`);
    const worktreePath = await prepareRepository(branch, config.debug);

    if (!worktreePath) {
      console.error("❌ Failed to prepare repository");
      return;
    }

    // Set git config for bot author if available (so Agent's commits are attributed to bot)
    if (gitAuthor) {
      await configureReviewGitAuthor(worktreePath, gitAuthor, config);
    }

    // Check if this is an auto-review trigger (e.g., "@bot enhance", "@bot improve")
    const reviewBody = event.review.body;
    const isAutoReviewRequest = isAutoReviewTrigger(reviewBody, botName || undefined);

    if (isAutoReviewRequest && config.autoReview) {
      await runTriggeredAutoReview({
        owner,
        repo,
        prNumber,
        branch,
        baseBranch: event.pull_request.base.ref,
        worktreePath,
        config,
        reviewBody,
      });
      return;
    }

    // Format prompt for Agent
    const prompt = formatReviewPrompt(feedback);

    // Save prompt to file (outside worktree to avoid git issues)
    const promptFile = `/tmp/devintern-review-prompt-${prNumber}.md`;
    writeFileSync(promptFile, prompt, "utf8");
    console.log(`💾 Saved review prompt to: ${promptFile}`);

    // Run Agent to address the feedback
    console.log("🤖 Running Agent to address review feedback...");
    const agentResult = await runAgentHarnessForReview(promptFile, worktreePath);

    // Clean up prompt file
    try {
      unlinkSync(promptFile);
    } catch {
      // Ignore cleanup errors
    }

    const hitMaxTurns = agentResult.maxTurnsReached === true;

    // A usage limit is account-global: don't burn this event as a failure —
    // signal the wrapper to fail over to the next harness (or pause the queue
    // and re-queue the event for after reset).
    if (agentResult.usageLimited) {
      throw new UsageLimitError(agentResult.usageResetHint);
    }

    if (!agentResult.success) {
      console.error(`❌ Agent failed: ${agentResult.message}`);
      return;
    }

    if (hitMaxTurns) {
      console.warn("⚠️  Agent hit max turns limit");
    }

    const hookRetries = parseInt(process.env.HOOK_RETRIES || "10", 10);
    const { harness, path: executablePath } = resolveActiveHarness();
    const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);

    const ctx: ReviewGitContext = {
      owner,
      repo,
      prNumber,
      branch,
      baseBranch: event.pull_request.base.ref,
      worktreePath,
      config,
      gitAuthor,
      harness,
      executablePath,
      maxTurns,
      hookRetries,
    };

    // Verify Agent didn't switch branches during execution (e.g., checking out main for comparison)
    if (!(await restoreReviewBranch(ctx))) {
      return;
    }

    // Check for uncommitted changes (indicates Agent didn't commit or hook failed)
    const hasUncommitted = await Utils.hasUncommittedChanges(worktreePath);

    // Check if there are commits to push
    const commitsAhead = await countCommitsAhead(worktreePath, branch);

    if (!hasUncommitted && commitsAhead === 0) {
      console.warn("⚠️  No changes were made by @devintern/code");
      // Still continue to mark comments as addressed if Agent determined no changes needed
    } else if (hasUncommitted) {
      // Agent left uncommitted changes - try to commit with hook retry logic
      console.log("\n📝 Agent left changes uncommitted, committing now...");
      if (!(await commitUncommittedReviewChanges(ctx))) {
        return;
      }
    }

    // Re-check commits to push after potential commit
    const finalCommitsAhead = await countCommitsAhead(worktreePath, branch);

    if (finalCommitsAhead === 0) {
      console.warn("⚠️  No new commits to push - Agent may not have made any changes");
      // Still continue to mark comments as addressed
    } else if (!(await publishReviewChanges(ctx, finalCommitsAhead))) {
      return;
    }

    // Mark comments as addressed with hooray reaction
    await markCommentsAsAddressed(githubClient, owner, repo, processedComments, config.debug);

    console.log(`\n✅ Successfully addressed review for PR #${prNumber}`);
  } catch (error) {
    if (error instanceof UsageLimitError) {
      // Account-global usage limit: propagate to the persistence wrapper so
      // it can fail over to the next harness (or pause + re-queue until the
      // window resets) without burning the event as a failure.
      throw error;
    }
    console.error(`❌ Error processing review: ${(error as Error).message}`);
    if (config.debug) {
      console.error((error as Error).stack);
    }
    // This catch swallows (queue persistence treats the event as completed),
    // so without reporting here a failed review would be invisible to error
    // tracking. Usage-limit deferrals are expected scheduling, not failures.
    if (!(error instanceof UsageLimitError)) {
      captureError(error, {
        stage: "webhook-review",
        pr: `${owner}/${repo}#${prNumber}`,
      });
    }
  }
  // Note: We don't cleanup this branch's worktree here - it's reused across
  // reviews of the same PR for efficiency (deps stay cached). Worktrees from
  // other branches are pruned by prepareReviewWorktree on the next review.
}
