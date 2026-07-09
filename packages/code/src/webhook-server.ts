#!/usr/bin/env node

/**
 * Webhook Server for @devintern/code
 *
 * Listens for GitHub PR review events and automatically addresses
 * review feedback using an AI agent.
 */

import { type ChildProcess } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import PQueue from "p-queue";
import {
  detectMaxTurnsReached,
  detectUsageLimit,
  resetHintToMs,
  resolveHarness,
  spawnReapable,
  reapTree,
  resolveExecutablePathWithRetry,
} from "@devintern/agent-harness";
import { GitHubAppAuth } from "./lib/github-app-auth";
import { GitHubReviewsClient } from "./lib/github-reviews";
import { WebhookQueue } from "./lib/webhook-queue";
import { formatReviewPrompt } from "./lib/review-formatter";
import { Utils } from "./lib/utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./lib/git-hook-fixer";
import { runAutoReviewLoop } from "./lib/auto-review-loop";
import {
  handlePingEvent,
  isGitHubIP,
  parseEventType,
  processReviewComment,
  processReviewEvent,
  RateLimiter,
  shouldProcessReview,
  verifyWebhookSignature,
} from "./lib/webhook-handler";
import type {
  IssueCommentEvent,
  PingEvent,
  ProcessedReviewComment,
  ProcessedReviewFeedback,
  PullRequestReviewEvent,
  WebhookServerConfig,
} from "./types/github-webhooks";

// Default configuration
const DEFAULT_CONFIG: WebhookServerConfig = {
  port: parseInt(process.env.WEBHOOK_PORT || "3000", 10),
  host: process.env.WEBHOOK_HOST || "0.0.0.0",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  autoReview: process.env.WEBHOOK_AUTO_REVIEW === "true",
  autoReviewMaxIterations: parseInt(process.env.WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS || "5", 10),
  validateIp: process.env.WEBHOOK_VALIDATE_IP === "true",
  debug: process.env.WEBHOOK_DEBUG === "true",
};

// Rate limiter instance
const rateLimiter = new RateLimiter(60000, 30); // 30 requests per minute

// Review processing queue - ensures sequential processing to avoid race conditions
const reviewQueue = new PQueue({ concurrency: 1 });

// Persistent webhook queue (initialized in startWebhookServer)
let webhookQueue: WebhookQueue | null = null;

// Fallback cooldown when a usage-limit reset hint can't be parsed.
const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000; // 1 hour

// In-memory mirror of the active rate-limit window for the current harness.
let rateLimitedUntil: number | null = null;
let rateLimitResumeTimer: ReturnType<typeof setTimeout> | null = null;

// Cleanup rate limiter periodically
setInterval(() => rateLimiter.cleanup(), 60000);
// Note: We use a single reusable worktree, so no periodic cleanup needed

/** Thrown by processing when the agent hit a usage limit; deferred, not failed. */
class UsageLimitError extends Error {
  constructor(public readonly resetHint?: string) {
    super(`Agent usage limit reached${resetHint ? ` (resets ${resetHint})` : ""}`);
    this.name = "UsageLimitError";
  }
}

/** Name of the agent harness this server drives (e.g. `claude-code`). */
function currentHarnessName(): string {
  return resolveHarness().harness.name;
}

/**
 * Pause the review queue until the current harness's usage limit resets.
 *
 * Idempotent: extends the window if a later reset arrives. The persisted state
 * is keyed by harness so a restart with a different `AGENT_HARNESS` is not
 * wrongly blocked.
 *
 * @param resetHint - Human-readable reset hint from the agent output
 */
function enterRateLimitPause(resetHint?: string): void {
  const harness = currentHarnessName();
  const until = resetHintToMs(resetHint, Date.now()) ?? Date.now() + RATE_LIMIT_FALLBACK_MS;

  // Keep the latest (furthest) reset if one is already active.
  rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, until);
  webhookQueue?.setRateLimit(harness, rateLimitedUntil);

  if (!reviewQueue.isPaused) {
    reviewQueue.pause();
  }

  const waitMs = Math.max(0, rateLimitedUntil - Date.now());
  const resetAtIso = new Date(rateLimitedUntil).toISOString();
  console.warn(
    `⏳ ${harness} hit a usage limit${resetHint ? ` (resets ${resetHint})` : ""}. ` +
      `Pausing webhook queue until ${resetAtIso} (~${Math.round(waitMs / 60000)} min). ` +
      `Queued and incoming events will wait and drain on resume.`,
  );

  scheduleRateLimitResume();
}

/** (Re)arm the timer that resumes the queue when the rate-limit window ends. */
function scheduleRateLimitResume(): void {
  if (rateLimitResumeTimer) {
    clearTimeout(rateLimitResumeTimer);
  }
  if (rateLimitedUntil === null) {
    return;
  }
  const waitMs = Math.max(0, rateLimitedUntil - Date.now());
  rateLimitResumeTimer = setTimeout(() => {
    const harness = currentHarnessName();
    rateLimitedUntil = null;
    rateLimitResumeTimer = null;
    webhookQueue?.clearRateLimit(harness);
    console.log(`▶️  Usage limit window elapsed for ${harness} — resuming webhook queue`);
    reviewQueue.start();
  }, waitMs);
}

