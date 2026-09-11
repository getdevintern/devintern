import { createHmac } from "crypto";

import { describe, expect, test } from "bun:test";

import {
  gitLabWebhookDeliveryId,
  matchesRegisteredGitLabChange,
  normalizeGitLabWebhook,
  verifyGitLabWebhookSignature,
  verifyGitLabWebhookToken,
} from "../src/lib/gitlab-webhook";

const project = { id: 42, path_with_namespace: "acme/widgets" };

describe("GitLab direct webhooks", () => {
  test("compares the configured opaque token exactly", () => {
    expect(verifyGitLabWebhookToken("correct horse", "correct horse")).toBe(true);
    expect(verifyGitLabWebhookToken("correct", "correct horse")).toBe(false);
    expect(verifyGitLabWebhookToken(null, "correct horse")).toBe(false);
    expect(verifyGitLabWebhookToken("correct horse", "")).toBe(false);
  });

  test("verifies current GitLab Standard Webhooks signatures", () => {
    const rawBody = '{"event":"note"}';
    const secret = Buffer.from("signing secret");
    const token = `whsec_${secret.toString("base64")}`;
    const webhookId = "delivery-1";
    const timestamp = "1788998400";
    const signature = createHmac("sha256", secret)
      .update(`${webhookId}.${timestamp}.${rawBody}`)
      .digest("base64");

    expect(
      verifyGitLabWebhookSignature(
        `v1,invalid v1,${signature}`,
        webhookId,
        timestamp,
        rawBody,
        token,
        { nowMs: 1_788_998_400_000 },
      ),
    ).toBe(true);
    expect(
      verifyGitLabWebhookSignature(`v1,${signature}`, webhookId, timestamp, `${rawBody} `, token, {
        nowMs: 1_788_998_400_000,
      }),
    ).toBe(false);
    expect(
      verifyGitLabWebhookSignature(`v1,${signature}`, webhookId, timestamp, rawBody, token, {
        nowMs: 1_788_998_701_000,
      }),
    ).toBe(false);
  });

  test("does not accept malformed Standard Webhooks signature inputs", () => {
    expect(verifyGitLabWebhookSignature(null, "delivery-1", "1", "{}", "whsec_YQ==")).toBe(false);
    expect(verifyGitLabWebhookSignature("v1,YQ==", null, "1", "{}", "whsec_YQ==")).toBe(false);
    expect(verifyGitLabWebhookSignature("v1,YQ==", "delivery-1", "nope", "{}", "whsec_YQ==")).toBe(
      false,
    );
    expect(verifyGitLabWebhookSignature("v1,YQ==", "delivery-1", "1", "{}", "legacy")).toBe(false);
  });

  test("prefers delivery-scoped ids and never treats the webhook UUID as a delivery", () => {
    expect(
      gitLabWebhookDeliveryId(
        new Headers({ "webhook-id": "delivery-1", "idempotency-key": "retry-1" }),
        "{}",
        "Note Hook",
      ),
    ).toBe("webhook-id:delivery-1");
    expect(
      gitLabWebhookDeliveryId(new Headers({ "idempotency-key": "retry-1" }), "{}", "Note Hook"),
    ).toBe("idempotency-key:retry-1");
    const eventId = gitLabWebhookDeliveryId(
      new Headers({
        "x-gitlab-event-uuid": "event-1",
        "x-gitlab-webhook-uuid": "configured-hook-not-delivery",
      }),
      "{}",
      "Note Hook",
    );
    expect(eventId).toStartWith("event-uuid:event-1:");
    const first = gitLabWebhookDeliveryId(new Headers(), '{"a":1}', "Note Hook");
    expect(first).toStartWith("body:");
    expect(gitLabWebhookDeliveryId(new Headers(), '{"a":1}', "Note Hook")).toBe(first);
    expect(gitLabWebhookDeliveryId(new Headers(), '{"a":2}', "Note Hook")).not.toBe(first);
  });

  test("matches only the exact registered instance, project, MR, and branch", () => {
    const event = normalizeGitLabWebhook("Merge Request Hook", {
      project,
      object_attributes: {
        iid: 17,
        state: "opened",
        detailed_merge_status: "conflict",
        source_branch: "feature/a",
      },
    });
    expect(event).not.toBeNull();
    const registered = {
      provider: "gitlab",
      instanceUrl: "https://gitlab.example.com/",
      projectId: "42",
      projectPath: "acme/widgets",
      changeNumber: 17,
      branch: "feature/a",
    };
    expect(matchesRegisteredGitLabChange(event!, registered, "https://gitlab.example.com")).toBe(
      true,
    );
    expect(
      matchesRegisteredGitLabChange(
        event!,
        { ...registered, projectId: "43" },
        registered.instanceUrl,
      ),
    ).toBe(false);
    expect(
      matchesRegisteredGitLabChange(
        event!,
        { ...registered, changeNumber: 18 },
        registered.instanceUrl,
      ),
    ).toBe(false);
    expect(
      matchesRegisteredGitLabChange(
        event!,
        { ...registered, branch: "feature/b" },
        registered.instanceUrl,
      ),
    ).toBe(false);
    expect(matchesRegisteredGitLabChange(event!, registered, "https://gitlab.com")).toBe(false);
    expect(
      matchesRegisteredGitLabChange(
        { ...event!, projectId: undefined, projectPath: undefined },
        registered,
        registered.instanceUrl,
      ),
    ).toBe(false);
    expect(
      matchesRegisteredGitLabChange(
        { ...event!, iid: undefined, branch: undefined },
        registered,
        registered.instanceUrl,
      ),
    ).toBe(false);
  });

  test("routes MR notes to registered-feedback reconciliation", () => {
    const event = normalizeGitLabWebhook("Note Hook", {
      project,
      object_attributes: { noteable_type: "MergeRequest", noteable_iid: 17 },
    });
    expect(event).toMatchObject({
      kind: "feedback",
      projectId: "42",
      projectPath: "acme/widgets",
      iid: 17,
    });

    expect(
      normalizeGitLabWebhook("Note Hook", {
        project,
        object_attributes: { noteable_type: "Issue", noteable_iid: 17 },
      })?.kind,
    ).toBe("ignored");
  });

  test("routes lifecycle and only definitive mergeability states", () => {
    expect(
      normalizeGitLabWebhook("Merge Request Hook", {
        project,
        object_attributes: { iid: 17, state: "merged" },
      }),
    ).toMatchObject({ kind: "lifecycle", state: "merged", iid: 17 });
    expect(
      normalizeGitLabWebhook("Merge Request Hook", {
        project,
        object_attributes: { iid: 17, state: "opened", detailed_merge_status: "conflict" },
      }),
    ).toMatchObject({ kind: "sync", state: "conflicts" });
    expect(
      normalizeGitLabWebhook("Merge Request Hook", {
        project,
        object_attributes: { iid: 17, state: "opened", detailed_merge_status: "checking" },
      })?.kind,
    ).toBe("ignored");
  });

  test("routes failed pipelines and required jobs but ignores non-actionable CI", () => {
    expect(
      normalizeGitLabWebhook("Pipeline Hook", {
        project,
        object_attributes: { id: 80, status: "failed", ref: "feature/a", sha: "abc" },
      }),
    ).toMatchObject({
      kind: "ci",
      branch: "feature/a",
      headSha: "abc",
      failure: { externalId: "pipeline:42:abc:80" },
    });
    expect(
      normalizeGitLabWebhook("Job Hook", {
        project_id: 42,
        project_name: "acme/widgets",
        build_id: 90,
        build_name: "test",
        build_status: "failed",
        build_allow_failure: false,
        build_ref: "feature/a",
        build_sha: "abc",
      }),
    ).toMatchObject({ kind: "ci", failure: { externalId: "job:42:abc:90" } });
    expect(
      normalizeGitLabWebhook("Job Hook", {
        project_id: 42,
        build_status: "failed",
        build_allow_failure: true,
      })?.kind,
    ).toBe("ignored");
    expect(
      normalizeGitLabWebhook("Pipeline Hook", {
        project,
        object_attributes: { id: 81, status: "canceled" },
      })?.kind,
    ).toBe("ignored");
  });

  test("rejects unsupported event names", () => {
    expect(normalizeGitLabWebhook("Push Hook", { project })).toBeNull();
    expect(normalizeGitLabWebhook(null, { project })).toBeNull();
  });
});
