import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UsageLimitError } from "@devintern/agent-harness";
import { WorkerState } from "../state/worker-state";
import type { AgentPr, AgentPrMergeDetails } from "../state/worker-state";
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
import type { GitLabCiFailure, GitLabCiSnapshot } from "../code-host/gitlab/reviews";
import { runCiFixViaCli } from "../acquirers/ci-failure-watcher";
import {
  runAddressReviewUrlViaCli,
  runResolveConflictsUrlViaCli,
} from "../acquirers/review-polling";
import type { WebhookServerConfig } from "../../types/github-webhooks";

import { handleUsageLimit, jsonResponse, rateLimiter, reviewQueue, runtime } from "./runtime";
import { classifyWebhookError } from "./webhook-errors";

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
  const delivery = { source: "gitlab:webhook", externalId: deliveryId };
  const claim = queue.beginDelivery(delivery.source, delivery.externalId);
  if (claim === "handled") {
    return jsonResponse({ success: true, message: "Duplicate delivery", deliveryId });
  }
  if (claim === "inFlight") {
    // Do not acknowledge a redelivery as done while the original is running.
    return jsonResponse(
      { success: false, message: "Delivery already in progress", deliveryId },
      409,
    );
  }

  if (event.kind === "ignored") {
    queue.completeDelivery(delivery.source, delivery.externalId);
    return jsonResponse({ success: true, message: "GitLab event does not require processing" });
  }

  const configuredInstanceUrl = normalizeCodeHostUrl(
    process.env.GITLAB_CODE_HOST_URL || "https://gitlab.com",
  );
  const resolved = resolveGitLabCodeHostConfig(configuredInstanceUrl);
  if (!resolved.ok) {
    // Missing credentials are transient: release the claim so a redelivery can
    // process the event once configuration is fixed.
    queue.abandonDelivery(delivery.source, delivery.externalId);
    return jsonResponse({ error: resolved.message }, 503);
  }
  const instanceUrl = normalizeCodeHostUrl(resolved.instanceUrl);
  const state = new WorkerState();
  let targets: AgentPr[];
  try {
    targets = state
      .listOpenAgentChangeRequests()
      .filter((change) => matchesRegisteredGitLabChange(event, change, instanceUrl));
  } catch (error) {
    queue.abandonDelivery(delivery.source, delivery.externalId);
    throw error;
  } finally {
    state.close();
  }
  if (targets.length === 0) {
    queue.completeDelivery(delivery.source, delivery.externalId);
    return jsonResponse({ success: true, message: "No registered GitLab MR matched" });
  }

  // One delivery can fan out to several target rows. Settle the delivery only
  // once every queued target has finished, and leave it abandoned (retryable)
  // if any of them failed transiently.
  let outstanding = targets.length;
  let anyTransient = false;
  const settle = (outcome: "handled" | "transient"): void => {
    if (outcome === "transient") anyTransient = true;
    outstanding -= 1;
    if (outstanding > 0) return;
    if (anyTransient) {
      queue.abandonDelivery(delivery.source, delivery.externalId);
    } else {
      queue.completeDelivery(delivery.source, delivery.externalId);
    }
  };

  const eventIds = targets.map((target) => {
    const queued: QueuedGitLabWebhook = { event, target };
    const eventId = queue.enqueue(`gitlab:${event.kind}`, queued);
    reviewQueue
      .add(() => processGitLabWithPersistence(eventId, queued, settle))
      .catch((error) => {
        console.error("❌ Error processing GitLab webhook:", error);
      });
    return eventId;
  });
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
  settle?: (outcome: "handled" | "transient") => void,
): Promise<void> {
  if (eventId && runtime.queue) runtime.queue.markProcessing(eventId);
  try {
    await processGitLabEvent(queued);
    if (eventId && runtime.queue) runtime.queue.markCompleted(eventId);
    settle?.("handled");
  } catch (error) {
    if (error instanceof UsageLimitError) {
      handleUsageLimit(error.resetHint, error.period);
      if (eventId && runtime.queue) runtime.queue.requeuePending(eventId);
      reviewQueue
        .add(() => processGitLabWithPersistence(eventId, queued, settle))
        .catch((cause) => {
          console.error("❌ Error reprocessing deferred GitLab webhook:", cause);
        });
      return;
    }
    const permanent = classifyWebhookError(error) === "permanent";
    if (eventId && runtime.queue) {
      if (permanent) {
        runtime.queue.markCompleted(eventId);
      } else {
        runtime.queue.markFailed(eventId, (error as Error).message);
      }
    }
    settle?.(permanent ? "handled" : "transient");
    throw error;
  }
}

