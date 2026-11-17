import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitHubReviewsClient } from "../src/lib/code-host/github/reviews";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { processReviewWithPersistence } from "../src/lib/webhook/review-pipeline";
import { runtime } from "../src/lib/webhook/runtime";
import type { PullRequestReviewEvent, WebhookServerConfig } from "../src/types/github-webhooks";

/**
 * The webhook review pipeline must not treat a GitHub API error during the
 * push-access check as a denial: a transient error leaves the event pending
 * for retry, while a confirmed denial is acknowledged.
 */
describe("webhook review permission gate", () => {
  let dir: string;
  let queue: WebhookQueue;
  const spies: { mockRestore: () => void }[] = [];
  const config = {
    port: 0,
    host: "127.0.0.1",
    webhookSecret: "s",
    autoReview: false,
    autoReviewMaxIterations: 0,
    validateIp: false,
    debug: false,
  } as WebhookServerConfig;

  const event = {
    action: "submitted",
    review: {
      id: 1,
      body: "@devintern please fix",
      state: "changes_requested",
      user: { login: "dev", type: "User" },
    },
    pull_request: {
      number: 7,
      state: "open",
      html_url: "https://github.com/acme/widgets/pull/7",
      head: { ref: "feature/x" },
    },
    repository: { full_name: "acme/widgets" },
  } as unknown as PullRequestReviewEvent;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "review-perm-retry-"));
    queue = new WebhookQueue({ dbPath: join(dir, "queue.db"), maxRetries: 3 });
    runtime.queue = queue;
    spies.push(
      spyOn(GitHubReviewsClient.prototype, "getPullRequestReviewComments").mockResolvedValue([]),
      spyOn(GitHubReviewsClient.prototype, "getBotUsername").mockResolvedValue("devintern"),
    );
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    runtime.queue = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a 503 from the permission API leaves the event pending for retry", async () => {
    spies.push(
      spyOn(GitHubReviewsClient.prototype, "getCollaboratorPermission").mockRejectedValue(
        new Error("GitHub API error (503): Service Unavailable"),
      ),
    );
    const id = queue.enqueue("pull_request_review", event);

    await expect(processReviewWithPersistence(id, event, config)).rejects.toThrow("503");

    const stored = queue.getEvent(id);
    expect(stored?.status).toBe("pending");
    expect(stored?.lastError).toContain("503");
  });

  test("a confirmed read-only permission is acknowledged without retry", async () => {
    spies.push(
      spyOn(GitHubReviewsClient.prototype, "getCollaboratorPermission").mockResolvedValue({
        permission: "read",
      }),
    );
    const id = queue.enqueue("pull_request_review", event);

    await processReviewWithPersistence(id, event, config);

    expect(queue.getEvent(id)).toBeNull();
  });
});
