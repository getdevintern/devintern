/**
 * Retry a failed tracker-task run through the worker-embedded dashboard
 * (retryMode `schedule`), against the built CLI and the offline fake Jira.
 *
 * Production behavior under test:
 * - `packages/code/src/lib/observability/dashboard-api.ts` `handleRetryRun`:
 *   a failed polled run is eligible with `kind: "task"`. In schedule mode the
 *   handler inserts one `pending` row into `scheduled_retries` (202
 *   `{ status: "scheduled", runId, taskKey }`, audit action `scheduled`,
 *   message "queued for the worker") and refuses a second one while it is
 *   pending or running (`ScheduledRetryStore.hasActive`).
 * - `packages/code/src/lib/workspace/retry-acquirer.ts` (wired in
 *   `retry-queue-builder.ts`): the worker claims the row, re-runs the ticket
 *   through the fleet executor with `--force`, and settles the row `done`.
 * - The poller itself never re-runs the failed ticket: the run's own failure
 *   comment and transition are not a human change, and after the retry
 *   succeeds the actioned gate keeps it out of later sweeps.
 * - While the row is pending or running the poller holds the ticket
 *   (`heldTaskKeys` in `task-polling.ts`), even though the retry's own
 *   transition and comment bump its stamp before the actioned marker lands.
 *   A missed hold shows up as a third run (`attempt: 3`, origin `task`) after
 *   a `[poll:jira] picking up` line in the worker log.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  concurrentDashboardWrites,
  dashboardBaseUrl,
  dashboardWriteHeaders,
  readQueueRows,
  readRetryAudit,
  waitForDashboardHealth,
} from "../../helpers/dashboard";
import { statusesFor } from "../../helpers/offline-jira";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeJiraTracker } from "../../providers/fake-jira";

/** Poll ticks to observe after each settled state, proving nothing else runs. */
const QUIET_TICKS = 3;
const FAILURE_COMMENT_MARKER = "Automated implementation did not complete";

interface ScheduledRetryRow {
  task_key: string;
  run_id: number;
  repo: string | null;
  actor: string;
  status: string;
}

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return redacted;
}

