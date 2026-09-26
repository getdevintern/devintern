#!/usr/bin/env node

/**
 * Webhook Server for @devintern/code
 *
 * Listens for GitHub PR and GitLab MR events and automatically handles
 * registered review, lifecycle, synchronization, and CI work.
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { parseEnvInteger } from "./lib/config/env-integer";
import { initSentryOnce } from "./lib/observability/sentry-init";
import { captureError, flushErrorTracking } from "@devintern/utils";
import { GitHubReviewsClient } from "./lib/code-host/github/reviews";
import { LEGACY_DB_PATH, WebhookQueue, resolveQueueDbPath } from "./lib/state/webhook-queue";
import { startWorkerFailover } from "./lib/worker/failover";
import { resolveAutoReviewIterationsIfEnabled } from "./lib/review/auto-review-config";
import {
  handlePingEvent,
  isGitHubIP,
  parseEventType,
  verifyWebhookSignature,
} from "./lib/code-host/github/webhook";
import type {
  IssueCommentEvent,
  PingEvent,
  PullRequestReviewEvent,
  WebhookServerConfig,
} from "./types/github-webhooks";

import {
  DEFAULT_CONFIG,
  debugLog,
  handleHealthCheck,
  jsonResponse,
  rateLimiter,
  readBody,
  reviewQueue,
  runtime,
  sendResponse,
  skipResponse,
} from "./lib/webhook/runtime";
import {
  processIssueCommentAsync,
  processIssueCommentWithPersistence,
  processReviewWithPersistence,
} from "./lib/webhook/review-pipeline";
import { handleGitLabWebhook, processGitLabWithPersistence } from "./lib/webhook/gitlab-webhook";
import type { QueuedGitLabWebhook } from "./lib/webhook/gitlab-webhook";

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

  // Dedupe GitHub redeliveries by delivery id. Ids are marked processed at
  // enqueue time — the queue row is durable from that point, so a redelivery
  // (manual or automatic) must not enqueue the same work twice.
  const deliveryId = request.headers.get("x-github-delivery");
  if (
    deliveryId &&
    (eventType === "pull_request_review" || eventType === "issue_comment") &&
    runtime.queue?.hasProcessed("github", deliveryId)
  ) {
    console.log(`⏭️  Skipping duplicate delivery ${deliveryId} (${eventType})`);
    return jsonResponse({ success: true, message: "Duplicate delivery", deliveryId });
  }

  // Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  // Handle ping event
  if (eventType === "ping") {
    const result = handlePingEvent(payload as PingEvent);
    return jsonResponse({ success: true, message: result.message });
  }

  // Handle pull_request_review event
  if (eventType === "pull_request_review") {
    return handlePullRequestReview(
      payload as PullRequestReviewEvent,
      config,
      startTime,
      deliveryId,
    );
  }

  // Handle issue_comment event — top-level (conversation) comments on a PR.
  // Lets a user kick off devintern by commenting "@bot finish this" on their
  // own PR, without leaving a formal review.
  if (eventType === "issue_comment") {
    return handleIssueComment(payload as IssueCommentEvent, config, startTime, deliveryId);
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

/** Validate and enqueue a `pull_request_review` event. */
async function handlePullRequestReview(
  event: PullRequestReviewEvent,
  config: WebhookServerConfig,
  startTime: number,
  deliveryId: string | null,
): Promise<Response> {
  // Quick payload-only checks (no API calls — respond 200 fast)
  // Accept "changes_requested" and plain "comment" reviews; the bot-mention
  // gate (applied later in processReviewAsync) keeps commented reviews from
  // firing unless @bot is mentioned.
  if (event.review.state !== "changes_requested" && event.review.state !== "commented") {
    console.log(
      `⏭️  Skipping review on PR #${event.pull_request.number}: state is "${event.review.state}" (only changes_requested/commented are processed)`,
    );
    return skipResponse("Review does not require processing", `state=${event.review.state}`);
  }

  if (event.review.user.type === "Bot") {
    console.log(
      `⏭️  Skipping review on PR #${event.pull_request.number}: reviewer is a bot (${event.review.user.login})`,
    );
    return skipResponse("Review does not require processing", "reviewer is a bot");
  }

  if (event.pull_request.state !== "open") {
    console.log(
      `⏭️  Skipping review on PR #${event.pull_request.number}: PR is ${event.pull_request.state} (not open)`,
    );
    return skipResponse(
      "Review does not require processing",
      `pr_state=${event.pull_request.state}`,
    );
  }

  console.log(`\n🔔 Received ${event.review.state} review for PR #${event.pull_request.number}`);
  console.log(`   Repository: ${event.repository.full_name}`);
  console.log(`   Reviewer: ${event.review.user.login}`);

  // Persist event to SQLite before processing (crash resilience)
  let eventId: string | undefined;
  if (runtime.queue) {
    eventId = runtime.queue.enqueue("pull_request_review", event);
    if (deliveryId) {
      runtime.queue.markProcessed("github", deliveryId);
    }
    debugLog(config, `Persisted event ${eventId} to queue`);
  }

  // Add to queue for sequential processing (prevents race conditions)
  // Bot mention check happens inside processReviewAsync after fetching comments
  reviewQueue
    .add(() => processReviewWithPersistence(eventId, event, config))
    .catch((error) => {
      console.error("❌ Error processing review:", error);
    });

  return jsonResponse({
    success: true,
    message: "Review processing started",
    eventId,
    prNumber: event.pull_request.number,
    repository: event.repository.full_name,
    processingTime: `${Date.now() - startTime}ms`,
  });
}

