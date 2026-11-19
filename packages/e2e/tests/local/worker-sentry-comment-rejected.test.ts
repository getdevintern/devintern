import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dashboardBaseUrl, waitForDashboardHealth } from "../../helpers/dashboard";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerRunRecord } from "../../helpers/worker";
import { FakeSentryServer } from "../../providers/fake-sentry";
import type { FakeSentryIssue } from "../../providers/fake-sentry";

/**
 * Sentry rejecting the remediation comment (401/403 or 5xx) after the worker
 * already ran the fix. The comment is best-effort feedback: the worker must
 * stay up, keep the run record, keep the issue claimed so later polls do not
 * start another run, and never print the Sentry token anywhere a user or the
 * dashboard can see it.
 */

/** Mirrors `SENTRY_ACTION_SUCCEEDED_COMMENT` (duplicated on purpose; see `worker-sentry-monitor.test.ts`). */
const EXPECTED_SUCCESS_COMMENT =
  "🤖 DevIntern completed an automated remediation run for this issue. " +
  "The issue remains unresolved pending deployment and verification.";

/**
 * Upper bound on comment attempts per issue. The read path retries a 5xx at
 * most twice (three requests); a comment must never exceed that, and a tight
 * loop would blow far past it within the polls this test waits for.
 */
const MAX_COMMENT_ATTEMPTS_PER_ISSUE = 3;

function monitorConfig(baseUrl: string, maxPerTick: number): string {
  return [
    "[[error_monitors]]",
    'id = "sentry"',
    'provider = "sentry"',
    'repo = "fixture"',
    'organization = "e2e-org"',
    'project = "e2e-project"',
    `base_url = "${baseUrl}"`,
    "poll_interval = 1",
    "min_occurrences = 1",
    `max_per_tick = ${maxPerTick}`,
    "comment_on_action = true",
  ].join("\n");
}

function seededIssue(id: string): Partial<FakeSentryIssue> & { id: string } {
  return {
    id,
    shortId: `E2E-${id}`,
    title: `TypeError: cannot read properties of undefined (reading 'greeting') #${id}`,
    permalink: `https://sentry.invalid/organizations/e2e-org/issues/${id}/`,
  };
}

function errorMonitorRuns(worker: WorkerFixture): WorkerRunRecord[] {
  return worker.runRecords().filter((record) => record.origin === "error_monitor");
}

/** Both raw and URL-encoded forms, so neither can slip into an artifact unnoticed. */
function tokenForms(token: string): string[] {
  return [...new Set([token, encodeURIComponent(token)])];
}

/** Replace every token form so diagnostics can never print the credential. */
function redact(text: string, token: string): string {
  return tokenForms(token).reduce((out, form) => out.split(form).join("[REDACTED]"), text);
}

function expectNoToken(label: string, text: string, token: string): void {
  for (const form of tokenForms(token)) {
    // The boolean keeps a failing assertion from echoing the artifact (and token).
    expect(text.includes(form), `${label} contains the Sentry token`).toBe(false);
  }
}

/** Raw bytes of the worker's state database (and WAL), which holds the run records. */
function stateDatabaseText(worker: WorkerFixture): string {
  return [worker.dbPath, `${worker.dbPath}-wal`]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
}

interface Harness {
  worker: WorkerFixture;
  sentry: FakeSentryServer;
  token: string;
  baseUrl: string;
  diagnostics: () => string;
}

/** Start a dashboard-enabled worker against `sentry`; the caller owns cleanup of both. */
async function startWorker(
  sentry: FakeSentryServer,
  worker: WorkerFixture,
  port: number,
): Promise<Harness> {
  const token = `sentry-e2e-${crypto.randomUUID()}`;
  worker.env.SENTRY_AUTH_TOKEN = token;
  const baseUrl = dashboardBaseUrl("127.0.0.1", port);
  const diagnostics = () =>
    redact(
      [
        `runs: ${JSON.stringify(worker.runRecords())}`,
        `Sentry comment attempts: ${JSON.stringify(sentry.commentAttempts)}`,
        `Sentry comments: ${JSON.stringify(sentry.commentRecords)}`,
        `Sentry list reads: ${sentry.issueReadCount}`,
        `unexpected requests: ${JSON.stringify(sentry.unexpectedRequests)}`,
        worker.tail(),
      ].join("\n"),
      token,
    );
  await worker.prepare();
  worker.start();
  await worker.waitForReady();
  await waitForDashboardHealth(baseUrl, {
    assertAlive: () => {
      if (!worker.running) throw new Error(`worker exited\n${diagnostics()}`);
    },
    describe: diagnostics,
  });
  return { worker, sentry, token, baseUrl, diagnostics };
}

