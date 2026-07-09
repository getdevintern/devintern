/**
 * Webhook Handler
 *
 * Handles GitHub webhook signature verification and event routing.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type {
  PingEvent,
  ProcessedReviewComment,
  ProcessedReviewFeedback,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
  SignatureVerificationResult,
  WebhookEventType,
  WebhookProcessingResult,
} from "../types/github-webhooks";

/**
 * Verify a GitHub webhook payload signature (HMAC-SHA256).
 *
 * @param payload - Raw request body string
 * @param signature - Value of the `X-Hub-Signature-256` header
 * @param secret - Configured webhook secret
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): SignatureVerificationResult {
  if (!signature) {
    return {
      valid: false,
      error: "Missing X-Hub-Signature-256 header",
    };
  }

  if (!signature.startsWith("sha256=")) {
    return {
      valid: false,
      error: "Invalid signature format (expected sha256=...)",
    };
  }

  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (signatureBuffer.length !== expectedBuffer.length) {
      return {
        valid: false,
        error: "Signature length mismatch",
      };
    }

    const valid = timingSafeEqual(signatureBuffer, expectedBuffer);
    return { valid };
  } catch (error) {
    return {
      valid: false,
      error: `Signature verification failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Parse the `X-GitHub-Event` header into a supported event type.
 *
 * @param eventHeader - Raw header value
 * @returns Supported event type, or `null`
 */
export function parseEventType(eventHeader: string | null): WebhookEventType | null {
  if (!eventHeader) {
    return null;
  }

  const supportedEvents: WebhookEventType[] = [
    "pull_request_review",
    "pull_request_review_comment",
    "issue_comment",
    "ping",
  ];

  if (supportedEvents.includes(eventHeader as WebhookEventType)) {
    return eventHeader as WebhookEventType;
  }

  return null;
}

/**
 * Check whether text mentions the bot (`@name` or `@name[bot]`).
 *
 * @param text - Text to search (review body, comment, etc.)
 * @param botName - Bot login (e.g. `my-app[bot]`)
 */
export function containsBotMention(text: string | null, botName?: string): boolean {
  if (!text) {
    return false;
  }

  if (!botName) {
    // No bot name provided, cannot check for mentions
    return false;
  }

  // Escape special regex characters in bot name
  const escapedName = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`@${escapedName}\\b`, "i");
  if (pattern.test(text)) {
    return true;
  }

  // Also check without [bot] suffix (e.g., @devintern instead of @devintern[bot])
  if (botName.endsWith("[bot]")) {
    const nameWithoutBot = botName.slice(0, -5); // Remove "[bot]"
    const escapedNameWithoutBot = nameWithoutBot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patternWithoutBot = new RegExp(`@${escapedNameWithoutBot}\\b`, "i");
    return patternWithoutBot.test(text);
  }

  return false;
}

/**
 * Return true when a review body or any comment mentions the bot.
 *
 * @param event - Pull request review webhook payload
 * @param comments - Processed inline review comments
 * @param botName - Bot login to match
 */
export function reviewMentionsBot(
  event: PullRequestReviewEvent,
  comments: ProcessedReviewComment[] = [],
  botName?: string,
): boolean {
  if (!botName) {
    // No bot name provided, cannot check for mentions
    return false;
  }

  // Check review body
  if (containsBotMention(event.review.body, botName)) {
    return true;
  }

  // Check any comments
  for (const comment of comments) {
    if (containsBotMention(comment.body, botName)) {
      return true;
    }
  }

  return false;
}

/**
 * Decide whether an incoming review should trigger automated processing.
 *
 * @param event - Pull request review webhook payload
 * @param options - Bot mention requirement and comment context
 */
export function shouldProcessReview(
  event: PullRequestReviewEvent,
  options: {
    requireBotMention?: boolean;
    botName?: string;
    comments?: ProcessedReviewComment[];
  } = {},
): boolean {
  // Process "request changes" reviews and plain "comment" reviews. Approvals
  // and dismissals are never actionable. A bot mention (checked below) keeps
  // commented reviews from firing on every passing remark.
  if (event.review.state !== "changes_requested" && event.review.state !== "commented") {
    return false;
  }

  // Don't process reviews from bots (to avoid loops)
  if (event.review.user.type === "Bot") {
    return false;
  }

  // Only process for open PRs
  if (event.pull_request.state !== "open") {
    return false;
  }

  // If bot mention is required, check for it
  if (options.requireBotMention) {
    if (!reviewMentionsBot(event, options.comments || [], options.botName)) {
      return false;
    }
  }

  return true;
}

