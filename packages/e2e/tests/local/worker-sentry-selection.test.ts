import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerRunRecord } from "../../helpers/worker";
import { FakeSentryServer } from "../../providers/fake-sentry";
import type { FakeSentryIssue } from "../../providers/fake-sentry";

/**
 * Mirrors `SENTRY_ACTION_SUCCEEDED_COMMENT` from the production client.
 *
 * Duplicated on purpose (see `worker-sentry-monitor.test.ts`): a changed
 * comment must be a visible behavior change, not an assertion that follows the
 * implementation.
 */
const EXPECTED_SUCCESS_COMMENT =
  "🤖 DevIntern completed an automated remediation run for this issue. " +
  "The issue remains unresolved pending deployment and verification.";

/** Mirrors `SENTRY_ACTION_FAILED_COMMENT` from the production client. */
const EXPECTED_FAILED_COMMENT =
  "🤖 DevIntern attempted automated remediation, but the run did not complete successfully. " +
  "The issue remains unresolved.";

interface MonitorOptions {
  minOccurrences: number;
  maxPerTick: number;
  commentOnAction: boolean;
  query?: string;
}

/** One Sentry source pointing at the in-process fake. */
function monitorConfig(baseUrl: string, options: MonitorOptions): string {
  return [
    "[[error_monitors]]",
    'id = "sentry"',
    'provider = "sentry"',
    'repo = "fixture"',
    'organization = "e2e-org"',
    'project = "e2e-project"',
    `base_url = "${baseUrl}"`,
    "poll_interval = 1",
    ...(options.query === undefined ? [] : [`query = "${options.query}"`]),
    `min_occurrences = ${options.minOccurrences}`,
    `max_per_tick = ${options.maxPerTick}`,
    `comment_on_action = ${options.commentOnAction}`,
  ].join("\n");
}

/** A seeded issue with its own id, short id, title, and permalink. */
function seededIssue(id: string, count: number): Partial<FakeSentryIssue> & { id: string } {
  return {
    id,
    shortId: `E2E-${id}`,
    title: `TypeError: cannot read properties of undefined (reading 'greeting') #${id}`,
    count: String(count),
    permalink: `https://sentry.invalid/organizations/e2e-org/issues/${id}/`,
  };
}

/** Workflow key the worker derives from the generated task filename. */
function taskKeyFor(id: string): string {
  return `sentry-e2e-${id}`;
}

function errorMonitorRuns(worker: WorkerFixture): WorkerRunRecord[] {
  return worker.runRecords().filter((record) => record.origin === "error_monitor");
}

function diagnosticsFor(worker: WorkerFixture, sentry: FakeSentryServer): () => string {
  return () =>
    [
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `Sentry comments: ${JSON.stringify(sentry.commentRecords)}`,
      `Sentry list requests: ${JSON.stringify(sentry.listRequests)}`,
      `unexpected requests: ${JSON.stringify(sentry.unexpectedRequests)}`,
      worker.tail(),
    ].join("\n");
}

/** Wait until the fake has served `count` more list reads than it had at call time. */
async function waitForMorePolls(
  worker: WorkerFixture,
  sentry: FakeSentryServer,
  count: number,
): Promise<void> {
  const before = sentry.issueReadCount;
  await worker.waitFor(
    `${count} more polls of the fake Sentry issue list`,
    () => (sentry.issueReadCount >= before + count ? true : undefined),
    20_000,
  );
}

/**
 * Index of the issue-list read that dispatched a run: the latest read the fake
 * accepted at or before the run started. A tick is single-flight (a busy tick
 * returns without reading) and executes its picks sequentially, so every run a
 * tick starts lands after that tick's read and before the next one.
 */
function dispatchingRead(sentry: FakeSentryServer, run: WorkerRunRecord): number {
  let index = -1;
  sentry.listRequests.forEach((request, i) => {
    if (request.receivedAt <= run.started_at) index = i;
  });
  return index;
}