async function waitForMorePolls(harness: Harness, count: number): Promise<void> {
  const before = harness.sentry.issueReadCount;
  await harness.worker.waitFor(
    `${count} more polls of the fake Sentry issue list`,
    () => (harness.sentry.issueReadCount >= before + count ? true : undefined),
    20_000,
  );
}

/**
 * Read the dashboard views a user sees for these runs and assert none carries
 * the token. Returns the `/api/logs` body so callers can check the warning.
 */
async function assertDashboardHasNoToken(
  harness: Harness,
  runs: WorkerRunRecord[],
): Promise<string> {
  const paths = [
    "/api/runs",
    "/api/logs?level=all&limit=1000",
    "/api/sources",
    "/api/workspace",
    ...runs.flatMap((run) => [
      `/api/runs/${run.id}`,
      `/api/runs/${run.id}/harness-logs`,
      `/api/runs/${run.id}/artifacts`,
    ]),
  ];
  let logs = "";
  for (const path of paths) {
    const response = await fetch(`${harness.baseUrl}${path}`);
    const body = await response.text();
    expect(response.status, `${path} -> ${response.status}\n${harness.diagnostics()}`).toBe(200);
    expectNoToken(`dashboard ${path}`, body, harness.token);
    if (path.startsWith("/api/logs")) logs = body;
  }
  return logs;
}

