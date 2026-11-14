import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDashboardServer } from "../src/dashboard-server";
import { DashboardData } from "../src/lib/observability/dashboard-api";
import {
  DashboardReports,
  parseReportPreviewRequest,
  parseReportSubmitRequest,
} from "../src/lib/observability/dashboard-report";
import type {
  DashboardReportDeps,
  ReportPreviewResponse,
} from "../src/lib/observability/dashboard-report";
import type { ReportIdentity } from "../src/lib/report/session";
import { RunStore } from "../src/lib/state/run-recorder";

interface Captured {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

let dir: string;
let dbPath: string;
let configDir: string;
let workspaceDir: string;
let data: DashboardData;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dashboard-report-"));
  dbPath = join(dir, "queue.db");
  configDir = join(dir, ".devintern-code");
  workspaceDir = join(dir, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  data = new DashboardData({ dbPath, workingDir: dir, workspaceDir, logDirs: [] });
});

afterEach(() => {
  data.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedFailedRun(taskKey = "PROJ-77"): number {
  const store = new RunStore(dbPath);
  const id = store.createRun({ origin: "task", taskKey, harness: "claude-code" });
  const stepStartedAt = store.startStep(id, "implement");
  store.completeStep(id, "implement", stepStartedAt);
  store.finishRun(id, "failed", `agent exited non-zero while working on ${taskKey}`);
  store.close();
  return id;
}

function harness(
  options: {
    identity?: ReportIdentity;
    respond?: (captured: Captured) => Response;
    now?: () => number;
  } = {},
): { reports: DashboardReports; requests: Captured[]; deps: DashboardReportDeps } {
  const requests: Captured[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const captured: Captured = {
      url,
      body: JSON.parse(String(init?.body ?? "null")),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    requests.push(captured);
    return (
      options.respond?.(captured) ??
      new Response(JSON.stringify({ id: "rep_1234567890abcdef", receipt: "rcpt-1" }), {
        status: 201,
      })
    );
  }) as typeof fetch;
  const deps: DashboardReportDeps = {
    configDir,
    endpoint: "https://reports.example.test/api/reports",
    cliVersion: "9.9.9",
    fetchImpl,
    resolveIdentity: async () => options.identity ?? { signedIn: false },
    ...(options.now ? { now: options.now } : {}),
  };
  return { reports: new DashboardReports(data, deps), requests, deps };
}

const DRAFT = {
  title: "Worker marks run failed after PR opened",
  description: "Expected success; the PR was opened but the run shows failed.",
};

describe("request parsing", () => {
  test("preview requires a title and description", () => {
    expect(parseReportPreviewRequest(null).ok).toBe(false);
    expect(parseReportPreviewRequest({ title: " ", description: "x" }).ok).toBe(false);
    expect(parseReportPreviewRequest({ title: "t" }).ok).toBe(false);
    expect(parseReportPreviewRequest({ ...DRAFT, shareIdentifiers: "yes" }).ok).toBe(false);
    expect(parseReportPreviewRequest(DRAFT)).toEqual({
      ok: true,
      value: { ...DRAFT, shareIdentifiers: false },
    });
  });

  test("submit requires a preview id", () => {
    expect(parseReportSubmitRequest({}).ok).toBe(false);
    expect(parseReportSubmitRequest({ previewId: "p", email: 4 }).ok).toBe(false);
    expect(parseReportSubmitRequest({ previewId: "p", email: " a@b.co " })).toEqual({
      ok: true,
      value: { previewId: "p", email: "a@b.co" },
    });
  });
});

describe("report preview", () => {
  test("builds the redacted payload for the run and summarizes it", async () => {
    const runId = seedFailedRun();
    const { reports, requests } = harness();

    const response = await reports.preview(String(runId), DRAFT);
    expect(response.status).toBe(200);
    const body = response.body as ReportPreviewResponse;

    expect(body.previewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.runId).toBe(runId);
    expect(body.signedIn).toBe(false);
    expect(body.contactRequired).toBe(true);
    expect(body.destination).toBe("https://reports.example.test/api/reports");
    expect(body.title).toBe(DRAFT.title);
    expect(body.attachments.environment.cliVersion).toBe("9.9.9");
    expect(body.attachments.run).toMatchObject({ id: runId, status: "failed", hasReason: true });
    expect(body.attachments.identifiersShared).toBe(false);
    expect(body.omitted).toContain("credentials");
    expect(body.omitted).toContain("task key and repository slug");

    // Same collection as `--run <id>`: the run summary comes from the
    // dashboard's database and the task key is redacted by default.
    expect(body.payload.context?.run?.id).toBe(runId);
    expect(body.payload.context?.run?.taskKey).toBeUndefined();
    expect(body.payload.context?.run?.reason).not.toContain("PROJ-77");
    expect(body.payload.contact).toBeUndefined();
    // Nothing is sent until the user submits.
    expect(requests).toHaveLength(0);
  });

  test("shareIdentifiers keeps the task key", async () => {
    const runId = seedFailedRun();
    const { reports } = harness();
    const body = (await reports.preview(String(runId), { ...DRAFT, shareIdentifiers: true }))
      .body as ReportPreviewResponse;
    expect(body.payload.context?.run?.taskKey).toBe("PROJ-77");
    expect(body.attachments.identifiersShared).toBe(true);
    expect(body.omitted).not.toContain("task key and repository slug");
  });

  test("rejects bad ids, unknown runs, and invalid bodies", async () => {
    seedFailedRun();
    const { reports } = harness();
    expect((await reports.preview("abc", DRAFT)).status).toBe(400);
    expect((await reports.preview("0", DRAFT)).status).toBe(400);
    expect((await reports.preview("999", DRAFT)).status).toBe(404);
    expect((await reports.preview("1", { title: "only a title" })).status).toBe(400);
    expect((await reports.preview("1", undefined)).status).toBe(400);
  });
});

describe("report submission", () => {
  test("submits exactly the previewed payload plus the typed contact", async () => {
    const runId = seedFailedRun();
    const { reports, requests } = harness();
    const preview = (await reports.preview(String(runId), DRAFT)).body as ReportPreviewResponse;

    const response = await reports.submit({
      previewId: preview.previewId,
      email: "dev@example.com",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "sent",
      reportId: "rep_1234567890abcdef",
      shortId: "rep_1234",
      receipt: "rcpt-1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({
      ...preview.payload,
      contact: { email: "dev@example.com", signedIn: false },
    });

    // Previews are single-use once sent.
    expect((await reports.submit({ previewId: preview.previewId, email: "a@b.co" })).status).toBe(
      404,
    );
  });

  test("signed-in users submit without an email and forward the token", async () => {
    const runId = seedFailedRun();
    const { reports, requests } = harness({
      identity: { signedIn: true, accessToken: "token-abc", email: "me@example.com" },
    });
    const preview = (await reports.preview(String(runId), DRAFT)).body as ReportPreviewResponse;
    expect(preview.signedIn).toBe(true);
    expect(preview.contactRequired).toBe(false);

    const response = await reports.submit({ previewId: preview.previewId });
    expect(response.status).toBe(200);
    expect(requests[0]!.body).toEqual(preview.payload);
    expect(requests[0]!.headers.authorization).toBe("Bearer token-abc");
  });

  test("anonymous submissions without a valid email are rejected", async () => {
    const runId = seedFailedRun();
    const { reports, requests } = harness();
    const preview = (await reports.preview(String(runId), DRAFT)).body as ReportPreviewResponse;

    expect((await reports.submit({ previewId: preview.previewId })).status).toBe(400);
    expect(
      (await reports.submit({ previewId: preview.previewId, email: "not-an-email" })).status,
    ).toBe(400);
    expect(requests).toHaveLength(0);
  });

  test("unknown and expired preview ids are rejected", async () => {
    const runId = seedFailedRun();
    let now = 1_000_000;
    const { reports, requests } = harness({ now: () => now });
    expect((await reports.submit({ previewId: "nope", email: "a@b.co" })).status).toBe(404);

    const preview = (await reports.preview(String(runId), DRAFT)).body as ReportPreviewResponse;
    now += 16 * 60 * 1000;
    expect((await reports.submit({ previewId: preview.previewId, email: "a@b.co" })).status).toBe(
      404,
    );
    expect(requests).toHaveLength(0);
  });

  test("a failed send saves the payload locally with a --from retry hint", async () => {
    const runId = seedFailedRun();
    const { reports } = harness({
      respond: () => new Response(JSON.stringify({ error: "maintenance" }), { status: 503 }),
    });
    const preview = (await reports.preview(String(runId), DRAFT)).body as ReportPreviewResponse;

    const response = await reports.submit({ previewId: preview.previewId, email: "a@b.co" });
    expect(response.status).toBe(502);
    const body = response.body as {
      status: string;
      error: string;
      savedPath: string;
      retryCommand: string;
      authExpired: boolean;
    };
    expect(body.status).toBe("saved");
    expect(body.error).toContain("maintenance");
    expect(body.authExpired).toBe(false);
    expect(body.savedPath.startsWith(join(configDir, "reports"))).toBe(true);
    expect(body.retryCommand).toBe(`devintern report --from ${body.savedPath}`);
    expect(existsSync(body.savedPath)).toBe(true);
    const saved = JSON.parse(readFileSync(body.savedPath, "utf8")) as {
      status: string;
      error?: string;
      payload: { reportId: string };
    };
    expect(saved.status).toBe("pending");
    expect(saved.error).toContain("maintenance");
    expect(saved.payload.reportId).toBe(preview.payload.reportId);

    // The preview survives a failed send so the dialog can try again.
    const retried = await reports.submit({ previewId: preview.previewId, email: "a@b.co" });
    expect(retried.status).toBe(502);
    expect((retried.body as { savedPath: string }).savedPath).toBe(body.savedPath);
  });

  test("an expired sign-in is flagged", async () => {
    const runId = seedFailedRun();
    const { reports } = harness({
      identity: { signedIn: true, accessToken: "stale" },
      respond: () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401 }),
    });
    const preview = (await reports.preview(String(runId), DRAFT)).body as ReportPreviewResponse;
    const response = await reports.submit({ previewId: preview.previewId });
    expect((response.body as { authExpired: boolean }).authExpired).toBe(true);
  });
});

