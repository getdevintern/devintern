/**
 * Worker dependency gate on Jira "is blocked by" links, against the offline
 * fake Jira.
 *
 * The fleet executor calls the tracker dependency gate after routing and
 * before it touches git (`packages/code/src/lib/workspace/fleet-executor.ts`,
 * `tracker-dependency-gate.ts`). For Jira the gate reads
 * `GET /rest/api/3/issue/{key}?fields=issuelinks`
 * (`JiraTaskTrackerClient.getBlockers`) and parses it with
 * `extractIssueBlockers` (`packages/task-trackers/src/jira/issue-utils.ts`):
 * only a "Blocks" link whose `inwardIssue` is the other issue holds the
 * ticket, and a blocker counts as done once its status category is `done`.
 * The fake models links in Jira Cloud's payload shape
 * (`FakeJiraTracker.linkIssues`); this file never parses links itself.
 *
 * The held-back ticket's verdict is read through the built CLI's
 * `devintern worker queue --json --workspace <path>`, not the database.
 *
 * Re-check backoff (`waitingRecheckDelayMs` in `acquirers/task-polling.ts`)
 * grows while a ticket keeps waiting, so each release edits the dependent
 * ticket, which re-checks it on the next tick. The "blocker implemented here"
 * scenario does not edit: it proves the worker releases the dependent on its
 * own once the blocker's run settles.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { throwCleanupFailures } from "../../helpers/cleanup";
import type { CleanupFailure } from "../../helpers/cleanup";
import { statusesFor } from "../../helpers/offline-jira";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeJiraTracker, JIRA_BLOCKS_LINK, JIRA_RELATES_LINK } from "../../providers/fake-jira";

/** Poll ticks to observe after each settled state, proving nothing else runs. */
const QUIET_TICKS = 3;
/** No --skip-comments: a run that slipped through would comment and transition. */
const TASK_ARGS = "--create-pr --skip-clarity-check";

/** The subset of a `GET /api/queue` item this file asserts on. */
interface QueueItem {
  kind: string;
  taskKey?: string;
  tracker?: string;
  dependsOn?: string[];
  dependencyState?: string;
  dependencyReason?: string;
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

function diagnostics(worker: WorkerFixture, tracker: FakeJiraTracker): string {
  return redact(
    [
      `blocker reads: ${JSON.stringify(tracker.blockerReads.slice(-20))}`,
      `transitions: ${JSON.stringify(tracker.transitions)}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
      worker.tail(),
    ].join("\n"),
    [tracker.environment().JIRA_API_TOKEN ?? ""],
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** `devintern worker queue --json` items, through the built CLI. */
async function queueItems(worker: WorkerFixture): Promise<QueueItem[]> {
  const stdout = await checkedCommand(
    [process.execPath, cliPath, "worker", "queue", "--json", "--workspace", worker.workspaceDir],
    worker.workspaceDir,
    worker.env,
  );
  const body = JSON.parse(stdout) as { items?: QueueItem[] };
  return body.items ?? [];
}

async function trackerItem(worker: WorkerFixture, key: string): Promise<QueueItem | undefined> {
  return (await queueItems(worker)).find((item) => item.kind === "tracker" && item.taskKey === key);
}

/** Wait until `worker queue --json` lists `key` as a tracker item in `state`. */
async function waitForTrackerItem(
  worker: WorkerFixture,
  key: string,
  state: "waiting" | "blocked",
  timeoutMs = 60_000,
): Promise<QueueItem> {
  // `WorkerFixture.waitFor` takes a synchronous probe; the CLI call is async.
  const deadline = Date.now() + timeoutMs;
  let last: QueueItem | undefined;
  for (;;) {
    if (!worker.running) {
      throw new Error(`Worker exited while waiting for ${key} to be ${state}\n${worker.tail()}`);
    }
    last = await trackerItem(worker, key);
    if (last?.dependencyState === state) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${key} to be listed as ${state} ` +
          `(last: ${JSON.stringify(last)})\n${worker.tail()}`,
      );
    }
    await Bun.sleep(250);
  }
}

