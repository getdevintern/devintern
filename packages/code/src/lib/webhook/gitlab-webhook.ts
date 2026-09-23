import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UsageLimitError } from "@devintern/agent-harness";
import { WorkerState } from "../state/worker-state";
import type { AgentPr } from "../state/worker-state";
import {
  gitLabWebhookDeliveryId,
  matchesRegisteredGitLabChange,
  normalizeGitLabWebhook,
  verifyGitLabWebhookSignature,
  verifyGitLabWebhookToken,
} from "../code-host/gitlab/webhook";
import type { GitLabWebhookEvent } from "../code-host/gitlab/webhook";
import { normalizeCodeHostUrl, resolveGitLabCodeHostConfig } from "../code-host";
import { GitLabReviewsClient } from "../code-host/gitlab/reviews";
import { runCiFixViaCli } from "../acquirers/ci-failure-watcher";
import {
  runAddressReviewUrlViaCli,
  runResolveConflictsUrlViaCli,
} from "../acquirers/review-polling";
import type { WebhookServerConfig } from "../../types/github-webhooks";

import { handleUsageLimit, jsonResponse, rateLimiter, reviewQueue, runtime } from "./runtime";

export interface QueuedGitLabWebhook {
  event: GitLabWebhookEvent;
  target: AgentPr;
}

/** Authenticate, scope, deduplicate, and durably enqueue one GitLab delivery. */
export async function handleGitLabWebhook(
  request: Request,
  config: WebhookServerConfig,
): Promise<Response> {
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (!rateLimiter.isAllowed(clientIp)) {
    return jsonResponse({ error: "Rate limit exceeded" }, 429);
  }
  if (!config.gitlabWebhookSecret && !config.gitlabWebhookSigningToken) {
    return jsonResponse({ error: "GitLab webhooks are not configured" }, 503);
  }
  if (!runtime.queue) {
    return jsonResponse({ error: "Webhook queue is not available" }, 503);
  }
  const queue = runtime.queue;

  let payload: Record<string, unknown>;
  const rawBody = await request.text();
  const signature = request.headers.get("webhook-signature");
  const authenticated = signature
    ? verifyGitLabWebhookSignature(
        signature,
        request.headers.get("webhook-id"),
        request.headers.get("webhook-timestamp"),
        rawBody,
        config.gitlabWebhookSigningToken ?? "",
      )
    : verifyGitLabWebhookToken(
        request.headers.get("x-gitlab-token"),
        config.gitlabWebhookSecret ?? "",
      );
  if (!authenticated) {
    return jsonResponse({ error: "Invalid GitLab webhook signature" }, 401);
  }
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }
  const event = normalizeGitLabWebhook(request.headers.get("x-gitlab-event"), payload);
  if (!event) return jsonResponse({ error: "Unsupported GitLab event type" }, 400);

  const deliveryId = gitLabWebhookDeliveryId(request.headers, rawBody, event.eventName);
  if (queue.hasProcessed("gitlab:webhook", deliveryId)) {
    return jsonResponse({ success: true, message: "Duplicate delivery", deliveryId });
  }

  if (event.kind === "ignored") {
    queue.markProcessed("gitlab:webhook", deliveryId);
    return jsonResponse({ success: true, message: "GitLab event does not require processing" });
  }

  const configuredInstanceUrl = normalizeCodeHostUrl(
    process.env.GITLAB_CODE_HOST_URL || "https://gitlab.com",
  );
  const resolved = resolveGitLabCodeHostConfig(configuredInstanceUrl);
  if (!resolved.ok) return jsonResponse({ error: resolved.message }, 503);
  const instanceUrl = normalizeCodeHostUrl(resolved.instanceUrl);
  const state = new WorkerState();
  let targets: AgentPr[];
  try {
    targets = state
      .listOpenAgentChangeRequests()
      .filter((change) => matchesRegisteredGitLabChange(event, change, instanceUrl));
  } finally {
    state.close();
  }
  if (targets.length === 0) {
    queue.markProcessed("gitlab:webhook", deliveryId);
    return jsonResponse({ success: true, message: "No registered GitLab MR matched" });
  }

  const eventIds = targets.map((target) => {
    const queued: QueuedGitLabWebhook = { event, target };
    const eventId = queue.enqueue(`gitlab:${event.kind}`, queued);
    reviewQueue
      .add(() => processGitLabWithPersistence(eventId, queued))
      .catch((error) => {
        console.error("❌ Error processing GitLab webhook:", error);
      });
    return eventId;
  });
  queue.markProcessed("gitlab:webhook", deliveryId);
  return jsonResponse({
    success: true,
    message: "GitLab event processing started",
    eventIds: eventIds.filter(Boolean),
    matchedMergeRequests: targets.length,
  });
}