describe("dashboard server routes", () => {
  function startServer(deps: DashboardReportDeps) {
    return startDashboardServer({
      port: 0,
      dbPath,
      workingDir: dir,
      workspaceDir,
      logDirs: [],
      reportDeps: deps,
    });
  }

  /** Same-origin write headers, as the dashboard page sends them. */
  function writeHeaders(base: string): Record<string, string> {
    return { "Content-Type": "application/json", Origin: new URL(base).origin };
  }

  test("preview and submit are served as JSON POSTs", async () => {
    const runId = seedFailedRun();
    const { deps, requests } = harness();
    const server = startServer(deps);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const previewResponse = await fetch(`${base}/api/runs/${runId}/report/preview`, {
        method: "POST",
        headers: writeHeaders(base),
        body: JSON.stringify(DRAFT),
      });
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as ReportPreviewResponse;

      const malformed = await fetch(`${base}/api/reports`, {
        method: "POST",
        headers: writeHeaders(base),
        body: "{not json",
      });
      expect(malformed.status).toBe(400);

      const submit = await fetch(`${base}/api/reports`, {
        method: "POST",
        headers: writeHeaders(base),
        body: JSON.stringify({ previewId: preview.previewId, email: "dev@example.com" }),
      });
      expect(submit.status).toBe(200);
      expect(requests).toHaveLength(1);

      // POST-only, like the other action routes.
      expect((await fetch(`${base}/api/reports`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("cross-origin report requests are refused before reaching the handlers", async () => {
    const runId = seedFailedRun();
    const { deps, requests } = harness();
    const server = startServer(deps);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const crossOrigin = { "Content-Type": "application/json", Origin: "https://evil.example" };
      const previewResponse = await fetch(`${base}/api/runs/${runId}/report/preview`, {
        method: "POST",
        headers: crossOrigin,
        body: JSON.stringify(DRAFT),
      });
      expect(previewResponse.status).toBe(403);

      // Even with a valid preview id, a cross-origin submit never sends.
      const valid = (await (
        await fetch(`${base}/api/runs/${runId}/report/preview`, {
          method: "POST",
          headers: writeHeaders(base),
          body: JSON.stringify(DRAFT),
        })
      ).json()) as ReportPreviewResponse;
      const submit = await fetch(`${base}/api/reports`, {
        method: "POST",
        headers: crossOrigin,
        body: JSON.stringify({ previewId: valid.previewId, email: "dev@example.com" }),
      });
      expect(submit.status).toBe(403);
      expect(requests).toHaveLength(0);
    } finally {
      server.stop();
    }
  });
});