/** Wait until the fake has served `reads` more blocker reads of `key` (gate evaluations). */
async function waitForBlockerReads(
  worker: WorkerFixture,
  tracker: FakeJiraTracker,
  key: string,
  reads: number,
): Promise<void> {
  const of = () => tracker.blockerReads.filter((read) => read === key).length;
  const target = of() + reads;
  await worker.waitFor(
    `${reads} more blocker read(s) of ${key}`,
    () => (of() >= target ? true : undefined),
    60_000,
  );
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

async function commentsWith(
  tracker: FakeJiraTracker,
  key: string,
  marker: string,
): Promise<number> {
  return (await tracker.listComments(key)).filter((comment) => comment.body.includes(marker))
    .length;
}

/** Proof that the worker never started `key`: no run, transition, or comment. */
async function assertNeverStarted(
  worker: WorkerFixture,
  tracker: FakeJiraTracker,
  key: string,
  detail: () => string,
): Promise<void> {
  expect(worker.runRecords(key), detail()).toEqual([]);
  expect(
    tracker.transitions.filter((transition) => transition.key === key),
    detail(),
  ).toEqual([]);
  expect(await tracker.listComments(key), detail()).toEqual([]);
  expect(await tracker.getStatus(key), detail()).toBe(tracker.statuses.todo);
  expect(worker.logs, detail()).not.toContain(`${key} completed`);
  expect(worker.logs, detail()).not.toContain(`${key} did not complete cleanly`);
  expect(await worker.remoteBranches(), detail()).not.toContain(`feature/${key.toLowerCase()}`);
}

/**
 * Seed the per-project Jira statuses into the fixture repo, then start the
 * worker. Project settings travel with the repo, so they are force-added.
 */
async function startWorker(worker: WorkerFixture, tracker: FakeJiraTracker): Promise<void> {
  await worker.prepare();
  const settingsDir = join(worker.seed, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("jira", tracker.projectKey(), statusesFor(tracker)), null, 2)}\n`,
  );
  const seedGit = (...args: string[]) => checkedCommand(["git", ...args], worker.seed, worker.env);
  await seedGit("add", "-f", ".devintern-code/settings.json");
  await seedGit("commit", "-m", "Add Jira project settings");
  await seedGit("push");
  worker.start();
  await worker.waitForReady();
}

/**
 * Run a scenario against a fresh fake Jira and worker, then release both and
 * the fixture's temp root (HOME, workspace, `state/queue.db`, bare remote),
 * attempting every cleanup step even after a failure.
 */
async function withJiraWorker(
  options: { query: string; env?: Record<string, string> },
  scenario: (worker: WorkerFixture, tracker: FakeJiraTracker) => Promise<void>,
): Promise<void> {
  // In-progress == PR status, as in the polling test: a bare remote creates
  // no PR. Wall-clock stamps, since polling compares them with local time.
  const tracker = new FakeJiraTracker({ statuses: { pr: "In Progress" }, wallClock: true });
  let worker: WorkerFixture | undefined;
  let scenarioError: unknown;
  try {
    worker = new WorkerFixture({
      tracker: "jira",
      workerTaskArgs: TASK_ARGS,
      workspaceTomlExtra: [
        `task_query = ${JSON.stringify(options.query)}`,
        "poll_interval = 1",
      ].join("\n"),
      env: { ...tracker.environment(), ...options.env },
    });
    await scenario(worker, tracker);
  } catch (error) {
    scenarioError = error;
  }
  const failures: CleanupFailure[] = [];
  try {
    await worker?.dispose();
  } catch (error) {
    failures.push({ resource: `worker:${worker?.root}`, error });
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    failures.push({ resource: `fake-jira:${tracker.url}`, error });
  }
  if (scenarioError !== undefined) {
    if (failures.length > 0) {
      console.error(
        `Jira dependency cleanup also failed for: ${failures.map((failure) => failure.resource).join(", ")}`,
      );
    }
    throw scenarioError;
  }
  throwCleanupFailures("Jira dependency worker cleanup failed", failures);
}

function runMarker(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
}

test.skipIf(!existsSync(cliPath))(
  "Jira worker dependency gate: is-blocked-by links hold a polled ticket until the blocker is done",
  async () => {
    const marker = runMarker("E2EDEPGATE");
    const query = `text ~ "${marker}"`;
    await withJiraWorker({ query }, async (w, tracker) => {
      const detail = () => diagnostics(w, tracker);
      // BLK is outside the query: the worker never handles it, so only its
      // Jira status category can release DEP.
      const blk = await tracker.createTicket({
        title: "Blocker outside the query",
        body: "# Blocker\n\nNot polled by this worker.\n",
      });
      const dep = await tracker.createTicket({
        title: "Expand the greeting (blocked)",
        body: `# Dependent\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      // NB is linked to the same open BLK, but neither link blocks it: a
      // Relates link where NB is the inward side (it sees `inwardIssue: BLK`)
      // and an outward Blocks link ("NB blocks BLK", it sees `outwardIssue`).
      const nb = await tracker.createTicket({
        title: "Expand the greeting (non-blocking links)",
        body: `# Not blocked\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      tracker.linkIssues(JIRA_BLOCKS_LINK, blk.key, dep.key);
      tracker.linkIssues(JIRA_RELATES_LINK, blk.key, nb.key);
      tracker.linkIssues(JIRA_BLOCKS_LINK, nb.key, blk.key);

      await startWorker(w, tracker);

      // 1. DEP is held back; NB, linked to the same open blocker, runs. -----
      const held = await waitForTrackerItem(w, dep.key, "waiting");
      expect(held.tracker, detail()).toBe("jira");
      expect(held.dependsOn, detail()).toContain(blk.key);
      expect(held.dependsOn, detail()).not.toContain(nb.key);
      expect(held.dependencyReason, detail()).toContain(blk.key);
      expect(held.dependencyReason, detail()).toContain(`${blk.key} not done (To Do)`);

      await w.waitForOutput(
        new RegExp(`\\[poll:jira\\] ${nb.key} completed`),
        90_000,
        "the ticket with only non-blocking links to run",
      );
      expect(
        w.runRecords(nb.key).map((run) => run.status),
        detail(),
      ).toEqual(["succeeded"]);
      expect(await commentsWith(tracker, nb.key, IMPLEMENTATION_COMMENT_MARKER), detail()).toBe(1);
      expect(w.logs, detail()).not.toContain(`${nb.key} waiting`);
      expect(await trackerItem(w, nb.key), detail()).toBeUndefined();
      expect(tracker.blockerReads, detail()).toContain(nb.key);

      // Several more gate evaluations: DEP stays held and is never started.
      await waitForBlockerReads(w, tracker, dep.key, QUIET_TICKS);
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      await assertNeverStarted(w, tracker, dep.key, detail);
      expect(w.agentInvocations(), detail()).toHaveLength(1);
      expect((await trackerItem(w, dep.key))?.dependencyState, detail()).toBe("waiting");
      // The blocker outside the query is never touched either.
      await assertNeverStarted(w, tracker, blk.key, detail);

      // 2. BLK done (category `done`) + a DEP edit releases it once. --------
      tracker.setStatus(blk.key, tracker.statuses.done);
      await tracker.editTicket(dep.key, {
        body: `# Dependent\n\nChange the greeting to Hello, world! and run bun test. The blocker is done.\n\n${marker}\n`,
      });
      await w.waitForOutput(
        new RegExp(`\\[poll:jira\\] ${dep.key} completed`),
        90_000,
        "the released dependent to run",
      );
      await waitForTicks(w, tracker, query, QUIET_TICKS);
      expect(
        w.runRecords(dep.key).map((run) => run.status),
        detail(),
      ).toEqual(["succeeded"]);
      expect(count(w.logs, `${dep.key} completed`), detail()).toBe(1);
      expect(await commentsWith(tracker, dep.key, IMPLEMENTATION_COMMENT_MARKER), detail()).toBe(1);
      expect(w.agentInvocations(), detail()).toHaveLength(2);
      expect(await trackerItem(w, dep.key), detail()).toBeUndefined();
      expect(w.runRecords(blk.key), detail()).toEqual([]);
      expect(tracker.unexpectedRequests, detail()).toEqual([]);
      expect(w.running, detail()).toBe(true);
    });
  },
  // One worker start with 1s polling and two agent runs; every wait is event-driven.
  240_000,
);