export async function processGitLabWithPersistence(
  eventId: string | undefined,
  queued: QueuedGitLabWebhook,
): Promise<void> {
  if (eventId && runtime.queue) runtime.queue.markProcessing(eventId);
  try {
    await processGitLabEvent(queued);
    if (eventId && runtime.queue) runtime.queue.markCompleted(eventId);
  } catch (error) {
    if (error instanceof UsageLimitError) {
      handleUsageLimit(error.resetHint);
      if (eventId && runtime.queue) runtime.queue.requeuePending(eventId);
      reviewQueue
        .add(() => processGitLabWithPersistence(eventId, queued))
        .catch((cause) => {
          console.error("❌ Error reprocessing deferred GitLab webhook:", cause);
        });
      return;
    }
    if (eventId && runtime.queue) runtime.queue.markFailed(eventId, (error as Error).message);
    throw error;
  }
}

async function processGitLabEvent({ event, target }: QueuedGitLabWebhook): Promise<void> {
  const serializationKey = `${target.instanceUrl}:${target.projectPath}!${target.changeNumber}`;
  if (event.kind === "lifecycle") {
    const state = new WorkerState();
    try {
      state.markAgentChangeRequestClosed({
        provider: target.provider,
        instanceUrl: target.instanceUrl,
        projectId: target.projectId,
        projectPath: target.projectPath,
        number: target.changeNumber,
        webUrl: target.webUrl,
      });
    } finally {
      state.close();
    }
    return;
  }

  if (event.kind === "feedback") {
    const result = await runAddressReviewUrlViaCli(target.webUrl, serializationKey, {
      cwd: process.cwd(),
      env: process.env,
    });
    if (result === "deferred") throw new UsageLimitError();
    if (!result) throw new Error("GitLab feedback run failed");
    return;
  }

  const resolved = resolveGitLabCodeHostConfig(target.instanceUrl);
  if (!resolved.ok) throw new Error(resolved.message);
  const client = new GitLabReviewsClient(resolved.token, resolved.instanceUrl, {
    caFile: resolved.caFile,
    proxy: resolved.proxy,
  });
  const current = await client.getChangeRequest(target.projectPath, target.changeNumber);
  if (current.state !== "opened") return;
  if (event.headSha && event.headSha !== current.head.sha) return;

  if (event.kind === "sync") {
    const result = await runResolveConflictsUrlViaCli(target.webUrl, serializationKey, {
      cwd: process.cwd(),
      env: process.env,
      expectedHeadSha: current.head.sha,
      expectedBaseSha: current.base.sha || undefined,
    });
    if (result.outcome === "failed") throw new Error(result.message);
    return;
  }

  if (event.kind === "ci") {
    const snapshot = await client.getCiSnapshot(target.projectPath, current.head.sha);
    if (snapshot.state !== "failure" || snapshot.failures.length === 0) return;
    const rawLogs = await client.getJobTraces(target.projectPath, snapshot.jobIds);
    const { truncateCiLogs } = await import("../acquirers/ci-failure-watcher");
    const feedbackDir = mkdtempSync(join(tmpdir(), "devintern-gitlab-webhook-ci-"));
    const feedbackPath = join(feedbackDir, "ci-feedback.json");
    writeFileSync(
      feedbackPath,
      JSON.stringify({
        repository: target.projectPath,
        prNumber: target.changeNumber,
        branch: current.head.ref,
        failures: snapshot.failures.map((failure) => ({
          name: failure.name,
          conclusion: failure.conclusion,
          detailsUrl: failure.detailsUrl,
        })),
        logs: truncateCiLogs(rawLogs),
      }),
    );
    try {
      const ok = await runCiFixViaCli(target.projectPath, target.changeNumber, feedbackPath, {
        cwd: process.cwd(),
        env: process.env,
        webUrl: target.webUrl,
        serializationKey,
        expectedHeadSha: current.head.sha,
      });
      if (!ok) throw new Error("GitLab CI repair did not complete");
    } finally {
      rmSync(feedbackDir, { recursive: true, force: true });
    }
  }
}
