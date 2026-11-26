/**
 * Worker dependency gate on Linear `blocks` relations, fully offline.
 *
 * Production wiring: the fleet executor calls the tracker dependency gate
 * (packages/code/src/lib/workspace/tracker-dependency-gate.ts) after routing a
 * polled issue and before it touches git or starts the task. The gate reads
 * blockers through `LinearTaskTrackerClient.getBlockers` →
 * `LinearClient.getIssueBlockers` (packages/task-trackers/src/clients/linear.ts),
 * an `IssueById` query selecting
 * `inverseRelations(first: 100) { nodes { type issue { identifier state { name type } } } }`
 * that keeps only `type === "blocks"` relations. A blocker counts as done when
 * its state type is `completed` or `canceled`. A blocker read that throws
 * fails closed: the issue waits with `could not read <key>'s blockers from linear: …`.
 *
 * Held-back issues are read through `devintern worker queue --json`, never the
 * database. The first wait re-checks on the next tick, then backs off; editing
 * the dependent (bumping `updatedAt`) makes it due again at once, so every
 * release below is followed by an edit instead of a sleep through the backoff.
 *
 * As in worker-linear-polling.test.ts, the Linear delta detector over-reports
 * changes within 15 minutes of any write, so nothing here relies on the delta
 * returning nothing; exactly-once rests on the status-based query (the run
 * moves the issue out of `Todo`).
 *
 * Every resource is local: a loopback fake Linear GraphQL server, a bare Git
 * remote, the deterministic agent, and a per-test temporary
 * HOME/workspace/queue.db.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanupFailure } from "../../helpers/cleanup";
import { throwCleanupFailures } from "../../helpers/cleanup";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeLinearTracker } from "../../providers/fake-linear";

const POLL_INTERVAL_SECONDS = 1;
/** Gate evaluations observed while held back: enough to span several ticks. */
const HELD_TICKS = 3;
const CANCELED = "Canceled";
const TASK_ARGS = "--create-pr --skip-clarity-check";

