import { describe, expect, test } from "bun:test";

import {
  gitLabWebhookDeliveryId,
  matchesRegisteredGitLabChange,
  normalizeGitLabWebhook,
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

  test("prefers delivery UUIDs and otherwise hashes the event and body", () => {
    expect(
      gitLabWebhookDeliveryId(
        new Headers({ "x-gitlab-event-uuid": "delivery-1" }),
        "{}",
        "Note Hook",
      ),
    ).toBe("delivery-1");
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