test.skipIf(!existsSync(cliPath))(
  "the Sentry monitor filters by min_occurrences, caps runs per poll, and actions each issue once",
  async () => {
    const low = "5101"; // below the threshold for the whole test
    const first = "5102";
    const second = "5103";
    const boundary = "5104"; // exactly min_occurrences: eligible (`count < min` is skipped)
    const late = "5105"; // below the threshold until the test raises its count
    const sentry = new FakeSentryServer({
      // List order is the order the acquirer walks. The below-threshold issue
      // comes first so a regression that charges skips to the budget shows up
      // as a missing second run in the first poll.
      issues: [
        seededIssue(low, 2),
        seededIssue(first, 12),
        seededIssue(second, 9),
        seededIssue(boundary, 5),
        seededIssue(late, 1),
      ],
    });
    const worker = new WorkerFixture({
      workspaceTomlExtra: monitorConfig(sentry.url, {
        minOccurrences: 5,
        maxPerTick: 2,
        commentOnAction: true,
        query: "environment:production",
      }),
    });
    worker.env.SENTRY_AUTH_TOKEN = `sentry-e2e-${crypto.randomUUID()}`;
    const diagnostics = diagnosticsFor(worker, sentry);
    try {
      await worker.prepare();
      worker.start();
      await worker.waitForReady();

      // Three issues are eligible from the start; budget 2 means at least two polls.
      await worker.waitFor(
        "three error-monitor runs to settle",
        () => {
          const runs = errorMonitorRuns(worker);
          return runs.length >= 3 && runs.every((run) => run.status !== "in_progress")
            ? runs
            : undefined;
        },
        90_000,
      );
      let runs = errorMonitorRuns(worker);
      expect(
        runs.map((run) => run.task_key),
        diagnostics(),
      ).toEqual([taskKeyFor(first), taskKeyFor(second), taskKeyFor(boundary)]);
      expect(
        runs.map((run) => run.status),
        diagnostics(),
      ).toEqual(["succeeded", "succeeded", "succeeded"]);

      // Budget: the first poll used its full budget of two, and the remainder
      // was picked up by a later poll rather than the same one.
      const reads = runs.map((run) => dispatchingRead(sentry, run));
      expect(
        reads.every((index) => index >= 0),
        diagnostics(),
      ).toBe(true);
      expect(reads[0], diagnostics()).toBe(reads[1]);
      expect(reads[2] ?? -1, diagnostics()).toBeGreaterThan(reads[1] ?? -1);

      // The late issue becomes eligible on a later poll and gets exactly one run.
      sentry.setIssueCount(late, 6);
      await worker.waitFor(
        "the late issue's run to settle",
        () =>
          errorMonitorRuns(worker).find(
            (run) => run.task_key === taskKeyFor(late) && run.status !== "in_progress",
          ),
        45_000,
      );

      // The acquirer posts the comment after the run settles.
      await worker.waitFor(
        "four Sentry success comments",
        () => (sentry.commentRecords.length >= 4 ? true : undefined),
        15_000,
      );
      // Several more completed polls must not re-dispatch or re-comment.
      await waitForMorePolls(worker, sentry, 3);

      runs = errorMonitorRuns(worker);
      expect(worker.runRecords(), diagnostics()).toHaveLength(4);
      expect(
        runs.map((run) => run.task_key),
        diagnostics(),
      ).toEqual([taskKeyFor(first), taskKeyFor(second), taskKeyFor(boundary), taskKeyFor(late)]);
      expect(
        runs.every((run) => run.status === "succeeded"),
        diagnostics(),
      ).toBe(true);

      // No poll ever started more runs than `max_per_tick`.
      const perRead = new Map<number, number>();
      for (const run of runs) {
        const index = dispatchingRead(sentry, run);
        perRead.set(index, (perRead.get(index) ?? 0) + 1);
      }
      expect(Math.max(...perRead.values()), diagnostics()).toBeLessThanOrEqual(2);

      // One success comment per actioned issue; the below-threshold issue is never touched.
      expect(sentry.commentRecords.map((comment) => comment.issueId).sort(), diagnostics()).toEqual(
        [first, second, boundary, late].sort(),
      );
      expect(
        sentry.commentBodies.every((body) => body === EXPECTED_SUCCESS_COMMENT),
        diagnostics(),
      ).toBe(true);
      expect(
        runs.some((run) => run.task_key === taskKeyFor(low)),
        diagnostics(),
      ).toBe(false);

      // The configured query is ANDed with `is:unresolved` and sent on every
      // read; min_occurrences is applied client-side, not in the query.
      expect(sentry.listRequests.length, diagnostics()).toBeGreaterThan(3);
      for (const request of sentry.listRequests) {
        expect(request.query, diagnostics()).toBe("is:unresolved environment:production");
      }
      expect(sentry.unexpectedRequests, diagnostics()).toEqual([]);
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      try {
        await sentry.cleanup();
      } finally {
        await worker.dispose();
      }
    }
  },
  // Four sequential fixture runs (each well under 20s) plus readiness, the
  // bounded dedupe wait, and graceful shutdown.
  180_000,
);