test.skipIf(!existsSync(cliPath))(
  "Jira blocker read failure fails closed until the endpoint recovers",
  async () => {
    const marker = runMarker("E2EDEPREAD");
    const query = `text ~ "${marker}"`;
    // One attempt per blocker read keeps each failing gate evaluation short;
    // the product's fail-closed handling does not depend on the retry count.
    await withJiraWorker(
      { query, env: { DEVINTERN_FETCH_MAX_RETRIES: "0" } },
      async (w, tracker) => {
        const detail = () => diagnostics(w, tracker);
        const dep = await tracker.createTicket({
          title: "Expand the greeting (blocker read fails)",
          body: `# Dependent\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
        });
        tracker.failBlockerReads(true);

        await startWorker(w, tracker);

        const held = await waitForTrackerItem(w, dep.key, "waiting");
        expect(held.dependencyReason, detail()).toStartWith(
          `could not read ${dep.key}'s blockers from jira: `,
        );
        expect(held.dependencyReason, detail()).toContain("500");
        await waitForBlockerReads(w, tracker, dep.key, QUIET_TICKS);
        await assertNeverStarted(w, tracker, dep.key, detail);
        expect(w.agentInvocations(), detail()).toEqual([]);
        expect((await trackerItem(w, dep.key))?.dependencyState, detail()).toBe("waiting");

        // Recovery: the next gate read succeeds (no links) and DEP runs once.
        tracker.failBlockerReads(false);
        await tracker.editTicket(dep.key, {
          body: `# Dependent\n\nChange the greeting to Hello, world! and run bun test. Jira recovered.\n\n${marker}\n`,
        });
        await w.waitForOutput(
          new RegExp(`\\[poll:jira\\] ${dep.key} completed`),
          90_000,
          "the dependent to run once blocker reads recover",
        );
        await waitForTicks(w, tracker, query, QUIET_TICKS);
        expect(
          w.runRecords(dep.key).map((run) => run.status),
          detail(),
        ).toEqual(["succeeded"]);
        expect(w.agentInvocations(), detail()).toHaveLength(1);
        expect(await trackerItem(w, dep.key), detail()).toBeUndefined();
        expect(tracker.unexpectedRequests, detail()).toEqual([]);
      },
    );
  },
  180_000,
);

test.skipIf(!existsSync(cliPath))(
  "Jira blocker implemented by this worker releases its dependent; a failed blocker blocks it",
  async () => {
    const marker = runMarker("E2EDEPLOCAL");
    // The failing blocker reports incomplete, which settles an `escalated`
    // run. `E2E_FAIL_PROMPT_MARKER` cannot stand in for it under the worker:
    // the fake agent exits before any output, which the worker treats as a
    // harness that could not start, so it defers the ticket and retries every
    // 60s without ever settling a failed run.
    const failMarker = runMarker("E2EDEPFAIL");
    const query = `text ~ "${marker}"`;
    await withJiraWorker(
      { query, env: { E2E_INCOMPLETE_PROMPT_MARKER: failMarker } },
      async (w, tracker) => {
        const detail = () => diagnostics(w, tracker);
        // Dependents are created first so the first sweep evaluates them
        // before their blockers have any run.
        const dep = await tracker.createTicket({
          title: "Expand the greeting (after the blocker)",
          body: `# Dependent\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
        });
        const depOfFailed = await tracker.createTicket({
          title: "Expand the greeting (after the failing blocker)",
          body: `# Dependent of a failure\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
        });
        const blk = await tracker.createTicket({
          title: "Expand the greeting (blocker)",
          body: `# Blocker\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
        });
        const failing = await tracker.createTicket({
          title: "Expand the greeting (failing blocker)",
          body: `# Failing blocker\n\nThe deterministic agent reports this one incomplete.\n\n${marker}\n\n${failMarker}\n`,
        });
        tracker.linkIssues(JIRA_BLOCKS_LINK, blk.key, dep.key);
        tracker.linkIssues(JIRA_BLOCKS_LINK, failing.key, depOfFailed.key);

        await startWorker(w, tracker);

        // 1. BLK runs first and succeeds without a PR (bare remote); DEP
        //    starts only after BLK's run settled, while Jira still reports
        //    BLK open (In Progress, category `indeterminate`).
        await w.waitForOutput(
          new RegExp(`\\[poll:jira\\] ${blk.key} completed`),
          90_000,
          "the blocker to run",
        );
        await w.waitForOutput(
          new RegExp(`\\[poll:jira\\] ${dep.key} completed`),
          120_000,
          "the dependent to run after its blocker settled",
        );
        const [blkRun] = w.runRecords(blk.key);
        const [depRun] = w.runRecords(dep.key);
        expect(blkRun?.status, detail()).toBe("succeeded");
        expect(blkRun?.pr_url, detail()).toBeNull();
        expect(depRun?.status, detail()).toBe("succeeded");
        expect(blkRun?.finished_at, detail()).not.toBeNull();
        expect(depRun!.started_at, detail()).toBeGreaterThanOrEqual(blkRun!.finished_at!);
        expect(await tracker.getStatus(blk.key), detail()).toBe("In Progress");
        // DEP was held at least once before BLK's run settled.
        expect(w.logs, detail()).toContain(`${dep.key} waiting: ${blk.key}`);

        // 2. The failing blocker blocks its dependent, which never starts.
        await w.waitFor(
          "the failing blocker's run to settle unsuccessfully",
          () => {
            const runs = w.runRecords(failing.key);
            return runs.length > 0 && runs.every((run) => run.status !== "in_progress")
              ? runs
              : undefined;
          },
          120_000,
        );
        expect(
          w.runRecords(failing.key).map((run) => run.status),
          detail(),
        ).toEqual(["escalated"]);
        const blocked = await waitForTrackerItem(w, depOfFailed.key, "blocked");
        expect(blocked.dependsOn, detail()).toEqual([failing.key]);
        expect(blocked.dependencyReason, detail()).toBe(`${failing.key} escalated`);
        await waitForBlockerReads(w, tracker, depOfFailed.key, QUIET_TICKS);
        await waitForTicks(w, tracker, query, QUIET_TICKS);
        await assertNeverStarted(w, tracker, depOfFailed.key, detail);
        expect((await trackerItem(w, depOfFailed.key))?.dependencyState, detail()).toBe("blocked");
        expect(w.runRecords(blk.key), detail()).toHaveLength(1);
        expect(w.runRecords(dep.key), detail()).toHaveLength(1);
        expect(tracker.unexpectedRequests, detail()).toEqual([]);
      },
    );
  },
  300_000,
);