/**
 * Merge facts from a merge-request hook payload: the target branch, and the
 * merge time when the payload carries one. Missing fields stay `undefined`.
 */
function lifecycleMergeDetails(payload: Record<string, unknown>): AgentPrMergeDetails {
  const attributes = payload.object_attributes;
  if (typeof attributes !== "object" || attributes === null) return {};
  const { target_branch: targetBranch, merged_at: mergedAtRaw } = attributes as Record<
    string,
    unknown
  >;
  const mergedAt = typeof mergedAtRaw === "string" ? Date.parse(mergedAtRaw) : Number.NaN;
  return {
    mergedAt: Number.isFinite(mergedAt) ? mergedAt : undefined,
    mergedInto: typeof targetBranch === "string" && targetBranch !== "" ? targetBranch : undefined,
  };
}

async function processGitLabEvent({ event, target }: QueuedGitLabWebhook): Promise<void> {
  const serializationKey = `${target.instanceUrl}:${target.projectPath}!${target.changeNumber}`;
  if (event.kind === "lifecycle") {
    const state = new WorkerState();
    try {
      state.markAgentChangeRequestClosed(
        {
          provider: target.provider,
          instanceUrl: target.instanceUrl,
          projectId: target.projectId,
          projectPath: target.projectPath,
          number: target.changeNumber,
          webUrl: target.webUrl,
        },
        event.state === "closed" ? "closed" : "merged",
        event.state === "closed" ? undefined : lifecycleMergeDetails(event.payload),
      );
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
    // Several deliveries can report the same failures: a branch pipeline and
    // an MR pipeline for one push, or a Job Hook followed by its Pipeline
    // Hook. The repair reads the whole snapshot for the head SHA, so run it
    // once per (MR, head SHA, set of failed job names). Names, not job ids:
    // the two pipelines run separate jobs with the same names, and the
    // snapshot is taken at processing time, so it can already include the
    // other pipeline's copy of a failure. Only a newly failing job name at
    // the same SHA runs again, or a retried job that failed again (see
    // {@link hasRetriedFailure}). Skipping while CI is still pending is not
    // an option: only failed deliveries become `ci` events, so the last one
    // may arrive while another pipeline is running and none would follow it.
    const ledger = runtime.queue;
    const baseKey = ciRepairKey(serializationKey, current.head.sha, snapshot.failures);
    let repairKey = baseKey;
    if (ledger?.hasProcessed(CI_REPAIR_SOURCE, baseKey)) {
      if (!hasRetriedFailure(ledger, baseKey, snapshot.failures)) return;
      repairKey = `${baseKey}#retry:${JSON.stringify(failedJobIds(snapshot.failures))}`;
    }
    if (ledger) {
      const claim = ledger.beginDelivery(CI_REPAIR_SOURCE, repairKey);
      if (claim === "handled") return;
      // Defensive guard only: `reviewQueue` runs one job at a time, so an
      // earlier repair has already completed or released this claim before
      // the next delivery is processed. If concurrency is ever raised, this
      // keeps two repairs for one key from running at once. Throwing does not
      // retry the delivery in this process: GitLab already got its 200, and
      // the event row only goes back to pending for the next startup
      // recovery. If the in-flight repair then fails, a later delivery or a
      // restart has to start the retry.
      if (claim === "inFlight") throw new Error("GitLab CI repair already in progress");
    }
    let repaired = false;
    try {
      await runGitLabCiRepair(client, target, serializationKey, current.head, snapshot);
      repaired = true;
    } finally {
      // A failed or deferred repair stays retryable by a later delivery.
      if (ledger && repaired) {
        for (const jobId of failedJobIds(snapshot.failures)) {
          ledger.markProcessed(CI_REPAIR_SOURCE, ciRepairJobKey(baseKey, jobId));
        }
        ledger.completeDelivery(CI_REPAIR_SOURCE, repairKey);
      } else if (ledger) ledger.abandonDelivery(CI_REPAIR_SOURCE, repairKey);
    }
  }
}

/** Dedupe ledger source for webhook CI repairs, keyed by {@link ciRepairKey}. */
export const CI_REPAIR_SOURCE = "gitlab:ci-repair";

/** One CI repair per MR, head SHA, and set of distinct failed job/status names. */
export function ciRepairKey(
  serializationKey: string,
  headSha: string,
  failures: ReadonlyArray<{ name: string }>,
): string {
  const names = [...new Set(failures.map((failure) => failure.name))].sort();
  return `${serializationKey}@${headSha}:${JSON.stringify(names)}`;
}

/** Ledger key recording that a completed repair for `baseKey` covered `jobId`. */
function ciRepairJobKey(baseKey: string, jobId: number): string {
  return `${baseKey}#job:${jobId}`;
}

function failedJobIds(failures: ReadonlyArray<GitLabCiFailure>): number[] {
  return [
    ...new Set(failures.flatMap((failure) => (failure.jobId === undefined ? [] : [failure.jobId]))),
  ].sort((a, b) => a - b);
}

/**
 * Whether a job was retried and failed again since the last completed repair
 * for these failure names. The snapshot excludes retried jobs, so a retry
 * replaces the covered job id with a new one: some failing name then has no
 * job a completed repair covered. The other pipeline's copy of a failure
 * leaves the covered job in place, so it does not count. Commit statuses
 * carry no job id and never count as retried.
 */
function hasRetriedFailure(
  ledger: { hasProcessed(source: string, externalId: string): boolean },
  baseKey: string,
  failures: ReadonlyArray<GitLabCiFailure>,
): boolean {
  const jobsByName = new Map<string, number[]>();
  for (const failure of failures) {
    if (failure.jobId === undefined) continue;
    jobsByName.set(failure.name, [...(jobsByName.get(failure.name) ?? []), failure.jobId]);
  }
  return [...jobsByName.values()].some((jobIds) =>
    jobIds.every((jobId) => !ledger.hasProcessed(CI_REPAIR_SOURCE, ciRepairJobKey(baseKey, jobId))),
  );
}

async function runGitLabCiRepair(
  client: GitLabReviewsClient,
  target: AgentPr,
  serializationKey: string,
  head: { sha: string; ref: string },
  snapshot: GitLabCiSnapshot,
): Promise<void> {
  const rawLogs = await client.getJobTraces(target.projectPath, snapshot.jobIds);
  const { truncateCiLogs } = await import("../acquirers/ci-failure-watcher");
  const feedbackDir = mkdtempSync(join(tmpdir(), "devintern-gitlab-webhook-ci-"));
  const feedbackPath = join(feedbackDir, "ci-feedback.json");
  writeFileSync(
    feedbackPath,
    JSON.stringify({
      repository: target.projectPath,
      prNumber: target.changeNumber,
      branch: head.ref,
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
      expectedHeadSha: head.sha,
    });
    if (ok === "deferred") throw new UsageLimitError();
    if (!ok) throw new Error("GitLab CI repair did not complete");
  } finally {
    rmSync(feedbackDir, { recursive: true, force: true });
  }
}