/** Validate and enqueue an `issue_comment` event on a pull request. */
async function handleIssueComment(
  event: IssueCommentEvent,
  config: WebhookServerConfig,
  startTime: number,
  deliveryId: string | null,
): Promise<Response> {
  // Quick payload-only checks (no API calls — respond 200 fast)
  if (event.action !== "created") {
    console.log(
      `⏭️  Skipping comment on #${event.issue.number}: action is "${event.action}" (only "created" is processed)`,
    );
    return skipResponse("Comment does not require processing", `action=${event.action}`);
  }

  if (!event.issue.pull_request) {
    console.log(`⏭️  Skipping comment on #${event.issue.number}: not on a pull request`);
    return skipResponse("Comment is not on a pull request", "not_a_pull_request");
  }

  if (event.comment.user.type === "Bot") {
    console.log(
      `⏭️  Skipping comment on #${event.issue.number}: author is a bot (${event.comment.user.login})`,
    );
    return skipResponse("Comment does not require processing", "author is a bot");
  }

  if (event.issue.state !== "open") {
    console.log(
      `⏭️  Skipping comment on #${event.issue.number}: PR is ${event.issue.state} (not open)`,
    );
    return skipResponse("Comment does not require processing", `pr_state=${event.issue.state}`);
  }

  console.log(`\n🔔 Received PR comment on #${event.issue.number}`);
  console.log(`   Repository: ${event.repository.full_name}`);
  console.log(`   Commenter: ${event.comment.user.login}`);

  // Persist event to SQLite before processing (crash resilience)
  let eventId: string | undefined;
  if (runtime.queue) {
    eventId = runtime.queue.enqueue("issue_comment", event);
    if (deliveryId) {
      runtime.queue.markProcessed("github", deliveryId);
    }
    debugLog(config, `Persisted event ${eventId} to queue`);
  }

  // Bot mention check happens inside processReviewAsync after fetching the PR.
  reviewQueue
    .add(() => processIssueCommentWithPersistence(eventId, event, config))
    .catch((error) => {
      console.error("❌ Error processing PR comment:", error);
    });

  return jsonResponse({
    success: true,
    message: "Comment processing started",
    eventId,
    prNumber: event.issue.number,
    repository: event.repository.full_name,
    processingTime: `${Date.now() - startTime}ms`,
  });
}

/**
 * Start the code-host webhook HTTP server and recover pending queue events.
 *
 * @param config - Partial configuration merged with defaults and env vars
 * @throws Exits the process when neither provider webhook secret is configured
 */
