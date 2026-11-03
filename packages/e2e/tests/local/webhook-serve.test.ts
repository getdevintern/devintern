import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { cliPath } from "../../helpers/fixture-workspace";
import { command } from "../../helpers/process";
import { WebhookServerFixture, freePort } from "../../helpers/webhook-server";

interface WebhookResponse {
  success?: boolean;
  message?: string;
  error?: string;
  eventId?: string;
  deliveryId?: string;
  service?: string;
  endpoints?: Record<string, string>;
}

interface QueueRow {
  id: string;
  event_type: string;
  status: string;
}

interface ProcessedRow {
  source: string;
  external_id: string;
}

function queueRows(dbPath: string): QueueRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT id, event_type, status FROM webhook_events ORDER BY created_at")
      .all() as QueueRow[];
  } finally {
    db.close();
  }
}

function processedRows(dbPath: string): ProcessedRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT source, external_id FROM processed_events").all() as ProcessedRow[];
  } finally {
    db.close();
  }
}

function signGithub(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function githubHeaders(
  event: string,
  options: { deliveryId?: string; signature?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
  };
  if (options.deliveryId) headers["x-github-delivery"] = options.deliveryId;
  if (options.signature !== undefined) headers["x-hub-signature-256"] = options.signature;
  return headers;
}

function gitlabHeaders(
  event: string,
  options: { token?: string; webhookId?: string; timestamp?: string; signature?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-gitlab-event": event,
  };
  if (options.token !== undefined) headers["x-gitlab-token"] = options.token;
  if (options.webhookId) headers["webhook-id"] = options.webhookId;
  if (options.timestamp) headers["webhook-timestamp"] = options.timestamp;
  if (options.signature) headers["webhook-signature"] = options.signature;
  return headers;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ response: Response; payload: WebhookResponse }> {
  const response = await fetch(url, { method: "POST", headers, body });
  return { response, payload: (await response.json()) as WebhookResponse };
}

function reviewPayload(
  options: {
    state?: "changes_requested" | "approved";
    reviewerType?: "User" | "Bot";
    prState?: "open" | "closed";
  } = {},
) {
  return {
    action: "submitted",
    review: {
      id: 9001,
      user: { login: "reviewer", id: 2, type: options.reviewerType ?? "User" },
      body: "Please fix these issues",
      state: options.state ?? "changes_requested",
      commit_id: "abc123",
      submitted_at: "2026-01-01T00:00:00Z",
      html_url: "https://github.com/acme/widgets/pull/17#pullrequestreview-9001",
    },
    pull_request: {
      number: 17,
      title: "Exercise webhook serve",
      body: null,
      state: options.prState ?? "open",
      html_url: "https://github.com/acme/widgets/pull/17",
      user: { login: "author", id: 3, type: "User" },
      head: { ref: "feature/webhook", sha: "abc123" },
      base: { ref: "main", sha: "def456" },
    },
    repository: {
      id: 42,
      name: "widgets",
      full_name: "acme/widgets",
      private: false,
      owner: { login: "acme", id: 1, type: "Organization" },
      html_url: "https://github.com/acme/widgets",
      default_branch: "main",
    },
    sender: { login: "reviewer", id: 2, type: "User" },
  };
}

function ignoredGitlabPayload(iid: number) {
  // The handler recognizes only Note, Merge Request, Pipeline, and Job hooks;
  // an unsupported "Push Hook" is rejected as 400. Use a supported Merge
  // Request Hook in a non-actionable state as the ignored-event case.
  return {
    object_kind: "merge_request",
    project: { id: 42, path_with_namespace: "acme/widgets" },
    object_attributes: {
      iid,
      state: "opened",
      detailed_merge_status: "checking",
      source_branch: `feature/webhook-${iid}`,
    },
  };
}

const builtCli = existsSync(cliPath);

test.skipIf(!builtCli)(
  "webhook serve exits non-zero before listening when no provider secret is configured",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-webhook-preflight-"));
    try {
      const env = isolatedEnvironment(root);
      const port = await freePort();
      const result = await command(
        [
          process.execPath,
          cliPath,
          "webhook",
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        root,
        env,
        20_000,
      );
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "WEBHOOK_SECRET, GITLAB_WEBHOOK_SECRET, or GITLAB_WEBHOOK_SIGNING_TOKEN is required",
      );
      expect(result.stdout).not.toContain("Server listening on");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

const githubSecret = randomBytes(32).toString("hex");
const gitlabSecret = randomBytes(32).toString("hex");
const signingToken = `whsec_${randomBytes(32).toString("base64")}`;

describe.skipIf(!builtCli)("devintern webhook serve", () => {
  let server: WebhookServerFixture;

  beforeAll(async () => {
    server = await WebhookServerFixture.start({
      webhookSecret: githubSecret,
      gitlabWebhookSecret: gitlabSecret,
      gitlabWebhookSigningToken: signingToken,
      // Keep accepted GitHub deliveries in flight: the review pipeline must not
      // contact a real provider, and the duplicate branch must be deterministic.
      pauseReviewQueue: true,
    });
  }, 60_000);

  afterAll(async () => {
    await server?.dispose();
  });

  test("health reports queue and failover state and root documents the endpoints", async () => {
    const healthResponse = await fetch(`${server.baseUrl}/health`);
    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as {
      status?: string;
      queue?: { pending?: unknown; processing?: unknown; failed?: unknown };
      harness?: { active?: unknown; chain?: unknown; rateLimitedUntil?: unknown };
    };
    expect(health.status).toBe("ok");
    expect(typeof health.queue?.pending).toBe("number");
    expect(typeof health.queue?.processing).toBe("number");
    expect(typeof health.queue?.failed).toBe("number");
    expect(typeof health.harness?.active).toBe("string");
    expect(typeof health.harness?.chain).toBe("string");
    expect(health.harness?.rateLimitedUntil).toBeTypeOf("object");

    const root = (await (await fetch(`${server.baseUrl}/`)).json()) as WebhookResponse;
    expect(root.service).toContain("Webhook Server");
    expect(root.endpoints?.githubWebhook).toBe("POST /webhooks/github");
    expect(root.endpoints?.gitlabWebhook).toBe("POST /webhooks/gitlab");
    expect(root.endpoints?.health).toBe("GET /health");
  });

  test("GitHub HMAC validation accepts ping and rejects missing, wrong, unsupported and tampered deliveries", async () => {
    const pingBody = JSON.stringify({
      zen: "Keep it logically awesome.",
      hook_id: 42,
      hook: { events: ["pull_request_review"] },
    });
    const validPing = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("ping", { signature: signGithub(pingBody, githubSecret) }),
      pingBody,
    );
    expect(validPing.response.status).toBe(200);
    expect(validPing.payload.success).toBe(true);
    expect(validPing.payload.message).toContain("Webhook configured successfully");

    const rowsBefore = queueRows(server.queueDbPath).length;

    const missingSignature = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("ping"),
      pingBody,
    );
    expect(missingSignature.response.status).toBe(401);

    const wrongSignature = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("ping", { signature: `sha256=${"0".repeat(64)}` }),
      pingBody,
    );
    expect(wrongSignature.response.status).toBe(401);

    const unsupportedEvent = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("push", { signature: signGithub("{}", githubSecret) }),
      "{}",
    );
    expect(unsupportedEvent.response.status).toBe(400);

    // Exact raw-body signing: whitespace and the trailing newline are part of
    // the payload. The same signature must fail once one byte changes.
    const exactBody =
      '{ "zen": "Keep it logically awesome.", "hook_id": 42, "hook": { "events": ["pull_request_review"] } }\n';
    const exactSignature = signGithub(exactBody, githubSecret);
    const exact = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("ping", { signature: exactSignature }),
      exactBody,
    );
    expect(exact.response.status).toBe(200);

    const tamperedBody = exactBody.replace("awesome", "awesomf");
    expect(tamperedBody).not.toBe(exactBody);
    const tampered = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("ping", { signature: exactSignature }),
      tamperedBody,
    );
    expect(tampered.response.status).toBe(401);

    expect(queueRows(server.queueDbPath).length).toBe(rowsBefore);
  });

  test("GitHub review delivery persists a queue row and dedupes the same delivery id", async () => {
    const body = JSON.stringify(reviewPayload());
    const deliveryId = randomUUID();
    const headers = githubHeaders("pull_request_review", {
      deliveryId,
      signature: signGithub(body, githubSecret),
    });

    const first = await postJson(`${server.baseUrl}/webhooks/github`, headers, body);
    expect(first.response.status).toBe(200);
    expect(first.payload.success).toBe(true);
    const eventId = first.payload.eventId;
    if (!eventId) throw new Error("review delivery did not return an eventId");
    expect(queueRows(server.queueDbPath).filter((row) => row.id === eventId)).toHaveLength(1);

    const rowsBeforeDuplicate = queueRows(server.queueDbPath).length;
    const duplicate = await postJson(`${server.baseUrl}/webhooks/github`, headers, body);
    if (duplicate.response.status === 200) {
      expect(duplicate.payload.message).toBe("Duplicate delivery");
    } else {
      expect(duplicate.response.status).toBe(409);
      expect(duplicate.payload.message).toBe("Delivery already in progress");
    }
    expect(queueRows(server.queueDbPath).length).toBe(rowsBeforeDuplicate);
    expect(
      queueRows(server.queueDbPath).filter((row) => row.event_type === "pull_request_review"),
    ).toHaveLength(1);
  });

  test("GitHub bot review is skipped without a queue row", async () => {
    const body = JSON.stringify(reviewPayload({ reviewerType: "Bot" }));
    const deliveryId = randomUUID();
    const rowsBefore = queueRows(server.queueDbPath).length;

    const response = await postJson(
      `${server.baseUrl}/webhooks/github`,
      githubHeaders("pull_request_review", {
        deliveryId,
        signature: signGithub(body, githubSecret),
      }),
      body,
    );
    expect(response.response.status).toBe(200);
    expect(response.payload.success).toBe(true);
    expect(response.payload.message).toBe("Review does not require processing");
    expect(queueRows(server.queueDbPath).length).toBe(rowsBefore);
  });

  test("GitLab token validation accepts an ignored event and dedupes a replay", async () => {
    const body = JSON.stringify(ignoredGitlabPayload(71));
    const headers = gitlabHeaders("Merge Request Hook", { token: gitlabSecret });
    const rowsBefore = queueRows(server.queueDbPath).length;
    const processedBefore = processedRows(server.queueDbPath).length;

    const first = await postJson(`${server.baseUrl}/webhooks/gitlab`, headers, body);
    expect(first.response.status).toBe(200);
    expect(first.payload.message).toBe("GitLab event does not require processing");
    expect(queueRows(server.queueDbPath).length).toBe(rowsBefore);
    expect(processedRows(server.queueDbPath).length).toBe(processedBefore + 1);

    const replay = await postJson(`${server.baseUrl}/webhooks/gitlab`, headers, body);
    expect(replay.response.status).toBe(200);
    expect(replay.payload.message).toBe("Duplicate delivery");
    expect(queueRows(server.queueDbPath).length).toBe(rowsBefore);
    expect(processedRows(server.queueDbPath).length).toBe(processedBefore + 1);

    const wrongToken = await postJson(
      `${server.baseUrl}/webhooks/gitlab`,
      gitlabHeaders("Merge Request Hook", { token: randomBytes(32).toString("hex") }),
      body,
    );
    expect(wrongToken.response.status).toBe(401);

    const missingToken = await postJson(
      `${server.baseUrl}/webhooks/gitlab`,
      gitlabHeaders("Merge Request Hook"),
      body,
    );
    expect(missingToken.response.status).toBe(401);
  });

  test("GitLab Standard Webhooks signature accepts the canonical body and rejects tampering", async () => {
    const body = JSON.stringify(ignoredGitlabPayload(72));
    const webhookId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Matches verifyGitLabWebhookSignature: the whsec_ suffix is base64, and
    // the canonical string is `${webhookId}.${timestamp}.${rawBody}`.
    const secret = Buffer.from(signingToken.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", secret)
      .update(`${webhookId}.${timestamp}.${body}`)
      .digest("base64");
    const headers = gitlabHeaders("Merge Request Hook", {
      webhookId,
      timestamp,
      signature: `v1,${signature}`,
    });
    const rowsBefore = queueRows(server.queueDbPath).length;

    const valid = await postJson(`${server.baseUrl}/webhooks/gitlab`, headers, body);
    expect(valid.response.status).toBe(200);
    expect(valid.payload.message).toBe("GitLab event does not require processing");

    const tamperedBody = `${body} `;
    const tampered = await postJson(`${server.baseUrl}/webhooks/gitlab`, headers, tamperedBody);
    expect(tampered.response.status).toBe(401);
    expect(queueRows(server.queueDbPath).length).toBe(rowsBefore);
  });

  test("GitLab route returns 503 when only the GitHub secret is configured", async () => {
    const githubOnly = await WebhookServerFixture.start({
      webhookSecret: randomBytes(32).toString("hex"),
    });
    try {
      const body = JSON.stringify(ignoredGitlabPayload(73));
      const response = await postJson(
        `${githubOnly.baseUrl}/webhooks/gitlab`,
        gitlabHeaders("Merge Request Hook", { token: randomBytes(32).toString("hex") }),
        body,
      );
      expect(response.response.status).toBe(503);
      expect(response.payload.error).toBe("GitLab webhooks are not configured");
    } finally {
      await githubOnly.dispose();
    }
  }, 60_000);
});