function scheduledRetries(worker: WorkerFixture): ScheduledRetryRow[] {
  return readQueueRows<ScheduledRetryRow>(
    worker.dbPath,
    "scheduled_retries",
    "SELECT task_key, run_id, repo, actor, status FROM scheduled_retries ORDER BY id",
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Wait until the worker has evaluated the user query `ticks` more times. */
async function waitForTicks(
  worker: WorkerFixture,
  tracker: FakeJiraTracker,
  query: string,
  ticks: number,
): Promise<void> {
  const target = tracker.searches.filter((jql) => jql === query).length + ticks;
  await worker.waitFor(
    `${ticks} more poll tick(s)`,
    () => (tracker.searches.filter((jql) => jql === query).length >= target ? true : undefined),
    30_000,
  );
}

test.skipIf(!existsSync(cliPath))(
  "a failed polled Jira run retried through the embedded dashboard re-runs once via scheduled_retries",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    const marker = `E2ESCHEDRETRY${token}`;
    const query = `text ~ "${marker}"`;
    // In-progress == actioned status: a bare remote cannot open the PR that
    // would trigger a second transition. Wall clock: polling compares stamps
    // with local time.
    const tracker = new FakeJiraTracker({ statuses: { pr: "In Progress" }, wallClock: true });
    let worker: WorkerFixture | undefined;
    let failure: unknown;
    try {
      const port = await freePort();
      worker = new WorkerFixture({
        rootPrefix: "devintern-e2e-dashboard-schedule-retry-",
        tracker: "jira",
        // No --skip-comments: both runs comment on and transition the ticket.
        workerTaskArgs: "--create-pr --skip-clarity-check",
        workspaceTomlExtra: [`task_query = ${JSON.stringify(query)}`, "poll_interval = 1"].join(
          "\n",
        ),
        dashboard: { port, tailscaleAutodetect: false },
        env: { ...tracker.environment(), WORKER_RETRY_INTERVAL_SECONDS: "1" },
      });
      const w = worker;
      // The same daemon serves both attempts: the sentinel fails the first
      // agent invocation before it edits; the retry implements.
      const failOnce = join(w.root, "fail-once");
      w.env.E2E_FAIL_ONCE_FILE = failOnce;
      const baseUrl = dashboardBaseUrl("127.0.0.1", port);
      const detail = () =>
        redact(
          [
            `runs: ${JSON.stringify(w.runRecords())}`,
            `scheduled_retries: ${JSON.stringify(scheduledRetries(w))}`,
            `transitions: ${JSON.stringify(tracker.transitions)}`,
            `agent: ${JSON.stringify(w.agentInvocations())}`,
            `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
            w.tail(),
          ].join("\n"),
          [tracker.environment().JIRA_API_TOKEN ?? ""],
        );

      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      await w.prepare();
      // Project settings travel with the repo; the fixture ignores the
      // directory, so force-add the per-project Jira statuses.
      const statuses = statusesFor(tracker);
      const settingsDir = join(w.seed, ".devintern-code");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        `${JSON.stringify(buildTrackerSettings("jira", tracker.projectKey(), statuses), null, 2)}\n`,
      );
      const seedGit = (...args: string[]) => checkedCommand(["git", ...args], w.seed, w.env);
      await seedGit("add", "-f", ".devintern-code/settings.json");
      await seedGit("commit", "-m", "Add Jira project settings");
      await seedGit("push");
      writeFileSync(failOnce, "1");

      w.start();
      await w.waitForReady();
      await waitForDashboardHealth(baseUrl, {
        assertAlive: () => {
          if (!w.running) throw new Error(`worker exited\n${detail()}`);
        },
        describe: detail,
      });

      // --- 1. The polled run fails once, and polling leaves it alone ---------
      const failed = await w.waitFor(
        "the polled run to fail",
        () => w.runRecords(issue.key).find((run) => run.status !== "in_progress"),
        60_000,
      );
      expect(failed.status, detail()).toBe("failed");
      expect(failed.origin, detail()).toBe("task");
      expect(existsSync(failOnce), detail()).toBe(false);
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(w.runRecords(issue.key), detail()).toHaveLength(1);
      expect(w.agentInvocations(), detail()).toEqual([{ mode: "implement" }]);
      expect(tracker.transitions, detail()).toEqual([
        { key: issue.key, status: statuses.inProgressStatus },
        { key: issue.key, status: statuses.todoStatus },
      ]);
      const failureComments = (await tracker.listComments(issue.key)).filter((comment) =>
        comment.body.includes(FAILURE_COMMENT_MARKER),
      );
      expect(failureComments, detail()).toHaveLength(1);
      expect(scheduledRetries(w), detail()).toEqual([]);

      const before = (await (await fetch(`${baseUrl}/api/runs/${failed.id}`)).json()) as {
        retry: unknown;
      };
      expect(before.retry, detail()).toEqual({ eligible: true, kind: "task", audit: [] });

      // --- 2. Two concurrent retries: one scheduled row ---------------------
      const race = await concurrentDashboardWrites<Record<string, unknown>>(
        baseUrl,
        `/api/runs/${failed.id}/retry`,
      );
      const raceDetail = () => `race: ${JSON.stringify(race)}\n${detail()}`;
      expect(
        race.filter((result) => result.status === 202),
        raceDetail(),
      ).toEqual([
        { status: 202, body: { status: "scheduled", runId: failed.id, taskKey: issue.key } },
      ]);
      const refused = race.filter((result) => result.status === 409);
      expect(refused, raceDetail()).toHaveLength(1);
      const refusal = String(refused[0]?.body.error);
      // The scheduled-row refusal is expected; the in-progress one wins only if
      // the drain already opened the retried run.
      expect(
        refusal === `a retry of ${issue.key} is already scheduled or running` ||
          new RegExp(
            `^${issue.key} already has a run in progress \\(run \\d+\\); wait for it to finish$`,
          ).test(refusal),
        raceDetail(),
      ).toBe(true);
      expect(readRetryAudit(w.dbPath), raceDetail()).toEqual([
        {
          run_id: failed.id,
          task_key: issue.key,
          actor: "local-dashboard",
          action: "scheduled",
          message: "queued for the worker",
        },
      ]);

      // --- 3. The worker's retry drain re-runs the ticket once --------------
      await w.waitFor(
        "the scheduled retry to settle",
        () => (scheduledRetries(w)[0]?.status === "done" ? true : undefined),
        60_000,
      );
      expect(scheduledRetries(w), detail()).toEqual([
        {
          task_key: issue.key,
          run_id: failed.id,
          repo: w.repoName,
          actor: "local-dashboard",
          status: "done",
        },
      ]);
      expect(count(w.logs, `[retry-queue] re-running ${issue.key}`), detail()).toBe(1);
      const runs = w.runRecords(issue.key);
      expect(
        runs.map((run) => [run.status, run.attempt]),
        detail(),
      ).toEqual([
        ["failed", 1],
        ["succeeded", 2],
      ]);
      const retried = runs[1]!;
      const branch = `feature/${issue.key.toLowerCase()}-attempt-2`;
      expect(retried.branch, detail()).toBe(branch);
      expect(await w.remoteBranches(), detail()).toContain(branch);
      expect(await w.branchFile(branch, "src/greeting.ts"), detail()).toContain("Hello, world!");

      // --- 4. Later poll ticks run nothing more ------------------------------
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(w.runRecords(issue.key), detail()).toHaveLength(2);
      expect(w.agentInvocations(), detail()).toEqual([
        { mode: "implement" },
        { mode: "implement" },
      ]);
      expect(w.logs, detail()).toContain(
        `skipping ${issue.key} (already actioned; no change since the PR)`,
      );
      expect(scheduledRetries(w), detail()).toHaveLength(1);
      // Jira saw one transition back to the actioned status and one
      // implementation comment from the retry.
      expect(tracker.transitions, detail()).toEqual([
        { key: issue.key, status: statuses.inProgressStatus },
        { key: issue.key, status: statuses.todoStatus },
        { key: issue.key, status: statuses.inProgressStatus },
      ]);
      expect(await tracker.getStatus(issue.key), detail()).toBe(statuses.prStatus);
      const comments = await tracker.listComments(issue.key);
      expect(
        comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
        detail(),
      ).toHaveLength(1);
      expect(
        comments.filter((comment) => comment.body.includes(FAILURE_COMMENT_MARKER)),
        detail(),
      ).toHaveLength(1);

      // The succeeded retry is not retriable again.
      const repeat = await fetch(`${baseUrl}/api/runs/${retried.id}/retry`, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
      });
      expect(repeat.status, detail()).toBe(409);
      expect(await repeat.json()).toEqual({ error: "not retriable: this run already succeeded" });
      expect(scheduledRetries(w), detail()).toHaveLength(1);
      expect(tracker.unexpectedRequests, detail()).toEqual([]);
      expect(w.running, detail()).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const residue: string[] = [];
      try {
        await tracker.cleanup();
      } catch (error) {
        residue.push(`fake Jira server: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await worker?.dispose();
      } catch (error) {
        residue.push(`worker fixture: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (residue.length > 0) {
        const residueError = new Error(`Cleanup left residue:\n${residue.join("\n")}`);
        if (failure) console.error(residueError.message);
        else failure = residueError;
      }
    }
    if (failure) throw failure;
  },
  120_000,
);