/**
 * Log a debug message when debug mode is enabled.
 *
 * @param config - Server configuration
 * @param message - Message to print
 */
function debugLog(config: WebhookServerConfig, message: string): void {
  if (config.debug) {
    console.log(`[DEBUG] ${message}`);
  }
}

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
 * Build a JSON HTTP response.
 *
 * @param data - Response body object
 * @param status - HTTP status code
 */
function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle an incoming GitHub webhook HTTP request.
 *
 * @param request - Web API Request (POST with raw body)
 * @param config - Resolved server configuration
 */
async function handleWebhook(request: Request, config: WebhookServerConfig): Promise<Response> {
  const startTime = Date.now();

  // Get client IP for rate limiting and logging
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  debugLog(config, `Incoming request from ${clientIp}`);

  // Rate limiting
  if (!rateLimiter.isAllowed(clientIp)) {
    console.log(`⚠️  Rate limit exceeded for ${clientIp}`);
    return jsonResponse({ error: "Rate limit exceeded" }, 429);
  }

  // IP validation (optional)
  if (config.validateIp && clientIp !== "unknown" && !isGitHubIP(clientIp)) {
    console.log(`⚠️  Request from non-GitHub IP: ${clientIp}`);
    return jsonResponse({ error: "Request not from GitHub" }, 403);
  }

  // Get raw body for signature verification
  const rawBody = await request.text();

  // Verify webhook signature
  const signature = request.headers.get("x-hub-signature-256");
  const verification = verifyWebhookSignature(rawBody, signature, config.webhookSecret);

  if (!verification.valid) {
    console.log(`❌ Signature verification failed: ${verification.error}`);
    return jsonResponse({ error: "Invalid signature", details: verification.error }, 401);
  }

  debugLog(config, "Signature verified successfully");

  // Parse event type
  const eventType = parseEventType(request.headers.get("x-github-event"));
  if (!eventType) {
    return jsonResponse({ error: "Unsupported event type" }, 400);
  }

  debugLog(config, `Event type: ${eventType}`);

  // Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  // Handle ping event
  if (eventType === "ping") {
    const result = handlePingEvent(payload as PingEvent);
    return jsonResponse({ success: true, message: result.message });
  }

  // Handle pull_request_review event
  if (eventType === "pull_request_review") {
    const event = payload as PullRequestReviewEvent;

    // Quick payload-only checks (no API calls — respond 200 fast)
    // Accept "changes_requested" and plain "comment" reviews; the bot-mention
    // gate (applied later in processReviewAsync) keeps commented reviews from
    // firing unless @bot is mentioned.
    if (event.review.state !== "changes_requested" && event.review.state !== "commented") {
      console.log(
        `⏭️  Skipping review on PR #${event.pull_request.number}: state is "${event.review.state}" (only changes_requested/commented are processed)`,
      );
      return jsonResponse({
        success: true,
        message: "Review does not require processing",
        reason: `state=${event.review.state}`,
      });
    }

    if (event.review.user.type === "Bot") {
      console.log(
        `⏭️  Skipping review on PR #${event.pull_request.number}: reviewer is a bot (${event.review.user.login})`,
      );
      return jsonResponse({
        success: true,
        message: "Review does not require processing",
        reason: "reviewer is a bot",
      });
    }

    if (event.pull_request.state !== "open") {
      console.log(
        `⏭️  Skipping review on PR #${event.pull_request.number}: PR is ${event.pull_request.state} (not open)`,
      );
      return jsonResponse({
        success: true,
        message: "Review does not require processing",
        reason: `pr_state=${event.pull_request.state}`,
      });
    }

    console.log(`\n🔔 Received ${event.review.state} review for PR #${event.pull_request.number}`);
    console.log(`   Repository: ${event.repository.full_name}`);
    console.log(`   Reviewer: ${event.review.user.login}`);

    // Persist event to SQLite before processing (crash resilience)
    let eventId: string | undefined;
    if (webhookQueue) {
      eventId = webhookQueue.enqueue("pull_request_review", event);
      debugLog(config, `Persisted event ${eventId} to queue`);
    }

    // Add to queue for sequential processing (prevents race conditions)
    // Bot mention check happens inside processReviewAsync after fetching comments
    reviewQueue
      .add(() => processReviewWithPersistence(eventId, event, config))
      .catch((error) => {
        console.error("❌ Error processing review:", error);
      });

    const duration = Date.now() - startTime;
    return jsonResponse({
      success: true,
      message: "Review processing started",
      eventId,
      prNumber: event.pull_request.number,
      repository: event.repository.full_name,
      processingTime: `${duration}ms`,
    });
  }

  // Handle issue_comment event — top-level (conversation) comments on a PR.
  // Lets a user kick off devintern by commenting "@bot finish this" on their
  // own PR, without leaving a formal review.
  if (eventType === "issue_comment") {
    const event = payload as IssueCommentEvent;

    // Quick payload-only checks (no API calls — respond 200 fast)
    if (event.action !== "created") {
      console.log(
        `⏭️  Skipping comment on #${event.issue.number}: action is "${event.action}" (only "created" is processed)`,
      );
      return jsonResponse({
        success: true,
        message: "Comment does not require processing",
        reason: `action=${event.action}`,
      });
    }

    if (!event.issue.pull_request) {
      console.log(`⏭️  Skipping comment on #${event.issue.number}: not on a pull request`);
      return jsonResponse({
        success: true,
        message: "Comment is not on a pull request",
        reason: "not_a_pull_request",
      });
    }

    if (event.comment.user.type === "Bot") {
      console.log(
        `⏭️  Skipping comment on #${event.issue.number}: author is a bot (${event.comment.user.login})`,
      );
      return jsonResponse({
        success: true,
        message: "Comment does not require processing",
        reason: "author is a bot",
      });
    }

    if (event.issue.state !== "open") {
      console.log(
        `⏭️  Skipping comment on #${event.issue.number}: PR is ${event.issue.state} (not open)`,
      );
      return jsonResponse({
        success: true,
        message: "Comment does not require processing",
        reason: `pr_state=${event.issue.state}`,
      });
    }

    console.log(`\n🔔 Received PR comment on #${event.issue.number}`);
    console.log(`   Repository: ${event.repository.full_name}`);
    console.log(`   Commenter: ${event.comment.user.login}`);

    // Persist event to SQLite before processing (crash resilience)
    let eventId: string | undefined;
    if (webhookQueue) {
      eventId = webhookQueue.enqueue("issue_comment", event);
      debugLog(config, `Persisted event ${eventId} to queue`);
    }

    // Bot mention check happens inside processReviewAsync after fetching the PR.
    reviewQueue
      .add(() => processIssueCommentWithPersistence(eventId, event, config))
      .catch((error) => {
        console.error("❌ Error processing PR comment:", error);
      });

    const duration = Date.now() - startTime;
    return jsonResponse({
      success: true,
      message: "Comment processing started",
      eventId,
      prNumber: event.issue.number,
      repository: event.repository.full_name,
      processingTime: `${duration}ms`,
    });
  }

  // Handle pull_request_review_comment event (individual inline diff comments).
  // These are processed in batch as part of the parent review (see the
  // pull_request_review handler above, which fetches ALL inline comments), so
  // the standalone per-comment event is intentionally a no-op.
  if (eventType === "pull_request_review_comment") {
    return jsonResponse({
      success: true,
      message: "Individual comment events not processed (handled in batch via review events)",
    });
  }

  return jsonResponse({ error: "Unhandled event type" }, 400);
}