test.skipIf(!existsSync(cliPath))(
  "a failed Sentry remediation run posts the failed-run comment once",
  async () => {
    const sentry = new FakeSentryServer();
    const worker = new WorkerFixture({
      workspaceTomlExtra: monitorConfig(sentry.url, {
        minOccurrences: 1,
        maxPerTick: 1,
        commentOnAction: true,
      }),
    });
    worker.env.SENTRY_AUTH_TOKEN = `sentry-e2e-${crypto.randomUUID()}`;
    // The deterministic agent exits 18 before editing while this file exists,
    // then deletes it; the run records as failed.
    const failOnce = join(worker.root, "fail-once");
    worker.env.E2E_FAIL_ONCE_FILE = failOnce;
    const diagnostics = diagnosticsFor(worker, sentry);
    try {
      await worker.prepare();
      writeFileSync(failOnce, "1");
      worker.start();
      await worker.waitForReady();

      const run = await worker.waitFor(
        "the error-monitor run to fail",
        () =>
          errorMonitorRuns(worker).find(
            (record) => record.status !== "in_progress" && record.status !== "queued",
          ),
        45_000,
      );
      expect(run.status, diagnostics()).toBe("failed");
      expect(run.task_key, diagnostics()).toBe(`sentry-${sentry.issueShortId.toLowerCase()}`);
      expect(run.outcome_reason ?? "", diagnostics()).toContain("code 18");
      expect(existsSync(failOnce), diagnostics()).toBe(false);

      const comments = await worker.waitFor(
        "the Sentry failed-run comment",
        () => (sentry.commentBodies.length > 0 ? sentry.commentBodies : undefined),
        15_000,
      );
      expect(comments, diagnostics()).toEqual([EXPECTED_FAILED_COMMENT]);
      expect(sentry.commentRecords[0]?.issueId).toBe(sentry.issueId);

      // The claim is durable even for a failed run: no retry, no second comment.
      await waitForMorePolls(worker, sentry, 2);
      expect(worker.runRecords(), diagnostics()).toHaveLength(1);
      expect(sentry.commentBodies, diagnostics()).toEqual([EXPECTED_FAILED_COMMENT]);
      expect(sentry.unexpectedRequests, diagnostics()).toEqual([]);
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

test.skipIf(!existsSync(cliPath))(
  "comment_on_action = false records the Sentry run but posts no comment",
  async () => {
    const sentry = new FakeSentryServer();
    const worker = new WorkerFixture({
      workspaceTomlExtra: monitorConfig(sentry.url, {
        minOccurrences: 1,
        maxPerTick: 1,
        commentOnAction: false,
      }),
    });
    worker.env.SENTRY_AUTH_TOKEN = `sentry-e2e-${crypto.randomUUID()}`;
    const diagnostics = diagnosticsFor(worker, sentry);
    try {
      await worker.prepare();
      worker.start();
      await worker.waitForReady();

      const run = await worker.waitFor(
        "the error-monitor run to succeed",
        () => errorMonitorRuns(worker).find((record) => record.status === "succeeded"),
        45_000,
      );
      expect(run.task_key, diagnostics()).toBe(`sentry-${sentry.issueShortId.toLowerCase()}`);

      // The comment would be posted right after the run settles, inside the
      // same tick; two later completed polls prove that tick finished.
      await waitForMorePolls(worker, sentry, 2);
      expect(worker.runRecords(), diagnostics()).toHaveLength(1);
      expect(sentry.commentRecords, diagnostics()).toEqual([]);
      // A comment to an unknown route would land here instead of commentRecords.
      expect(sentry.unexpectedRequests, diagnostics()).toEqual([]);
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
