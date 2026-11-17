/**
 * Worker tracker polling against the offline fake Jira.
 *
 * Drives the built `devintern worker` daemon with `[defaults].tracker = "jira"`
 * and a `[defaults].task_query` through the detect → evaluate → dedupe →
 * execute loop (`packages/code/src/lib/acquirers/task-polling.ts`):
 *
 * - the Jira change detector sends `updated >= "-Nm"`
 *   (`createJiraChangeDetector` in `acquirers/change-detector.ts`), and the
 *   evaluate step re-runs the user query verbatim;
 * - dedupe is by `(task key, updated)` in `processed_events`;
 * - a completed, unchanged ticket stays out of the sweep. The bare remote has
 *   no code-host platform, so no PR is created and `applyActionedTransition`
 *   (`agent/run-harness-git.ts`) never runs. Instead the worker records the
 *   actioned marker for a successful no-PR run (`recordActionedWithoutPr` in
 *   `task/pipeline.ts`), and the acquirer's actioned gate
 *   (`createTaskActionedGate` in `task/actioned-state.ts`) skips the ticket
 *   until a human edits it. The PR-created marker on a real host stays
 *   live-only coverage.
 * - a failed (incomplete) ticket is gated by the retry gate
 *   (`state/retry-gate.ts`): the bot's own comment and transition bump
 *   `updated`, so the acquirer claims the new stamp, but the task child skips
 *   it before any agent run ("skipped (previous attempt reported
 *   incomplete; ticket unchanged)"). Only a human comment unlocks a retry.
 * - cursors persist in `<workspace>/state/queue.db` across a graceful restart.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statusesFor } from "../../helpers/offline-jira";
import { checkedCommand } from "../../helpers/process";
import {
  assertImplementationComment,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeJiraTracker } from "../../providers/fake-jira";

const SOURCE = "jira";
const INCOMPLETE_COMMENT_MARKER = "Implementation Incomplete";
const DETECTOR_JQL = /^updated >= "-(\d+)m"$/;
/** Poll ticks to observe after each settled state, proving nothing else runs. */
const QUIET_TICKS = 3;

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return redacted;
}

function diagnostics(worker: WorkerFixture, tracker: FakeJiraTracker): string {
  return redact(
    [
      `searches: ${JSON.stringify(tracker.searches.slice(-12))}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `cursor: ${worker.pollCursor(SOURCE)}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
      worker.tail(),
    ].join("\n"),
    [tracker.environment().JIRA_API_TOKEN ?? ""],
  );
}