export async function startWebhookServer(
  config: Partial<WebhookServerConfig> = {},
): Promise<import("http").Server> {
  // Unified auto-review iteration cap: explicit config override > the shared
  // AUTO_REVIEW_ITERATIONS env var (with the deprecated WEBHOOK_* alias as a
  // warned fallback) > the shared default. Mirroring the CLI, resolution is
  // gated on auto-review being enabled: an invalid value stops startup only
  // when the loop would actually run (or an explicit override was passed);
  // otherwise the cap is unused and env vars are ignored.
  let autoReviewIterations: number;
  try {
    autoReviewIterations = resolveAutoReviewIterationsIfEnabled(
      config.autoReviewMaxIterations,
      config.autoReview ?? DEFAULT_CONFIG.autoReview,
    );
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }

  const finalConfig: WebhookServerConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    autoReviewMaxIterations: autoReviewIterations,
  };

  // Validate configuration
  if (
    !finalConfig.webhookSecret &&
    !finalConfig.gitlabWebhookSecret &&
    !finalConfig.gitlabWebhookSigningToken
  ) {
    console.error(
      "❌ WEBHOOK_SECRET, GITLAB_WEBHOOK_SECRET, or GITLAB_WEBHOOK_SIGNING_TOKEN is required",
    );
    console.error("   Generate a secret with: openssl rand -hex 32");
    process.exit(1);
  }

  // Initialize persistent webhook queue
  const dbPath = resolveQueueDbPath();
  runtime.queue = new WebhookQueue({
    dbPath,
    maxRetries: parseEnvInteger("WEBHOOK_MAX_RETRIES", 3, { min: 0 }),
    verbose: finalConfig.debug,
    legacyDbPath: LEGACY_DB_PATH,
  });

  console.log("🚀 Starting @devintern/code Webhook Server");
  console.log(`   Port: ${finalConfig.port}`);
  console.log(`   Host: ${finalConfig.host}`);
  console.log(
    `   Auto-review: ${finalConfig.autoReview}${finalConfig.autoReview ? ` (max ${finalConfig.autoReviewMaxIterations} iterations)` : ""}`,
  );
  console.log(`   IP validation: ${finalConfig.validateIp}`);
  console.log(`   Debug mode: ${finalConfig.debug}`);

  // Log the GitHub bot username for debugging when that provider is enabled.
  if (finalConfig.webhookSecret) {
    try {
      const githubClient = new GitHubReviewsClient({ preferAppAuth: true });
      // Use a dummy repo to trigger app info fetch (doesn't need real repo for app auth)
      const botName = await githubClient.getBotUsername("_", "_");
      if (botName) {
        console.log(`   Bot username: @${botName}`);
      } else {
        console.log(
          `   Bot username: (unknown - no GitHub App configured, using token or no auth)`,
        );
      }
    } catch {
      console.log(`   Bot username: (failed to determine)`);
    }
  }

  // Prune expired dedupe ids and stale failed events on startup
  runtime.queue.cleanupProcessedEvents();
  runtime.queue.cleanup();

  // Log queue stats and recover pending events
  const stats = runtime.queue.getStats();
  console.log(`   Queue DB: ${dbPath}`);
  if (stats.pending > 0 || stats.processing > 0 || stats.failed > 0) {
    console.log(
      `   Queue stats: ${stats.pending} pending, ${stats.processing} processing, ${stats.failed} failed`,
    );
  }

  // Shared failover controller: same chain, windows, and failback timers the
  // fleet worker uses. Persist through the queue DB so a restart resumes on
  // the right harness.
  runtime.failover = startWorkerFailover({
    queue: runtime.queue,
    onPause: ({ untilMs, harness, resetHint }) => {
      if (!reviewQueue.isPaused) {
        reviewQueue.pause();
      }
      const waitMs = Math.max(0, untilMs - Date.now());
      console.warn(
        `⏳ ${harness} hit a usage limit${resetHint ? ` (resets ${resetHint})` : ""} and no fallback harness is available. ` +
          `Pausing webhook queue until ${new Date(untilMs).toISOString()} (~${Math.round(waitMs / 60000)} min). ` +
          `Queued and incoming events will wait and drain on resume.`,
      );
    },
    onResume: () => {
      if (reviewQueue.isPaused) {
        console.log(`▶️  Usage-limit windows elapsed — resuming webhook queue`);
        reviewQueue.start();
      }
    },
  });
  if (runtime.failover.allLimited() && !reviewQueue.isPaused) {
    reviewQueue.pause();
  }

  // Recover pending/processing events from previous runs
  const pendingEvents = runtime.queue.getPendingEvents();
  if (pendingEvents.length > 0) {
    console.log(`\n🔄 Recovering ${pendingEvents.length} pending event(s) from previous run...`);
    for (const event of pendingEvents) {
      try {
        if (event.eventType.startsWith("gitlab:")) {
          const payload = JSON.parse(event.payload) as QueuedGitLabWebhook;
          console.log(
            `   Requeueing: GitLab MR !${payload.target.changeNumber} (${payload.target.projectPath})`,
          );
          reviewQueue
            .add(() => processGitLabWithPersistence(event.id, payload))
            .catch((error) => {
              console.error(`❌ Error processing recovered event ${event.id}:`, error);
            });
          continue;
        }
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
        runtime.queue.markFailed(event.id, `Failed to parse: ${(error as Error).message}`);
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

      if (path === "/webhooks/gitlab" && method === "POST") {
        const body = await readBody(req);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
        }
        const request = new Request(url.toString(), { method: "POST", headers, body });
        const response = await handleGitLabWebhook(request, finalConfig);
        sendResponse(res, response);
        return;
      }

      // Root endpoint (info)
      if (path === "/" && method === "GET") {
        const response = jsonResponse({
          service: "@devintern/code Webhook Server",
          endpoints: {
            githubWebhook: "POST /webhooks/github",
            gitlabWebhook: "POST /webhooks/gitlab",
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

  return server;
}

// CLI entry point. When run via `devintern webhook serve`, index.ts owns
// environment loading, Sentry init, and the process-level fatal handlers.
// This standalone entry (`bun src/webhook-server.ts`) must set those up itself.
if (import.meta.main) {
  initSentryOnce();

  const reportFatal = (kind: string, error: unknown): void => {
    console.error(`❌ Uncaught ${kind}:`, error);
    captureError(error, { command: "webhook-serve-standalone" });
    void flushErrorTracking().finally(() => process.exit(1));
  };
  process.on("uncaughtException", (error) => reportFatal("exception", error));
  process.on("unhandledRejection", (reason) => reportFatal("rejection", reason));

  const stop = (signal: string): void => {
    console.log(`\n🛑 Received ${signal}, stopping webhook server...`);
    void flushErrorTracking().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  startWebhookServer();
}

export { DEFAULT_CONFIG, handleGitLabWebhook, processIssueCommentAsync };
