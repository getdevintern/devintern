/** GitLab direct-webhook authentication and provider-native event normalization. */

import { createHash, createHmac, timingSafeEqual } from "crypto";

import { normalizeCodeHostUrl } from "../index";

export type GitLabWebhookKind = "feedback" | "lifecycle" | "sync" | "ci" | "ignored";

export interface GitLabWebhookEvent {
  kind: GitLabWebhookKind;
  eventName: string;
  projectId?: string;
  projectPath?: string;
  iid?: number;
  branch?: string;
  headSha?: string;
  state?: string;
  failure?: {
    externalId: string;
    name: string;
    conclusion: string;
    detailsUrl?: string;
  };
  payload: Record<string, unknown>;
}

export interface RegisteredGitLabChange {
  provider: string;
  instanceUrl: string;
  projectId?: string;
  projectPath: string;
  changeNumber: number;
  branch?: string;
}

/** Compare GitLab's opaque secret-token header without leaking prefix timing. */
export function verifyGitLabWebhookToken(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Verify a GitLab Standard Webhooks HMAC signature and reject stale deliveries. */
export function verifyGitLabWebhookSignature(
  signatureHeader: string | null,
  webhookId: string | null,
  timestamp: string | null,
  rawBody: string,
  signingToken: string,
  options: { nowMs?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!signatureHeader || !webhookId || !timestamp || !signingToken.startsWith("whsec_")) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;

  const secret = Buffer.from(signingToken.slice("whsec_".length), "base64");
  if (secret.length === 0) return false;
  const expected = createHmac("sha256", secret)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest();

  return signatureHeader.split(/\s+/).some((entry) => {
    const [version, encoded, ...extra] = entry.split(",");
    if (version !== "v1" || !encoded || extra.length > 0) return false;
    const actual = Buffer.from(encoded, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** Prefer delivery-scoped identifiers, with a deterministic body hash as a fallback. */
export function gitLabWebhookDeliveryId(
  headers: Headers,
  rawBody: string,
  eventName: string,
): string {
  const webhookId = headers.get("webhook-id");
  if (webhookId) return `webhook-id:${webhookId}`;
  const idempotencyKey = headers.get("idempotency-key");
  if (idempotencyKey) return `idempotency-key:${idempotencyKey}`;

  const bodyHash = createHash("sha256")
    .update(eventName)
    .update("\0")
    .update(rawBody)
    .digest("hex");
  const eventUuid = headers.get("x-gitlab-event-uuid");
  return eventUuid ? `event-uuid:${eventUuid}:${bodyHash}` : `body:${bodyHash}`;
}

/** Scope a normalized delivery to a registered MR on the exact provider instance and project. */
export function matchesRegisteredGitLabChange(
  event: GitLabWebhookEvent,
  change: RegisteredGitLabChange,
  instanceUrl: string,
): boolean {
  if (change.provider !== "gitlab") return false;
  if (!event.projectId && !event.projectPath) return false;
  if (!event.iid && !event.branch) return false;
  if (normalizeCodeHostUrl(change.instanceUrl) !== normalizeCodeHostUrl(instanceUrl)) return false;
  if (event.projectId && change.projectId && event.projectId !== change.projectId) {
    return false;
  }
  if ((!event.projectId || !change.projectId) && event.projectPath !== change.projectPath) {
    return false;
  }
  if (event.iid && event.iid !== change.changeNumber) return false;
  return !event.branch || event.branch === change.branch;
}

/** Normalize the GitLab events supported by the repo-local webhook server. */
export function normalizeGitLabWebhook(
  eventName: string | null,
  payload: Record<string, unknown>,
): GitLabWebhookEvent | null {
  if (!eventName) return null;
  const base = buildGitLabWebhookBase(eventName, payload);

  if (eventName === "Note Hook") {
    return normalizeNoteHook(base, payload);
  }
  if (eventName === "Merge Request Hook") {
    return normalizeMergeRequestHook(base, payload);
  }
  if (eventName === "Pipeline Hook") {
    return normalizePipelineHook(base, payload);
  }
  if (eventName === "Job Hook") {
    return normalizeJobHook(base, payload);
  }
  return null;
}

type GitLabWebhookBase = Omit<GitLabWebhookEvent, "kind" | "state" | "failure" | "payload">;

function buildGitLabWebhookBase(
  eventName: string,
  payload: Record<string, unknown>,
): GitLabWebhookBase {
  const project = object(payload.project);
  const attributes = object(payload.object_attributes);
  const mergeRequest = object(payload.merge_request);
  const projectId = number(project.id) ?? number(payload.project_id);
  const projectPath = string(project.path_with_namespace) ?? string(payload.project_name);
  const iid =
    number(attributes.iid) ??
    number(attributes.noteable_iid) ??
    number(mergeRequest.iid) ??
    number(payload.merge_request_iid);
  const branch =
    string(attributes.source_branch) ??
    string(attributes.ref) ??
    string(payload.ref) ??
    string(payload.build_ref);
  const headSha =
    string(object(attributes.last_commit).id) ??
    string(attributes.sha) ??
    string(payload.sha) ??
    string(payload.build_sha);
  return { eventName, projectId: projectId?.toString(), projectPath, iid, branch, headSha };
}

function normalizeNoteHook(
  base: GitLabWebhookBase,
  payload: Record<string, unknown>,
): GitLabWebhookEvent {
  const noteableType = string(object(payload.object_attributes).noteable_type);
  if (noteableType !== "MergeRequest" || !base.iid) {
    return { ...base, kind: "ignored", payload };
  }
  return { ...base, kind: "feedback", payload };
}

function normalizeMergeRequestHook(
  base: GitLabWebhookBase,
  payload: Record<string, unknown>,
): GitLabWebhookEvent {
  const attributes = object(payload.object_attributes);
  const state = string(attributes.state) ?? string(attributes.action);
  if (state === "closed" || state === "merged" || state === "merge") {
    return { ...base, kind: "lifecycle", state, payload };
  }
  const mergeability = string(attributes.detailed_merge_status) ?? string(attributes.merge_status);
  if (mergeability === "conflict" || mergeability === "cannot_be_merged") {
    return { ...base, kind: "sync", state: "conflicts", payload };
  }
  if (mergeability === "need_rebase") {
    return { ...base, kind: "sync", state: "behind", payload };
  }
  return { ...base, kind: "ignored", state, payload };
}

function normalizePipelineHook(
  base: GitLabWebhookBase,
  payload: Record<string, unknown>,
): GitLabWebhookEvent {
  const attributes = object(payload.object_attributes);
  const status = string(attributes.status);
  if (status !== "failed") return { ...base, kind: "ignored", state: status, payload };
  const id = number(attributes.id);
  return {
    ...base,
    kind: "ci",
    state: status,
    failure: {
      externalId: `pipeline:${base.projectId ?? "unknown"}:${base.headSha ?? "unknown"}:${id ?? "unknown"}`,
      name: string(attributes.name) ?? `pipeline-${id ?? "unknown"}`,
      conclusion: status,
      detailsUrl: string(attributes.url),
    },
    payload,
  };
}

function normalizeJobHook(
  base: GitLabWebhookBase,
  payload: Record<string, unknown>,
): GitLabWebhookEvent {
  const status = string(payload.build_status);
  if (status !== "failed" || payload.build_allow_failure === true) {
    return { ...base, kind: "ignored", state: status, payload };
  }
  const id = number(payload.build_id);
  return {
    ...base,
    kind: "ci",
    state: status,
    failure: {
      externalId: `job:${base.projectId ?? "unknown"}:${base.headSha ?? "unknown"}:${id ?? "unknown"}`,
      name: string(payload.build_name) ?? `job-${id ?? "unknown"}`,
      conclusion: status,
    },
    payload,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