/** One `worker queue --json` item, as far as these tests read it. */
interface QueueItem {
  kind?: string;
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

function diagnostics(worker: WorkerFixture, tracker: FakeLinearTracker, detail = ""): string {
  const key = tracker.environment().LINEAR_API_KEY ?? "";
  return redact(
    [
      detail,
      `blocker reads: ${JSON.stringify(tracker.blockerRequests.slice(-12))}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedOperations)}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    [key],
  );
}

/**
 * Commit the Linear workflow-state names to the seeded repo (the task child
 * reads `.devintern-code/settings.json` from its worktree), as in the polling
 * test. `prStatus` equals `inProgressStatus`: the bare remote opens no PR.
 */
async function commitLinearSettings(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
): Promise<void> {
  const settingsDir = join(worker.seed, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(
      buildTrackerSettings("linear", tracker.projectKey(), {
        todoStatus: tracker.statuses.todo,
        inProgressStatus: tracker.statuses.inProgress,
        prStatus: tracker.statuses.inProgress,
      }),
      null,
      2,
    )}\n`,
  );
  const git = (...args: string[]) => checkedCommand(["git", ...args], worker.seed, worker.env);
  await git("add", "-f", ".devintern-code/settings.json");
  await git("commit", "-m", "Configure Linear workflow states");
  await git("push", "origin", worker.baseBranch);
}

/** Status-based IssueFilter: the team's ready (`Todo`) issues only. */
function readyQuery(tracker: FakeLinearTracker): Record<string, unknown> {
  return {
    team: { key: { eq: tracker.projectKey() } },
    state: { name: { eq: tracker.statuses.todo } },
  };
}

function fixtureFor(tracker: FakeLinearTracker): WorkerFixture {
  return new WorkerFixture({
    tracker: "linear",
    rootPrefix: "devintern-e2e-worker-linear-deps-",
    // Loopback fetches must never route through an ambient proxy.
    env: { ...tracker.environment(), NO_PROXY: "127.0.0.1,localhost,::1" },
    workspaceTomlExtra: [
      `task_query = ${JSON.stringify(JSON.stringify(readyQuery(tracker)))}`,
      `poll_interval = ${POLL_INTERVAL_SECONDS}`,
    ].join("\n"),
    // Tracker writes on: a started issue would be transitioned and commented
    // on, so their absence proves the gate held it before the task began.
    workerTaskArgs: TASK_ARGS,
  });
}

async function startWorker(worker: WorkerFixture, tracker: FakeLinearTracker): Promise<void> {
  await worker.prepare();
  await commitLinearSettings(worker, tracker);
  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(/Polling linear every 1s/, 10_000, "the Linear poller to start");
}

/** Held-back tracker items from `devintern worker queue --json`. */
async function queueItems(worker: WorkerFixture): Promise<QueueItem[]> {
  const stdout = await checkedCommand(
    [process.execPath, cliPath, "worker", "queue", "--json", "--workspace", worker.workspaceDir],
    worker.workspaceDir,
    worker.env,
  );
  const parsed = JSON.parse(stdout) as { items?: QueueItem[] };
  if (!Array.isArray(parsed.items)) throw new Error(`worker queue --json has no items: ${stdout}`);
  return parsed.items;
}

async function trackerQueueItem(
  worker: WorkerFixture,
  key: string,
): Promise<QueueItem | undefined> {
  return (await queueItems(worker)).find((item) => item.kind === "tracker" && item.taskKey === key);
}

/** Wait until `worker queue --json` lists `key` as a held-back tracker item matching `predicate`. */
async function waitForQueueItem(
  worker: WorkerFixture,
  key: string,
  label: string,
  predicate: (item: QueueItem) => boolean,
  timeoutMs = 20_000,
): Promise<QueueItem> {
  const deadline = Date.now() + timeoutMs;
  let last: QueueItem | undefined;
  for (;;) {
    if (!worker.running)
      throw new Error(`Worker exited while waiting for ${label}\n${worker.tail()}`);
    last = await trackerQueueItem(worker, key);
    if (last && predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label}; last item: ${JSON.stringify(last)}\n${worker.tail()}`,
      );
    }
    await Bun.sleep(250);
  }
}

/** Wait for `count` more blocker reads of `key` (gate evaluations) after index `from`. */
async function waitForBlockerReads(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  key: string,
  from: number,
  count: number,
  timeoutMs = 30_000,
): Promise<void> {
  await worker.waitFor(
    `${count} blocker reads of ${key}`,
    () => (tracker.blockerRequestsFor(key).length >= from + count ? true : undefined),
    timeoutMs,
  );
}

/**
 * Prove `key` was never started: no run record, no agent invocation, no state
 * change, no comment, no branch, and an unchanged `updatedAt`.
 */
async function assertUntouched(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  key: string,
  stamp: string,
  label: string,
): Promise<void> {
  const detail = diagnostics(worker, tracker, label);
  expect(worker.runRecords(key), detail).toEqual([]);
  expect(worker.agentInvocations(), detail).toEqual([]);
  expect(await tracker.getStatus(key), detail).toBe(tracker.statuses.todo);
  expect(await tracker.listComments(key), detail).toEqual([]);
  expect(tracker.updatedAt(key), detail).toBe(stamp);
  expect(await worker.remoteBranches(), detail).not.toContain(`feature/${key.toLowerCase()}`);
}

/** Wait for `key`'s single run to settle and prove it ran exactly once, end to end. */
async function assertRanOnce(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  key: string,
  marker: string,
): Promise<void> {
  const run = await worker.waitFor(
    `the released run for ${key} to settle`,
    () => worker.runRecords(key).find((record) => record.status !== "in_progress"),
    60_000,
  );
  let detail = diagnostics(worker, tracker, `released run of ${key}`);
  expect(run.status, detail).toBe("succeeded");
  expect(await tracker.getStatus(key), detail).toBe(tracker.statuses.inProgress);
  expect(
    (await tracker.listComments(key)).filter((comment) =>
      comment.body.includes(IMPLEMENTATION_COMMENT_MARKER),
    ),
    detail,
  ).toHaveLength(1);
  expect(await worker.remoteBranches(), detail).toContain(`feature/${key.toLowerCase()}`);

  // A few more ticks: the run moved the issue out of `Todo`, so it never re-runs.
  const searches = tracker.searchRequests.length;
  await worker.waitFor(
    "three more poll searches",
    () => (tracker.searchRequests.length >= searches + 3 ? true : undefined),
    20_000,
  );
  detail = diagnostics(worker, tracker, `after the released run of ${key}`);
  expect(worker.runRecords(key), detail).toHaveLength(1);
  const markers = worker
    .agentInvocations()
    .flatMap((invocation) => (invocation as { promptMarkers?: string[] }).promptMarkers ?? []);
  expect(markers, detail).toEqual([marker]);
  // The released issue is no longer listed as held back.
  expect(await trackerQueueItem(worker, key), detail).toBeUndefined();
  expect(worker.logs, detail).not.toContain("polling tick failed");
}

/** Stop the worker and the fake independently; report anything left behind. */
async function cleanup(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  failure: unknown,
): Promise<unknown> {
  const failures: CleanupFailure[] = [];
  try {
    await worker.dispose();
  } catch (error) {
    failures.push({ resource: "worker fixture", error });
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    failures.push({ resource: "fake Linear server", error });
  }
  if (existsSync(worker.root)) {
    failures.push({
      resource: `temporary directory ${worker.root}`,
      error: new Error("left behind"),
    });
  }
  try {
    throwCleanupFailures("Cleanup left residue", failures);
  } catch (residue) {
    if (failure) {
      console.error((residue as Error).message);
      return failure;
    }
    return residue;
  }
  return failure;
}

function uniqueMarker(): string {
  return `E2EPROMPTMARKER${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
}

/**
 * Create DEP (ready) with one open `blocks` blocker plus open `related` and
 * `duplicate` relations that must not hold it.
 */
async function seedDependency(tracker: FakeLinearTracker, marker: string) {
  const blocker = await tracker.createTicket({
    title: "Blocker: land the API first",
    body: "# Blocker\n\nIn progress elsewhere; outside the task query.\n",
    state: tracker.statuses.inProgress,
  });
  const related = await tracker.createTicket({
    title: "Related: open, must not hold the dependent",
    body: "# Related\n",
    state: tracker.statuses.inProgress,
  });
  const duplicate = await tracker.createTicket({
    title: "Duplicate: open, must not hold the dependent",
    body: "# Duplicate\n",
    state: tracker.statuses.inProgress,
  });
  const dependent = await tracker.createTicket({
    title: "Expand the greeting",
    body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
  });
  tracker.addRelation(blocker.key, "blocks", dependent.key);
  tracker.addRelation(related.key, "related", dependent.key);
  tracker.addRelation(duplicate.key, "duplicate", dependent.key);
  return { blocker, related, duplicate, dependent };
}

test.skipIf(!existsSync(cliPath))(
  "Linear worker dependency gate: a blocks relation holds the issue until the blocker completes; related and duplicate do not",
  async () => {
    const tracker = new FakeLinearTracker({ clock: "wall" });
    const worker = fixtureFor(tracker);
    let failure: unknown;
    try {
      const marker = uniqueMarker();
      const { blocker, related, duplicate, dependent } = await seedDependency(tracker, marker);
      const stamp = tracker.updatedAt(dependent.key);

      await startWorker(worker, tracker);

      // Held back across several gate evaluations.
      const held = await waitForQueueItem(
        worker,
        dependent.key,
        "the dependent to be listed as waiting",
        (item) => item.dependencyState === "waiting",
      );
      await waitForBlockerReads(worker, tracker, dependent.key, 0, HELD_TICKS);
      let detail = diagnostics(worker, tracker, "held");
      expect(held.tracker, detail).toBe("linear");
      // Only the `blocks` relation is a dependency.
      expect(held.dependsOn, detail).toEqual([blocker.key]);
      expect(held.dependsOn, detail).not.toContain(related.key);
      expect(held.dependsOn, detail).not.toContain(duplicate.key);
      expect(held.dependencyReason, detail).toContain(blocker.key);
      expect(held.dependencyReason, detail).toBe(
        `${blocker.key} not done (${tracker.statuses.inProgress})`,
      );
      await assertUntouched(worker, tracker, dependent.key, stamp, "held");
      expect(
        tracker.blockerRequestsFor(dependent.key).every((request) => request.outcome === "ok"),
        detail,
      ).toBe(true);
      // Still waiting after those ticks.
      expect((await trackerQueueItem(worker, dependent.key))?.dependencyState, detail).toBe(
        "waiting",
      );

      // Release: the blocker completes, then a human edits the dependent so it
      // re-checks without waiting out the backoff. Related and duplicate stay open.
      tracker.moveTicket(blocker.key, tracker.statuses.done);
      await tracker.editTicket(dependent.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! The API landed.\n\n${marker}\n`,
      });
      await assertRanOnce(worker, tracker, dependent.key, marker);

      detail = diagnostics(worker, tracker, "final");
      expect(await tracker.getStatus(related.key), detail).toBe(tracker.statuses.inProgress);
      expect(await tracker.getStatus(duplicate.key), detail).toBe(tracker.statuses.inProgress);
      for (const other of [blocker, related, duplicate]) {
        expect(worker.runRecords(other.key), detail).toEqual([]);
        expect(await tracker.listComments(other.key), detail).toEqual([]);
      }
      expect(tracker.unexpectedOperations, detail).toEqual([]);
      expect(worker.running, detail).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      failure = await cleanup(worker, tracker, failure);
    }
    if (failure) throw failure;
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "Linear worker dependency gate: a canceled blocker releases the issue",
  async () => {
    const tracker = new FakeLinearTracker({ clock: "wall", canceledStates: [CANCELED] });
    const worker = fixtureFor(tracker);
    let failure: unknown;
    try {
      const marker = uniqueMarker();
      // A `started` blocker (outside the `Todo` query), later canceled.
      const blocker = await tracker.createTicket({
        title: "Blocker: dropped later",
        body: "# Blocker\n",
        state: tracker.statuses.inProgress,
      });
      const dependent = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      tracker.addRelation(blocker.key, "blocks", dependent.key);
      const stamp = tracker.updatedAt(dependent.key);

      await startWorker(worker, tracker);

      const held = await waitForQueueItem(
        worker,
        dependent.key,
        "the dependent to be listed as waiting",
        (item) => item.dependencyState === "waiting",
      );
      await waitForBlockerReads(worker, tracker, dependent.key, 0, HELD_TICKS);
      const detail = diagnostics(worker, tracker, "held");
      expect(held.dependsOn, detail).toEqual([blocker.key]);
      expect(held.dependencyReason, detail).toContain(blocker.key);
      await assertUntouched(worker, tracker, dependent.key, stamp, "held");

      tracker.moveTicket(blocker.key, CANCELED);
      await tracker.editTicket(dependent.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! The blocker was dropped.\n\n${marker}\n`,
      });
      await assertRanOnce(worker, tracker, dependent.key, marker);

      expect(worker.runRecords(blocker.key), diagnostics(worker, tracker, "final")).toEqual([]);
      expect(tracker.unexpectedOperations, diagnostics(worker, tracker, "final")).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      failure = await cleanup(worker, tracker, failure);
    }
    if (failure) throw failure;
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "Linear blocker read failure fails closed (GraphQL error, then HTTP 500) and recovers",
  async () => {
    const tracker = new FakeLinearTracker({ clock: "wall" });
    const worker = fixtureFor(tracker);
    let failure: unknown;
    try {
      const marker = uniqueMarker();
      const dependent = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      const stamp = tracker.updatedAt(dependent.key);
      const readFailure = `could not read ${dependent.key}'s blockers from linear`;
      tracker.setBlockerFailure("graphql-error");

      await startWorker(worker, tracker);

      // 1. HTTP 200 with `errors`.
      const graphqlWait = await waitForQueueItem(
        worker,
        dependent.key,
        "a fail-closed wait on the GraphQL error",
        (item) => item.dependencyState === "waiting",
      );
      await waitForBlockerReads(worker, tracker, dependent.key, 0, HELD_TICKS);
      let detail = diagnostics(worker, tracker, "graphql error");
      expect(graphqlWait.tracker, detail).toBe("linear");
      expect(graphqlWait.dependencyReason, detail).toContain(readFailure);
      expect(graphqlWait.dependencyReason, detail).toContain(
        "fake Linear relations resolver unavailable",
      );
      expect(
        tracker.blockerRequestsFor(dependent.key).every((r) => r.outcome === "graphql-error"),
        detail,
      ).toBe(true);
      await assertUntouched(worker, tracker, dependent.key, stamp, "graphql error");

      // 2. HTTP 500. The edit makes the next tick re-check at once; the edit
      // stamp becomes the new baseline for "untouched".
      tracker.setBlockerFailure("http-500");
      await tracker.editTicket(dependent.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! (retry)\n\n${marker}\n`,
      });
      const editedStamp = tracker.updatedAt(dependent.key);
      const http500Wait = await waitForQueueItem(
        worker,
        dependent.key,
        "a fail-closed wait on HTTP 500",
        (item) => (item.dependencyReason ?? "").includes("(500)"),
      );
      detail = diagnostics(worker, tracker, "http 500");
      expect(http500Wait.dependencyState, detail).toBe("waiting");
      expect(http500Wait.dependencyReason, detail).toContain(readFailure);
      expect(tracker.blockerRequestsFor(dependent.key).at(-1)?.outcome, detail).toBe("http-500");
      await assertUntouched(worker, tracker, dependent.key, editedStamp, "http 500");

      // 3. Recovery: the fake answers normally (no relations), then an edit.
      tracker.setBlockerFailure(undefined);
      await tracker.editTicket(dependent.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! (recovered)\n\n${marker}\n`,
      });
      await assertRanOnce(worker, tracker, dependent.key, marker);
      detail = diagnostics(worker, tracker, "final");
      expect(tracker.blockerRequestsFor(dependent.key).at(-1)?.outcome, detail).toBe("ok");
      // The injected failures are answers, not unrouted operations.
      expect(tracker.unexpectedOperations, detail).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      failure = await cleanup(worker, tracker, failure);
    }
    if (failure) throw failure;
  },
  120_000,
);