/**
 * Normalize a review webhook event into {@link ProcessedReviewFeedback}.
 *
 * @param event - Pull request review webhook payload
 * @param comments - Processed inline review comments
 */
export function processReviewEvent(
  event: PullRequestReviewEvent,
  comments: ProcessedReviewComment[] = [],
): ProcessedReviewFeedback {
  return {
    prNumber: event.pull_request.number,
    prTitle: event.pull_request.title,
    repository: event.repository.full_name,
    branch: event.pull_request.head.ref,
    reviewer: event.review.user.login,
    reviewState: event.review.state,
    reviewBody: event.review.body,
    comments,
    installationId: event.installation?.id,
  };
}

/**
 * Normalize a single review comment webhook payload.
 *
 * @param comment - Raw comment object from the webhook
 */
export function processReviewComment(
  comment: PullRequestReviewCommentEvent["comment"],
): ProcessedReviewComment {
  return {
    id: comment.id,
    path: comment.path,
    line: comment.line ?? comment.original_line,
    side: comment.side,
    diffHunk: comment.diff_hunk,
    body: comment.body,
    reviewer: comment.user.login,
    isReply: comment.in_reply_to_id !== undefined,
  };
}

/**
 * Handle GitHub `ping` webhook (sent when a hook is first configured).
 *
 * @param event - Ping event payload
 */
export function handlePingEvent(event: PingEvent): WebhookProcessingResult {
  console.log(`🏓 Received ping from GitHub: "${event.zen}"`);
  console.log(`   Hook ID: ${event.hook_id}`);
  console.log(`   Events: ${event.hook.events.join(", ")}`);

  return {
    success: true,
    message: `Webhook configured successfully. Zen: ${event.zen}`,
  };
}

/**
 * Simple in-memory rate limiter.
 * Tracks requests per IP within a time window.
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private windowMs: number;
  private maxRequests: number;

  /**
   * @param windowMs - Sliding window size in milliseconds
   * @param maxRequests - Maximum requests allowed per IP per window
   */
  constructor(windowMs = 60000, maxRequests = 30) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check whether a request from the given IP should be allowed.
   *
   * @param ip - Client IP address
   */
  isAllowed(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get existing requests for this IP
    let ipRequests = this.requests.get(ip) || [];

    // Filter to only requests within the window
    ipRequests = ipRequests.filter((timestamp) => timestamp > windowStart);

    // Check if under limit
    if (ipRequests.length >= this.maxRequests) {
      return false;
    }

    // Record this request
    ipRequests.push(now);
    this.requests.set(ip, ipRequests);

    return true;
  }

  /**
   * Get remaining allowed requests for an IP in the current window.
   *
   * @param ip - Client IP address
   */
  getRemaining(ip: string): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const ipRequests = (this.requests.get(ip) || []).filter((timestamp) => timestamp > windowStart);
    return Math.max(0, this.maxRequests - ipRequests.length);
  }

  /** Drop expired timestamps to limit memory growth. Call periodically. */
  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [ip, timestamps] of this.requests.entries()) {
      const valid = timestamps.filter((t) => t > windowStart);
      if (valid.length === 0) {
        this.requests.delete(ip);
      } else {
        this.requests.set(ip, valid);
      }
    }
  }
}

/**
 * GitHub webhook IP ranges for allowlisting.
 * These can be fetched from https://api.github.com/meta
 * but are hardcoded here for reliability.
 *
 * Last updated: 2024-12
 */
export const GITHUB_WEBHOOK_IP_RANGES = [
  "140.82.112.0/20",
  "143.55.64.0/20",
  "185.199.108.0/22",
  "192.30.252.0/22",
];

/**
 * Check whether an IP falls within GitHub's published webhook CIDR ranges.
 *
 * @param ip - Client IP (IPv4 or IPv4-mapped IPv6)
 */
export function isGitHubIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 addresses (e.g., ::ffff:192.30.252.1)
  const normalizedIp = ip.replace(/^::ffff:/, "");

  // Simple CIDR check for GitHub ranges
  for (const range of GITHUB_WEBHOOK_IP_RANGES) {
    if (isIpInCidr(normalizedIp, range)) {
      return true;
    }
  }

  return false;
}

/** Test whether an IPv4 address lies within a CIDR range. */
function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = -1 << (32 - parseInt(bits, 10));

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);

  if (ipNum === null || rangeNum === null) {
    return false;
  }

  return (ipNum & mask) === (rangeNum & mask);
}

/** Convert an IPv4 address string to a 32-bit unsigned integer. */
function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let num = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255) {
      return null;
    }
    num = (num << 8) + octet;
  }

  return num >>> 0; // Convert to unsigned
}