/**
 * Run {@link processReviewAsync} with SQLite queue status updates.
 *
 * @param eventId - Persisted queue event id, if any
 * @param event - Pull request review webhook payload
 * @param config - Server configuration
 */
async function processReviewWithPersistence(
  eventId: string | undefined,
  event: PullRequestReviewEvent,
  config: WebhookServerConfig,
): Promise<void> {
  // Mark as processing
  if (eventId && webhookQueue) {
    webhookQueue.markProcessing(eventId);
  }

  try {
    await processReviewAsync(event, config);

    // Mark as completed (removes from queue)
    if (eventId && webhookQueue) {
      webhookQueue.markCompleted(eventId);
    }
  } catch (error) {
    if (error instanceof UsageLimitError) {
      // Deferred by an account-global usage limit — pause and re-queue for
      // after reset instead of counting a failure.
      enterRateLimitPause(error.resetHint);
      if (eventId && webhookQueue) {
        webhookQueue.requeuePending(eventId);
      }
      reviewQueue
        .add(() => processReviewWithPersistence(eventId, event, config))
        .catch((e) => console.error("❌ Error reprocessing deferred review:", e));
      return;
    }
    // Mark as failed (will retry if under max retries)
    if (eventId && webhookQueue) {
      webhookQueue.markFailed(eventId, (error as Error).message);
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
async function processIssueCommentWithPersistence(
  eventId: string | undefined,
  event: IssueCommentEvent,
  config: WebhookServerConfig,
): Promise<void> {
  if (eventId && webhookQueue) {
    webhookQueue.markProcessing(eventId);
  }

  try {
    await processIssueCommentAsync(event, config);

    if (eventId && webhookQueue) {
      webhookQueue.markCompleted(eventId);
    }
  } catch (error) {
    if (error instanceof UsageLimitError) {
      enterRateLimitPause(error.resetHint);
      if (eventId && webhookQueue) {
        webhookQueue.requeuePending(eventId);
      }
      reviewQueue
        .add(() => processIssueCommentWithPersistence(eventId, event, config))
        .catch((e) => console.error("❌ Error reprocessing deferred PR comment:", e));
      return;
    }
    if (eventId && webhookQueue) {
      webhookQueue.markFailed(eventId, (error as Error).message);
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
async function processIssueCommentAsync(
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
  verbose = false,
): Promise<void> {
  if (comments.length === 0) {
    return;
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
      // Always log failures - they indicate a real problem
      console.warn(
        `   ⚠️  Failed to add reaction to comment ${comment.id}: ${(error as Error).message}`,
      );
    }
  }

  if (successCount > 0) {
    console.log(`✅ Marked ${successCount} comment(s) as addressed with 🎉 reaction`);
  }
  if (failCount > 0) {
    console.warn(`⚠️  Failed to mark ${failCount} comment(s)`);
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
    let gitAuthor: { name: string; email: string } | undefined;
    {
      const githubAppAuth = GitHubAppAuth.fromEnvironment();
      if (githubAppAuth) {
        try {
          gitAuthor = await githubAppAuth.getGitAuthor();
          debugLog(config, `Commits will be authored by: ${gitAuthor.name}`);
        } catch (error) {
          debugLog(config, `Could not get GitHub App author info: ${(error as Error).message}`);
        }
      }
    }

    // Fetch ALL review comments for the PR (not just from this review)
    console.log("📥 Fetching review comments...");
    const allRawComments = await githubClient.getPullRequestReviewComments(owner, repo, prNumber);

    console.log(`   Found ${allRawComments.length} total comment(s)`);

    // Filter out comments that have already been addressed (have a "hooray" reaction)
    const addressedCommentIds = new Set<number>();

    for (const comment of allRawComments) {
      try {
        const reactions = await githubClient.getCommentReactions(owner, repo, comment.id);
        const hasHoorayReaction = reactions.some((r) => r.content === "hooray");
        if (hasHoorayReaction) {
          addressedCommentIds.add(comment.id);
        }
      } catch (error) {
        // Ignore errors, treat as not addressed
        debugLog(config, `Failed to fetch reactions for comment ${comment.id}`);
      }
    }

    const rawComments = allRawComments.filter((c) => !addressedCommentIds.has(c.id));
    const alreadyAddressed = allRawComments.length - rawComments.length;

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
      await Utils.executeGitCommand(["config", "user.name", gitAuthor.name], {
        verbose: config.debug,
        cwd: worktreePath,
      });
      await Utils.executeGitCommand(["config", "user.email", gitAuthor.email], {
        verbose: config.debug,
        cwd: worktreePath,
      });
      console.log(`🤖 Git author set to: ${gitAuthor.name}`);
    }

    // Check if this is an auto-review trigger (e.g., "@bot enhance", "@bot improve")
    const reviewBody = event.review.body;
    const isAutoReviewRequest = isAutoReviewTrigger(reviewBody, botName || undefined);

    if (isAutoReviewRequest && config.autoReview) {
      console.log(`\n🔄 Auto-review trigger detected: "${reviewBody?.trim()}"`);
      console.log("   Skipping normal review flow, running auto-review loop directly...");

      const autoReviewOutputDir = `/tmp/devintern-auto-review-${prNumber}`;
      const baseBranch = event.pull_request.base.ref;
      const { harness: reviewHarness, path: reviewPath } = resolveHarness();
      try {
        const autoReviewResult = await runAutoReviewLoop({
          repository: `${owner}/${repo}`,
          prNumber,
          prBranch: branch,
          baseBranch,
          harness: reviewHarness,
          executablePath: reviewPath,
          maxIterations: config.autoReviewMaxIterations,
          minPriority: "medium",
          workingDir: worktreePath,
          outputDir: autoReviewOutputDir,
        });

        if (autoReviewResult.success) {
          console.log(
            `✅ Auto-review completed successfully after ${autoReviewResult.iterations} iteration(s)`,
          );
        } else {
          console.warn(
            `⚠️  Auto-review completed but some issues remain after ${autoReviewResult.iterations} iteration(s)`,
          );
        }

        console.log(`\n✅ Successfully completed auto-review for PR #${prNumber}`);
        return;
      } catch (error) {
        console.error(`❌ Auto-review loop failed: ${(error as Error).message}`);
        // Don't fall through to normal flow - just return
        return;
      }
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
    // signal the wrapper to pause the queue and re-queue it for after reset.
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

    // Get hook retries configuration
    const hookRetries = parseInt(process.env.HOOK_RETRIES || "10", 10);
    const { harness, path: executablePath } = resolveHarness();
    const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);

    // Verify Agent didn't switch branches during execution (e.g., checking out main for comparison)
    const currentBranch = await Utils.getCurrentBranch(worktreePath);
    if (currentBranch && currentBranch !== branch) {
      console.warn(
        `⚠️  Agent switched from '${branch}' to '${currentBranch}' during execution, switching back...`,
      );
      const switchBack = await Utils.executeGitCommand(["checkout", branch], {
        verbose: config.debug,
        cwd: worktreePath,
      });
      if (!switchBack.success) {
        // If simple checkout fails (dirty state conflicts), try stashing first
        console.warn(`   Simple checkout failed, trying stash + checkout...`);
        await Utils.executeGitCommand(["stash", "--include-untracked"], {
          verbose: false,
          cwd: worktreePath,
        });
        const switchAfterStash = await Utils.executeGitCommand(["checkout", branch], {
          verbose: config.debug,
          cwd: worktreePath,
        });
        if (switchAfterStash.success) {
          await Utils.executeGitCommand(["stash", "pop"], {
            verbose: false,
            cwd: worktreePath,
          });
        } else {
          console.error(
            `❌ Failed to switch back to branch '${branch}': ${switchAfterStash.error}`,
          );
          return;
        }
      }
      console.log(`✅ Switched back to '${branch}'`);
    }

    // Check for uncommitted changes (indicates Agent didn't commit or hook failed)
    const hasUncommitted = await Utils.hasUncommittedChanges(worktreePath);

    // Check if there are commits to push
    const aheadResult = await Utils.executeGitCommand(
      ["rev-list", "--count", `origin/${branch}..HEAD`],
      { verbose: false, cwd: worktreePath },
    );
    const commitsAhead = parseInt(aheadResult.output?.trim() || "0", 10);

    if (!hasUncommitted && commitsAhead === 0) {
      console.warn("⚠️  No changes were made by @devintern/code");
      // Still continue to mark comments as addressed if Agent determined no changes needed
    } else if (hasUncommitted) {
      // Agent left uncommitted changes - try to commit with hook retry logic
      console.log("\n📝 Agent left changes uncommitted, committing now...");

      let commitAttempt = 0;
      let commitSuccess = false;

      while (commitAttempt <= hookRetries && !commitSuccess) {
        commitAttempt++;
        const commitResult = await Utils.commitChanges(
          `PR-${prNumber}`,
          `Address review feedback`,
          { verbose: config.debug, author: gitAuthor, cwd: worktreePath },
        );

        if (commitResult.success) {
          console.log("✅ Changes committed successfully");
          commitSuccess = true;
          break;
        }

        // Check if this is a git hook error that we can try to fix
        if (commitResult.hookError && commitAttempt <= hookRetries) {
          console.log(
            `\n⚠️  Git pre-commit hook failed (attempt ${commitAttempt}/${hookRetries + 1})`,
          );

          // Try to fix the hook error with agent
          const fixed = await runAgentHarnessToFixGitHook(
            "commit",
            harness,
            executablePath,
            maxTurns,
            worktreePath,
            branch,
          );

          if (fixed) {
            if (await isCommitAlreadyComplete(worktreePath)) {
              console.log("✅ Commit already completed during hook fix");
              commitSuccess = true;
              break;
            }

            console.log(`\n🔄 Retrying commit after ${harness.displayName} fixed the issues...`);
            continue;
          } else {
            console.log("\n❌ Could not fix git hook errors automatically");
            break;
          }
        } else {
          // Not a hook error or out of retries
          if (commitAttempt > hookRetries) {
            console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
          }
          console.error(`\n❌ Failed to commit changes: ${commitResult.message}`);
          return;
        }
      }

      if (!commitSuccess) {
        console.error("❌ Failed to commit changes after retries");
        return;
      }
    }

    // Re-check commits to push after potential commit
    const finalAheadResult = await Utils.executeGitCommand(
      ["rev-list", "--count", `origin/${branch}..HEAD`],
      { verbose: false, cwd: worktreePath },
    );
    const finalCommitsAhead = parseInt(finalAheadResult.output?.trim() || "0", 10);

    if (finalCommitsAhead === 0) {
      console.warn("⚠️  No new commits to push - Agent may not have made any changes");
      // Still continue to mark comments as addressed
    } else {
      // Helper function for local hook validation with retry
      const validateLocalHook = async (phase: string): Promise<boolean> => {
        let attempt = 0;

        while (attempt <= hookRetries) {
          attempt++;
          const hookResult = await Utils.runPrePushHookLocally({
            verbose: config.debug,
            cwd: worktreePath,
          });

          if (hookResult.success) {
            if (attempt === 1) {
              console.log(`✅ ${hookResult.message}`);
            } else {
              console.log(`✅ Pre-push hook passed after ${attempt} attempt(s)`);
            }
            return true;
          }

          // Check if this is a hook error that we can try to fix
          if (hookResult.hookError && attempt <= hookRetries) {
            console.log(
              `\n⚠️  Pre-push hook failed during ${phase} (attempt ${attempt}/${hookRetries + 1})`,
            );

            // Try to fix the hook error with agent
            const fixed = await runAgentHarnessToFixGitHook(
              "push",
              harness,
              executablePath,
              maxTurns,
              worktreePath,
              branch,
            );

            if (fixed) {
              console.log(
                `\n🔄 Retrying local hook validation after ${harness.displayName} fixed the issues...`,
              );
              continue;
            } else {
              console.log("\n❌ Could not fix pre-push hook errors automatically");
              return false;
            }
          } else {
            // Not a hook error or out of retries
            if (attempt > hookRetries) {
              console.log(`\n❌ Max retries (${hookRetries}) exceeded for pre-push hook fixes`);
            }
            console.error(`\n❌ Pre-push hook validation failed: ${hookResult.message}`);
            return false;
          }
        }

        return false;
      };

      // Step 1: Validate pre-push hook locally BEFORE any push
      console.log("\n🔍 Validating pre-push hook locally (before pushing)...");
      const initialHookValid = await validateLocalHook("initial validation");

      if (!initialHookValid) {
        console.error("❌ Cannot proceed without passing pre-push hook validation");
        return;
      }

      // Step 2: Run auto-review loop with skipPush if enabled
      // This allows all improvements to be made locally before pushing
      let autoReviewRan = false;
      if (config.autoReview) {
        console.log("\n🔄 Running auto-review loop (without pushing)...");
        const autoReviewOutputDir = `/tmp/devintern-auto-review-${prNumber}`;
        const baseBranchForReview = event.pull_request.base.ref;
        const { harness: reviewHarness2, path: reviewPath2 } = resolveHarness();
        try {
          const autoReviewResult = await runAutoReviewLoop({
            repository: `${owner}/${repo}`,
            prNumber,
            prBranch: branch,
            baseBranch: baseBranchForReview,
            harness: reviewHarness2,
            executablePath: reviewPath2,
            maxIterations: config.autoReviewMaxIterations,
            minPriority: "medium",
            workingDir: worktreePath,
            outputDir: autoReviewOutputDir,
            skipPush: true, // Don't push during auto-review iterations
          });

          if (autoReviewResult.success) {
            console.log(
              `✅ Auto-review completed successfully after ${autoReviewResult.iterations} iteration(s)`,
            );
          } else {
            console.warn(
              `⚠️  Auto-review completed but some issues remain after ${autoReviewResult.iterations} iteration(s)`,
            );
          }
          autoReviewRan = true;

          // Step 3: Re-validate local hook after auto-review (auto-review changes may have broken things)
          console.log("\n🔍 Re-validating pre-push hook after auto-review improvements...");
          const postAutoReviewHookValid = await validateLocalHook("post auto-review validation");

          if (!postAutoReviewHookValid) {
            console.error(
              "❌ Cannot proceed - auto-review changes failed pre-push hook validation",
            );
            return;
          }
        } catch (error) {
          console.error(`❌ Auto-review loop failed: ${(error as Error).message}`);
          // Continue with push even if auto-review fails
        }
      }

      // Step 4: Now do the actual push (hooks already validated, should succeed)
      console.log(
        `\n📤 Pushing ${finalCommitsAhead}${autoReviewRan ? "+ auto-review" : ""} commit(s)...`,
      );

      let pushAttempt = 0;
      let pushSuccess = false;

      while (pushAttempt <= hookRetries && !pushSuccess) {
        pushAttempt++;
        const pushResult = await Utils.pushCurrentBranch({
          verbose: config.debug,
          cwd: worktreePath,
          expectedBranch: branch,
        });

        if (pushResult.success) {
          console.log("✅ Changes pushed successfully");
          pushSuccess = true;
          break;
        }

        // Check if this is a git hook error that we can try to fix
        if (pushResult.hookError && pushAttempt <= hookRetries) {
          console.log(
            `\n⚠️  Git pre-push hook failed during actual push (attempt ${pushAttempt}/${hookRetries + 1})`,
          );

          // Try to fix the hook error with agent
          const fixed = await runAgentHarnessToFixGitHook(
            "push",
            harness,
            executablePath,
            maxTurns,
            worktreePath,
            branch,
          );

          if (fixed) {
            console.log(
              `\n🔄 Retrying push after ${harness.displayName} fixed and amended the commit...`,
            );
            continue;
          } else {
            console.log("\n❌ Could not fix git pre-push hook errors automatically");
            break;
          }
        } else {
          // Not a hook error or out of retries
          if (pushAttempt > hookRetries) {
            console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
          }
          console.error(`\n❌ Failed to push changes: ${pushResult.message}`);
          return;
        }
      }

      if (!pushSuccess) {
        console.error("❌ Failed to push changes after retries");
        return;
      }
    }

    // Mark comments as addressed with hooray reaction
    await markCommentsAsAddressed(githubClient, owner, repo, processedComments, config.debug);

    console.log(`\n✅ Successfully addressed review for PR #${prNumber}`);
  } catch (error) {
    console.error(`❌ Error processing review: ${(error as Error).message}`);
    if (config.debug) {
      console.error((error as Error).stack);
    }
  }
  // Note: We don't cleanup this branch's worktree here - it's reused across
  // reviews of the same PR for efficiency (deps stay cached). Worktrees from
  // other branches are pruned by prepareReviewWorktree on the next review.
}

/**
 * Prepare the shared review worktree checked out to a PR branch.
 *
 * @param branch - PR head branch name
 * @param verbose - Enable verbose git logging
 * @returns Worktree path, or `null` on failure
 */
async function prepareRepository(branch: string, verbose = false): Promise<string | null> {
  const isGitRepo = await Utils.isGitRepository();
  if (!isGitRepo) {
    console.error("❌ Not in a git repository");
    return null;
  }

  // Prepare the single reusable worktree
  console.log(`   Preparing worktree for ${branch}...`);
  const worktreeResult = await Utils.prepareReviewWorktree(branch, {
    verbose,
  });

  if (!worktreeResult.success) {
    console.error(`❌ Failed to prepare worktree: ${worktreeResult.error}`);
    return null;
  }

  console.log(`   Worktree ready at: ${worktreeResult.path}`);
  return worktreeResult.path || null;
}

/**
 * Spawn the agent harness to address review feedback from a prompt file.
 *
 * @param promptFile - Path to markdown prompt (read and sent via stdin)
 * @param workDir - Git working directory
 */
async function runAgentHarnessForReview(
  promptFile: string,
  workDir: string,
): Promise<{
  success: boolean;
  message: string;
  output?: string;
  maxTurnsReached?: boolean;
  usageLimited?: boolean;
  usageResetHint?: string;
}> {
  const { harness, path: executablePath } = resolveHarness();
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the review.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: workDir,
    displayName: harness.displayName,
  });

  return new Promise((resolve) => {
    const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);

    const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
    const agentArgs = harness.buildArgs({ maxTurns, skipPermissions: true, workingDir: workDir });

    console.log(`   Command: ${resolvedPath} ${agentArgs.join(" ")}`);
    console.log(`   Timeout: ${timeoutMinutes} minutes`);

    let stdoutOutput = "";
    let stderrOutput = "";
    let timedOut = false;

    const agent: ChildProcess = spawnReapable(resolvedPath, agentArgs, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(
      () => {
        timedOut = true;
        console.error(
          `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
        );
        reapTree(agent, "SIGTERM");
        // Force kill the whole group after 10 seconds if SIGTERM doesn't work
        setTimeout(() => {
          if (!agent.killed) {
            reapTree(agent, "SIGKILL");
          }
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    if (agent.stdout) {
      agent.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutOutput += output;
        process.stdout.write(output);
      });
    }

    if (agent.stderr) {
      agent.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrOutput += output;
        process.stderr.write(output);
      });
    }

    agent.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        message: `Failed to run Agent: ${error.message}`,
      });
    });

    agent.on("close", (code: number | null) => {
      clearTimeout(timeout);
      const maxTurnsReached = detectMaxTurnsReached(stdoutOutput, stderrOutput);
      const usage = detectUsageLimit(stdoutOutput, stderrOutput);
      const output = stdoutOutput + stderrOutput;

      if (timedOut) {
        resolve({
          success: false,
          message: `Agent timed out after ${timeoutMinutes} minutes`,
          output,
          maxTurnsReached,
        });
      } else if (usage.limited) {
        // A usage/rate limit is account-global — surface it so the caller can
        // pause the queue until reset rather than treating it as a task failure.
        resolve({
          success: false,
          message: `Agent hit a usage limit${usage.resetsAt ? ` (resets ${usage.resetsAt})` : ""}`,
          output,
          usageLimited: true,
          usageResetHint: usage.resetsAt,
        });
      } else if (maxTurnsReached) {
        resolve({
          success: false,
          message: "Agent reached max turns limit",
          output,
          maxTurnsReached: true,
        });
      } else if (code === 0) {
        resolve({
          success: true,
          message: "Agent completed successfully",
          output,
        });
      } else {
        resolve({
          success: false,
          message: `Agent exited with code ${code}`,
          output,
          maxTurnsReached,
        });
      }
    });

    // Send prompt content to Agent
    if (agent.stdin) {
      const promptContent = require("fs").readFileSync(promptFile, "utf8");
      agent.stdin.write(promptContent);
      agent.stdin.end();
    }
  });
}

/** Return JSON health payload including webhook queue stats. */
function handleHealthCheck(): Response {
  const queueStats = webhookQueue?.getStats() || {
    pending: 0,
    processing: 0,
    failed: 0,
  };
  return jsonResponse({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    queue: queueStats,
  });
}

/**
 * Read the full request body from a Node.js `IncomingMessage`.
 *
 * @param req - HTTP incoming message
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Write a Web `Response` to a Node.js `ServerResponse`.
 *
 * @param res - Node HTTP server response
 * @param response - Web API response to send
 */
async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const body = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("Content-Type") || "application/json",
  });
  res.end(body);
}

/**
 * Start the GitHub webhook HTTP server and recover pending queue events.
 *
 * @param config - Partial configuration merged with defaults and env vars
 * @throws Exits the process when `WEBHOOK_SECRET` is missing
 */
export async function startWebhookServer(config: Partial<WebhookServerConfig> = {}): Promise<void> {
  const finalConfig: WebhookServerConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // Validate configuration
  if (!finalConfig.webhookSecret) {
    console.error("❌ WEBHOOK_SECRET environment variable is required");
    console.error("   Generate one with: openssl rand -hex 32");
    process.exit(1);
  }

  // Initialize persistent webhook queue
  const dbPath = process.env.WEBHOOK_QUEUE_DB || "/tmp/devintern-webhooks/queue.db";
  webhookQueue = new WebhookQueue({
    dbPath,
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || "3", 10),
    verbose: finalConfig.debug,
  });

  console.log("🚀 Starting @devintern/code Webhook Server");
  console.log(`   Port: ${finalConfig.port}`);
  console.log(`   Host: ${finalConfig.host}`);
  console.log(
    `   Auto-review: ${finalConfig.autoReview}${finalConfig.autoReview ? ` (max ${finalConfig.autoReviewMaxIterations} iterations)` : ""}`,
  );
  console.log(`   IP validation: ${finalConfig.validateIp}`);
  console.log(`   Debug mode: ${finalConfig.debug}`);

  // Log bot username for debugging
  try {
    const githubClient = new GitHubReviewsClient({ preferAppAuth: true });
    // Use a dummy repo to trigger app info fetch (doesn't need real repo for app auth)
    const botName = await githubClient.getBotUsername("_", "_");
    if (botName) {
      console.log(`   Bot username: @${botName}`);
    } else {
      console.log(`   Bot username: (unknown - no GitHub App configured, using token or no auth)`);
    }
  } catch (error) {
    console.log(`   Bot username: (failed to determine)`);
  }

  // Log queue stats and recover pending events
  const stats = webhookQueue.getStats();
  console.log(`   Queue DB: ${dbPath}`);
  if (stats.pending > 0 || stats.processing > 0 || stats.failed > 0) {
    console.log(
      `   Queue stats: ${stats.pending} pending, ${stats.processing} processing, ${stats.failed} failed`,
    );
  }

  // Re-apply a usage-limit pause if the current harness is still rate-limited
  // from before a restart. Keyed by harness so switching AGENT_HARNESS clears it.
  const harness = currentHarnessName();
  const persistedLimit = webhookQueue.getRateLimit(harness);
  if (persistedLimit && persistedLimit > Date.now()) {
    rateLimitedUntil = persistedLimit;
    reviewQueue.pause();
    scheduleRateLimitResume();
    console.warn(
      `⏳ ${harness} is still rate-limited until ${new Date(persistedLimit).toISOString()} ` +
        `— webhook queue starts paused; recovered events will wait.`,
    );
  } else if (persistedLimit) {
    // Stale window (already elapsed) — clear it.
    webhookQueue.clearRateLimit(harness);
  }

  // Recover pending/processing events from previous runs
  const pendingEvents = webhookQueue.getPendingEvents();
  if (pendingEvents.length > 0) {
    console.log(`\n🔄 Recovering ${pendingEvents.length} pending event(s) from previous run...`);
    for (const event of pendingEvents) {
      try {
        if (event.eventType === "issue_comment") {
          const payload = JSON.parse(event.payload) as IssueCommentEvent;
          console.log(
            `   Requeueing: PR comment #${payload.issue.number} (${payload.repository.full_name})`,
          );

          reviewQueue
            .add(() => processIssueCommentWithPersistence(event.id, payload, finalConfig))
            .catch((error) => {
              console.error(`❌ Error processing recovered event ${event.id}:`, error);
            });
          continue;
        }

        const payload = JSON.parse(event.payload) as PullRequestReviewEvent;
        console.log(
          `   Requeueing: PR #${payload.pull_request.number} (${payload.repository.full_name})`,
        );

        // Add to processing queue
        reviewQueue
          .add(() => processReviewWithPersistence(event.id, payload, finalConfig))
          .catch((error) => {
            console.error(`❌ Error processing recovered event ${event.id}:`, error);
          });
      } catch (error) {
        console.error(`   ⚠️  Failed to parse event ${event.id}: ${(error as Error).message}`);
        webhookQueue.markFailed(event.id, `Failed to parse: ${(error as Error).message}`);
      }
    }
  }

  console.log("");

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;
      const method = req.method || "GET";

      // Health check endpoint
      if (path === "/health" && method === "GET") {
        const response = handleHealthCheck();
        sendResponse(res, response);
        return;
      }

      // Webhook endpoint
      if (path === "/webhooks/github" && method === "POST") {
        // Convert Node request to Web Request
        const body = await readBody(req);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) {
            headers.set(key, Array.isArray(value) ? value[0] : value);
          }
        }
        const request = new Request(url.toString(), {
          method: "POST",
          headers,
          body,
        });
        const response = await handleWebhook(request, finalConfig);
        sendResponse(res, response);
        return;
      }

      // Root endpoint (info)
      if (path === "/" && method === "GET") {
        const response = jsonResponse({
          service: "@devintern/code Webhook Server",
          endpoints: {
            webhook: "POST /webhooks/github",
            health: "GET /health",
          },
        });
        sendResponse(res, response);
        return;
      }

      // 404 for unknown routes
      sendResponse(res, jsonResponse({ error: "Not found" }, 404));
    } catch (error) {
      console.error("Server error:", error);
      sendResponse(res, jsonResponse({ error: "Internal server error" }, 500));
    }
  });

  server.listen(finalConfig.port, finalConfig.host);

  console.log(`✅ Server listening on http://${finalConfig.host}:${finalConfig.port}`);
  console.log("");
  console.log("📝 Configure your GitHub App webhook URL to:");
  console.log(`   https://your-domain/webhooks/github`);
  console.log("");
  console.log("Press Ctrl+C to stop the server");
}

// CLI entry point
if (import.meta.main) {
  startWebhookServer();
}

export { DEFAULT_CONFIG };