function agentModes(worker: WorkerFixture): string[] {
  return worker.agentInvocations().map((invocation) => invocation.mode);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function commentsWith(
  tracker: FakeJiraTracker,
  key: string,
  marker: string,
): Promise<number> {
  return (await tracker.listComments(key)).filter((comment) => comment.body.includes(marker))
    .length;
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
  "worker polls fake Jira, dedupes unchanged tickets, re-arms on change, gates retries, and resumes its cursor",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    const marker = `E2EPOLL${token}`;
    const incompleteMarker = `E2EINCOMPLETE${token}`;
    const decoyMarker = `E2EDECOY${token}`;
    const query = `text ~ "${marker}"`;
    // Resources are recorded as they are created and released in finally.
    // Same workflow as the one-shot offline lifecycle (in-progress == actioned
    // status, since a bare remote cannot create the PR that would trigger a
    // second transition), stamped with the real wall clock because polling
    // compares tracker stamps with local time.
    const tracker = new FakeJiraTracker({ statuses: { pr: "In Progress" }, wallClock: true });
    let worker: WorkerFixture | undefined;
    let failure: unknown;
    try {
      worker = new WorkerFixture({
        tracker: "jira",
        // No --skip-comments: the run must comment on and transition the ticket.
        workerTaskArgs: "--create-pr --skip-clarity-check",
        workspaceTomlExtra: [`task_query = ${JSON.stringify(query)}`, "poll_interval = 1"].join(
          "\n",
        ),
        env: { ...tracker.environment(), E2E_INCOMPLETE_PROMPT_MARKER: incompleteMarker },
      });
      const w = worker;
      const detail = () => diagnostics(w, tracker);

      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      const failing = await tracker.createTicket({
        title: "Expand the greeting (reports incomplete)",
        body: `# Incomplete\n\nThe deterministic agent reports this one incomplete.\n\n${marker}\n\n${incompleteMarker}\n`,
      });
      const decoy = await tracker.createTicket({
        title: "Expand the greeting (decoy)",
        body: `# Decoy\n\nOutside the task query.\n\n${decoyMarker}\n`,
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

      // 1. Pickup ------------------------------------------------------------
      w.start();
      await w.waitForReady();
      await w.waitForOutput(
        new RegExp(`\\[poll:jira\\] ${issue.key} completed`),
        60_000,
        "the eligible issue to complete",
      );
      await w.waitForOutput(
        new RegExp(
          `\\[poll:jira\\] ${failing.key} skipped \\(previous attempt reported incomplete`,
        ),
        60_000,
        "the incomplete issue to be gated after its failed run",
      );

      const branch = `feature/${issue.key.toLowerCase()}`;
      expect(await w.remoteBranches(), detail()).toContain(branch);
      expect(await w.branchFile(branch, "src/greeting.ts"), detail()).toContain("Hello, world!");
      const issueRuns = w.runRecords(issue.key);
      expect(
        issueRuns.map((run) => run.status),
        detail(),
      ).toEqual(["succeeded"]);
      expect(issueRuns[0]?.pr_url, detail()).toBeNull();
      expect(await tracker.getStatus(issue.key), detail()).toBe(statuses.prStatus);
      assertImplementationComment(await tracker.listComments(issue.key));
      expect(await commentsWith(tracker, issue.key, IMPLEMENTATION_COMMENT_MARKER), detail()).toBe(
        1,
      );
      // The no-PR run recorded a verified actioned marker after its own writes.
      expect(w.actionedTask(SOURCE, issue.key)?.verified, detail()).toBe(1);

      // The detector window and the user query were both sent verbatim.
      expect(tracker.searches, detail()).toContain(query);
      const windows = tracker.searches.filter((jql) => DETECTOR_JQL.test(jql));
      expect(windows.length, detail()).toBeGreaterThan(0);
      for (const jql of windows) {
        // DELTA_LOOKBACK_MS (5m) + 1m rounding: never narrower than 6 minutes.
        expect(Number(jql.match(DETECTOR_JQL)?.[1]), detail()).toBeGreaterThanOrEqual(6);
      }
      expect(
        tracker.searches.every((jql) => jql === query || DETECTOR_JQL.test(jql)),
        detail(),
      ).toBe(true);

      // 4a. The failing issue ran once, was commented on and moved back.
      expect(
        w.runRecords(failing.key).map((run) => run.status),
        detail(),
      ).toEqual(["escalated"]);
      expect(await commentsWith(tracker, failing.key, INCOMPLETE_COMMENT_MARKER), detail()).toBe(1);
      expect(await tracker.getStatus(failing.key), detail()).toBe(statuses.todoStatus);

      // 2. No re-run while unchanged ----------------------------------------
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(agentModes(w), detail()).toEqual(["implement", "incomplete"]);
      expect(w.logs, detail()).toContain(
        `skipping ${issue.key} (already actioned; no change since the PR)`,
      );
      expect(count(w.logs, `picking up ${issue.key}`), detail()).toBe(1);
      expect(w.runRecords(issue.key), detail()).toHaveLength(1);
      // The bot's own comment/transition on the failed ticket is not a change.
      expect(w.runRecords(failing.key), detail()).toHaveLength(1);

      // 3. Re-arm on a human edit -------------------------------------------
      const stampBefore = tracker.getUpdated(issue.key);
      await tracker.editTicket(issue.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test. Also keep the export name.\n\n${marker}\n`,
      });
      expect(tracker.getUpdated(issue.key)).not.toBe(stampBefore);
      await w.waitFor(
        "the edited issue to run again",
        () =>
          w.runRecords(issue.key).length >= 2 && count(w.logs, `${issue.key} completed`) >= 2
            ? true
            : undefined,
        60_000,
      );
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(agentModes(w), detail()).toEqual(["implement", "incomplete", "implement"]);
      expect(
        w.runRecords(issue.key).map((run) => run.status),
        detail(),
      ).toEqual(["succeeded", "succeeded"]);
      expect(count(w.logs, `picking up ${issue.key}`), detail()).toBe(2);

      // 4b. Retry gate: a human comment unlocks exactly one retry -------------
      await tracker.addComment(
        failing.key,
        "Clarification: the greeting lives in src/greeting.ts.",
      );
      await w.waitFor(
        "the commented issue to retry",
        () =>
          agentModes(w).filter((mode) => mode === "incomplete").length >= 2 ? true : undefined,
        60_000,
      );
      await w.waitFor(
        "the retry to be gated again",
        () =>
          count(w.logs, `${failing.key} skipped (previous attempt reported incomplete`) >= 2
            ? true
            : undefined,
        60_000,
      );
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(agentModes(w), detail()).toEqual([
        "implement",
        "incomplete",
        "implement",
        "incomplete",
      ]);
      expect(
        w.runRecords(failing.key).map((run) => run.status),
        detail(),
      ).toEqual(["escalated", "escalated"]);
      expect(await commentsWith(tracker, failing.key, INCOMPLETE_COMMENT_MARKER), detail()).toBe(2);

      // The decoy outside the query was never touched.
      expect(w.logs, detail()).not.toContain(decoy.key);
      expect(w.runRecords(decoy.key), detail()).toEqual([]);
      expect(await tracker.listComments(decoy.key), detail()).toEqual([]);
      expect(await tracker.getStatus(decoy.key), detail()).toBe(statuses.todoStatus);
      expect(await w.remoteBranches(), detail()).not.toContain(
        `feature/${decoy.key.toLowerCase()}`,
      );

      // 5. Cursor persistence across a graceful restart ----------------------
      await w.stop();
      const cursor = w.pollCursor(SOURCE);
      expect(Number(cursor), detail()).toBeGreaterThan(0);
      const searchesBeforeRestart = tracker.searches.length;
      const modesBeforeRestart = agentModes(w);
      const runsBeforeRestart = w.runRecords().length;

      w.start();
      await w.waitForReady();
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      const afterRestart = tracker.searches.slice(searchesBeforeRestart);
      // A null cursor would drain the backlog with the user query first; a
      // resumed cursor sends the detector window first.
      expect(afterRestart[0], detail()).toMatch(DETECTOR_JQL);
      expect(agentModes(w), detail()).toEqual(modesBeforeRestart);
      expect(w.runRecords(), detail()).toHaveLength(runsBeforeRestart);
      expect(w.logs, detail()).not.toContain("picking up");
      expect(w.logs, detail()).toContain(
        `skipping ${issue.key} (already actioned; no change since the PR)`,
      );
      expect(w.logs, detail()).toContain(
        `skipping ${failing.key} (already processed at this update)`,
      );
      expect(Number(w.pollCursor(SOURCE)), detail()).toBeGreaterThan(Number(cursor));

      expect(await commentsWith(tracker, issue.key, IMPLEMENTATION_COMMENT_MARKER), detail()).toBe(
        2,
      );
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
  // Two bounded worker starts with 1s polling; every wait is event-driven.
  150_000,
);