/** Wait until the dashboard log view shows `needle` (log capture is file-backed). */
async function waitForDashboardLog(harness: Harness, needle: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(`${harness.baseUrl}/api/logs?level=all&limit=1000`);
    if ((await response.text()).includes(needle)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for the dashboard log view to show "${needle}"\n${harness.diagnostics()}`,
      );
    }
    await Bun.sleep(100);
  }
}

test.skipIf(!existsSync(cliPath))(
  "a 403 or 401 on the Sentry comment keeps the worker up, the run recorded, and the issue claimed, without leaking the token",
  async () => {
    const forbidden = "4601"; // token lacks `event:write`
    const unauthorized = "4602"; // token revoked between the read and the comment
    const sentry = new FakeSentryServer({
      issues: [seededIssue(forbidden), seededIssue(unauthorized)],
      commentRejections: { [forbidden]: 403, [unauthorized]: 401 },
    });
    const port = await freePort();
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-sentry-comment-auth-",
      workspaceTomlExtra: monitorConfig(sentry.url, 2),
      dashboard: { port, tailscaleAutodetect: false },
    });
    try {
      const harness = await startWorker(sentry, worker, port);
      const { diagnostics, token } = harness;

      await worker.waitFor(
        "both error-monitor runs to settle",
        () => {
          const runs = errorMonitorRuns(worker);
          return runs.length >= 2 && runs.every((run) => run.status !== "in_progress")
            ? runs
            : undefined;
        },
        90_000,
      );
      await worker.waitFor(
        "both comment attempts",
        () => (sentry.commentAttempts.length >= 2 ? true : undefined),
        15_000,
      );

      // The run outcome is recorded honestly: the fix succeeded even though the
      // feedback comment did not land.
      let runs = errorMonitorRuns(worker);
      expect(
        runs.map((run) => [run.task_key, run.status]),
        diagnostics(),
      ).toEqual([
        [`sentry-e2e-${forbidden}`, "succeeded"],
        [`sentry-e2e-${unauthorized}`, "succeeded"],
      ]);

      // The rejection reached a real comment request that carried the token,
      // and Sentry stored nothing.
      expect(sentry.commentReceivedBearer(token), diagnostics()).toBe(true);
      expect(
        sentry.commentAttempts.map((attempt) => [attempt.issueId, attempt.status]),
        diagnostics(),
      ).toEqual([
        [forbidden, 403],
        [unauthorized, 401],
      ]);
      expect(sentry.commentRecords, diagnostics()).toEqual([]);

      // The acquirer swallows the error into one warning per issue with
      // actionable guidance instead of crashing the tick or the daemon.
      for (const [id, status] of [
        [forbidden, 403],
        [unauthorized, 401],
      ] as const) {
        expect(worker.logs, diagnostics()).toContain(
          `could not comment on E2E-${id}: Sentry rejected issue-comment access (HTTP ${status})`,
        );
      }
      expect(worker.logs, diagnostics()).toContain("Issue & Event write access");

      // Later polls read both issues again but neither re-runs nor re-comments:
      // the claim was taken before the run and a comment failure does not undo it.
      await waitForMorePolls(harness, 3);
      runs = errorMonitorRuns(worker);
      expect(worker.runRecords(), diagnostics()).toHaveLength(2);
      expect(sentry.commentAttempts, diagnostics()).toHaveLength(2);
      expect(worker.running, diagnostics()).toBe(true);
      expect(sentry.unexpectedRequests, diagnostics()).toEqual([]);

      // No token in the worker log, the run records (and the raw state DB),
      // or anything the dashboard serves for these runs.
      await waitForDashboardLog(harness, `could not comment on E2E-${forbidden}`);
      const dashboardLogs = await assertDashboardHasNoToken(harness, runs);
      expect(dashboardLogs, diagnostics()).toContain("HTTP 403");
      expectNoToken("worker log", worker.logs, token);
      expectNoToken("run records", JSON.stringify(worker.runRecords()), token);
      expectNoToken("worker state database", stateDatabaseText(worker), token);
    } finally {
      try {
        await sentry.cleanup();
      } finally {
        await worker.dispose();
      }
    }
  },
  150_000,
);

test.skipIf(!existsSync(cliPath))(
  "a 5xx on the Sentry comment is bounded, never duplicates the run, and posts at most one comment after Sentry recovers",
  async () => {
    const sentry = new FakeSentryServer({ rejectCommentsWith: 503 });
    const port = await freePort();
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-sentry-comment-5xx-",
      workspaceTomlExtra: monitorConfig(sentry.url, 1),
      dashboard: { port, tailscaleAutodetect: false },
    });
    try {
      const harness = await startWorker(sentry, worker, port);
      const { diagnostics, token } = harness;

      const run = await worker.waitFor(
        "the error-monitor run to succeed",
        () => errorMonitorRuns(worker).find((record) => record.status === "succeeded"),
        45_000,
      );
      expect(run.task_key, diagnostics()).toBe(`sentry-${sentry.issueShortId.toLowerCase()}`);
      await worker.waitFor(
        "the first comment attempt",
        () => (sentry.commentAttempts.length > 0 ? true : undefined),
        15_000,
      );
      // Two completed polls after the attempt prove the tick that posted it
      // finished, including any in-tick retries.
      await waitForMorePolls(harness, 2);
      const duringOutage = sentry.commentAttempts;
      expect(
        duringOutage.every(
          (attempt) => attempt.issueId === sentry.issueId && attempt.status === 503,
        ),
        diagnostics(),
      ).toBe(true);
      expect(duringOutage.length, diagnostics()).toBeLessThanOrEqual(
        MAX_COMMENT_ATTEMPTS_PER_ISSUE,
      );
      expect(worker.logs, diagnostics()).toContain(
        `could not comment on ${sentry.issueShortId}: Sentry comment API error (HTTP 503)`,
      );

      // Sentry recovers. Whatever the product does next (today: nothing, the
      // comment is dropped), it must not start another run, exceed the attempt
      // bound, or post more than one comment.
      sentry.setCommentRejection(undefined);
      await waitForMorePolls(harness, 3);
      expect(worker.runRecords(), diagnostics()).toHaveLength(1);
      expect(sentry.commentAttempts.length, diagnostics()).toBeLessThanOrEqual(
        MAX_COMMENT_ATTEMPTS_PER_ISSUE,
      );
      expect(sentry.commentBodies.length, diagnostics()).toBeLessThanOrEqual(1);
      for (const body of sentry.commentBodies) {
        expect(body, diagnostics()).toBe(EXPECTED_SUCCESS_COMMENT);
      }
      expect(worker.running, diagnostics()).toBe(true);
      expect(sentry.unexpectedRequests, diagnostics()).toEqual([]);

      await waitForDashboardLog(harness, `could not comment on ${sentry.issueShortId}`);
      await assertDashboardHasNoToken(harness, errorMonitorRuns(worker));
      expectNoToken("worker log", worker.logs, token);
      expectNoToken("run records", JSON.stringify(worker.runRecords()), token);
      expectNoToken("worker state database", stateDatabaseText(worker), token);
    } finally {
      try {
        await sentry.cleanup();
      } finally {
        await worker.dispose();
      }
    }
  },
  120_000,
);
