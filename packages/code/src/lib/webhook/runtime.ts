import type { IncomingMessage, ServerResponse } from "http";
import PQueue from "p-queue";
import type { ResolvedHarness } from "@devintern/agent-harness";
import { ensureWorkerFailover } from "../worker/failover";
import type { WorkerFailover } from "../worker/failover";
import { DEFAULT_AUTO_REVIEW_ITERATIONS } from "../review/auto-review-config";
import { RateLimiter } from "../code-host/github/webhook";
import type { WebhookServerConfig } from "../../types/github-webhooks";
import type { WebhookQueue } from "../state/webhook-queue";

export const DEFAULT_CONFIG: WebhookServerConfig = {
  port: parseInt(process.env.WEBHOOK_PORT || "3000", 10),
  host: process.env.WEBHOOK_HOST || "0.0.0.0",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  gitlabWebhookSecret: process.env.GITLAB_WEBHOOK_SECRET || "",
  gitlabWebhookSigningToken: process.env.GITLAB_WEBHOOK_SIGNING_TOKEN || "",
  autoReview: process.env.WEBHOOK_AUTO_REVIEW === "true",
  // Placeholder replaced in startWebhookServer with the unified cap resolved
  // from AUTO_REVIEW_ITERATIONS (or the deprecated webhook-only alias) when
  // auto-review is enabled or an explicit override was provided.
  autoReviewMaxIterations: DEFAULT_AUTO_REVIEW_ITERATIONS,
  validateIp: process.env.WEBHOOK_VALIDATE_IP === "true",
  debug: process.env.WEBHOOK_DEBUG === "true",
};

// Rate limiter instance
export const rateLimiter = new RateLimiter(60000, 30); // 30 requests per minute

// Review processing queue - ensures sequential processing to avoid race conditions
export const reviewQueue = new PQueue({ concurrency: 1 });

// Mutable singleton state shared across webhook modules. One object (rather
// than mutable exports) lets reads and writes cross module boundaries.
export const runtime = {
  queue: null as WebhookQueue | null,
  failover: null as WorkerFailover | null,
};

setInterval(() => rateLimiter.cleanup(), 60000);
// Note: We use a single reusable worktree, so no periodic cleanup needed

/**
 * Lazily build the failover state from the `AGENT_HARNESS` chain.
 *
 * Startup always initializes with installability checks; this fallback covers
 * direct module use before `startWebhookServer` runs (e.g. in tests).
 */
function ensureFailover(): WorkerFailover {
  if (runtime.failover) {
    return runtime.failover;
  }
  runtime.failover = ensureWorkerFailover();
  return runtime.failover;
}

/** Name of the agent harness currently driving this server (e.g. `claude-code`). */
export function currentHarnessName(): string {
  return ensureFailover().activeName;
}

/**
 * Resolve the active harness and its executable path for an agent spawn.
 *
 * Per-harness env overrides (`<HARNESS>_CLI_PATH`) were already applied when
 * the chain was resolved, so every spawn uses the right CLI for whichever
 * harness failover selected. `AGENT_MODEL` is read at spawn time and applies
 * to the active harness (the string is harness-specific by nature).
 *
 * @returns The resolved harness and executable path to spawn.
 */
export function resolveActiveHarness(): ResolvedHarness {
  return ensureFailover().resolvedHarness();
}

/**
 * Handle a usage-limit report from the active harness.
 *
 * With a multi-harness `AGENT_HARNESS` chain, fail over to the highest-priority
 * harness whose limit window has elapsed and keep processing — the queue only
 * pauses when every harness in the chain is limited (which is also the exact
 * behavior of a single-harness configuration). The window is persisted per
 * harness and the failback timer armed, so the worker returns to the primary
 * harness as soon as its window ends.
 *
 * @param resetHint - Human-readable reset hint from the agent output
 */
export function handleUsageLimit(resetHint?: string): void {
  ensureFailover().reportFromHint({ resetsAt: resetHint });
}

/**
 * Log a debug message when debug mode is enabled.
 *
 * @param config - Server configuration
 * @param message - Message to print
 */
export function debugLog(config: WebhookServerConfig, message: string): void {
  if (config.debug) {
    console.log(`[DEBUG] ${message}`);
  }
}

/**
 * Build a JSON HTTP response.
 *
 * @param data - Response body object
 * @param status - HTTP status code
 */
export function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a 200 response for an event that was delivered but needs no work. */
export function skipResponse(message: string, reason: string): Response {
  return jsonResponse({ success: true, message, reason });
}

/** Return JSON health payload including webhook queue stats and failover state. */
export function handleHealthCheck(): Response {
  const queueStats = runtime.queue?.getStats() || {
    pending: 0,
    processing: 0,
    failed: 0,
  };
  const manager = runtime.failover;
  return jsonResponse({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    queue: queueStats,
    harness: {
      active: manager?.activeName ?? currentHarnessName(),
      chain: manager?.describeChain() ?? currentHarnessName(),
      rateLimitedUntil: manager?.windows() ?? {},
    },
  });
}

/**
 * Read the full request body from a Node.js `IncomingMessage`.
 *
 * @param req - HTTP incoming message
 */
export function readBody(req: IncomingMessage): Promise<string> {
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
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const body = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("Content-Type") || "application/json",
  });
  res.end(body);
}
