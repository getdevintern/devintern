/**
 * Worker Mode 1 polling against Linear's GraphQL IssueFilter, fully offline.
 *
 * Production wiring: `createChangeDetector("linear")` builds
 * `createLinearChangeDetector` (packages/code/src/lib/acquirers/change-detector.ts),
 * which sends `{"updatedAt":{"gt":"<ISO>"}}` through `LinearClient.searchIssues`
 * (packages/task-trackers/src/clients/linear.ts; endpoint from `LINEAR_API_URL`).
 * The ISO bound is the persisted cursor minus `DELTA_LOOKBACK_MS` (5 minutes).
 * The first tick has no cursor and skips the delta query entirely. When the
 * delta returns anything, the acquirer re-runs `[defaults].task_query` and
 * dedupes on `(key, updatedAt)` (packages/code/src/lib/acquirers/task-polling.ts).
 *
 * Observed behavior pinned here (not separately documented upstream):
 * - The delta filter is sent bare; it is not combined with the team/state
 *   filter of the user's query, so it matches any issue the API key can see.
 * - Because of the 5-minute overlap, every tick within 5 minutes of any write
 *   (including the worker's own comment and state transition) counts as
 *   "changed" and re-runs the evaluate query. Exactly-once execution therefore
 *   rests on the status-based query (test 1) and the `(key, updated)` dedupe
 *   (test 2), not on the delta returning nothing.
 * - The cursor is the detection start time of the previous settled tick, so
 *   after a restart the first request is the delta built from the saved cursor.
 *
 * Every resource is local: a loopback fake Linear GraphQL server, a bare Git
 * remote, the deterministic agent, and a per-test temporary
 * HOME/workspace/queue.db.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerFixtureOptions } from "../../helpers/worker";
import { FakeLinearTracker } from "../../providers/fake-linear";
import type { FakeLinearSearchRequest } from "../../providers/fake-linear";

const POLL_INTERVAL_SECONDS = 1;
/** Idle ticks observed per quiet window: enough to prove no re-run. */
const IDLE_TICKS = 3;
/** `DELTA_LOOKBACK_MS` in change-detector.ts. */
const DELTA_LOOKBACK_MS = 5 * 60_000;
const BACKLOG = "Backlog";
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Worker fixture with a read of the persisted poll cursor (`cursors` table). */
class LinearWorkerFixture extends WorkerFixture {
  constructor(options: WorkerFixtureOptions) {
    super(options);
  }

  pollCursor(source = "linear"): string | undefined {
    return this.query<{ cursor_value: string }>(
      "SELECT cursor_value FROM cursors WHERE source = ?",
      [source],
    )[0]?.cursor_value;
  }
}

/** `updatedAt.gt` bound of a bare detector delta filter, or undefined for any other filter. */
function deltaBound(request: FakeLinearSearchRequest): string | undefined {
  const filter = request.filter;
  if (filter === null || typeof filter !== "object") return undefined;
  const keys = Object.keys(filter);
  if (keys.length !== 1 || keys[0] !== "updatedAt") return undefined;
  const condition = (filter as { updatedAt: unknown }).updatedAt;
  if (condition === null || typeof condition !== "object") return undefined;
  const operations = Object.keys(condition);
  if (operations.length !== 1 || operations[0] !== "gt") return undefined;
  const gt = (condition as { gt: unknown }).gt;
  return typeof gt === "string" ? gt : undefined;
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
      `searches: ${JSON.stringify(tracker.searchRequests.slice(-12))}`,
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
 * Commit the Linear workflow-state names to the seeded repo.
 *
 * The task child reads `.devintern-code/settings.json` from its worktree cwd,
 * so the file must travel with the repository, as it does in production.
 * `prStatus` equals `inProgressStatus` because the local bare remote cannot
 * produce a PR that would trigger a separate post-PR transition.
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

function workspaceToml(query: Record<string, unknown>): string {
  return [
    `task_query = ${JSON.stringify(JSON.stringify(query))}`,
    `poll_interval = ${POLL_INTERVAL_SECONDS}`,
  ].join("\n");
}

function fixtureFor(
  tracker: FakeLinearTracker,
  extra: Partial<WorkerFixtureOptions> = {},
): LinearWorkerFixture {
  return new LinearWorkerFixture({
    tracker: "linear",
    rootPrefix: "devintern-e2e-worker-linear-",
    // Loopback fetches must never route through an ambient proxy.
    env: { ...tracker.environment(), NO_PROXY: "127.0.0.1,localhost,::1" },
    workspaceTomlExtra: workspaceToml(readyQuery(tracker)),
    ...extra,
  });
}

/** Prompt markers the deterministic agent saw, in invocation order. */
function promptMarkers(worker: WorkerFixture): string[] {
  return worker
    .agentInvocations()
    .flatMap((invocation) => (invocation as { promptMarkers?: string[] }).promptMarkers ?? []);
}

async function waitForSettledRun(worker: WorkerFixture, key: string, timeoutMs = 60_000) {
  return await worker.waitFor(
    `the polled run for ${key} to settle`,
    () => worker.runRecords(key).find((run) => run.status !== "in_progress"),
    timeoutMs,
  );
}

/** Wait for a search request at index >= `from` that satisfies `predicate`. */
async function waitForSearch(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  label: string,
  from: number,
  predicate: (request: FakeLinearSearchRequest) => boolean,
  timeoutMs = 20_000,
): Promise<{ request: FakeLinearSearchRequest; index: number }> {
  return await worker.waitFor(
    label,
    () => {
      for (let index = from; index < tracker.searchRequests.length; index++) {
        const request = tracker.searchRequests[index]!;
        if (predicate(request)) return { request, index };
      }
      return undefined;
    },
    timeoutMs,
  );
}

/**
 * Observe {@link IDLE_TICKS} more delta queries with no executions in flight
 * and prove each one's bound is the previous tick's detection time minus the
 * 5-minute lookback, and that no run or agent invocation happened.
 *
 * Each idle tick has no executions to await, so it persists its detection
 * start time (taken just before its delta request) as the next cursor.
 */
async function assertIdleTicks(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  label: string,
): Promise<void> {
  const runs = worker.runRecords().length;
  const invocations = worker.agentInvocations().length;
  const start = tracker.searchRequests.length;
  const deltas = await worker.waitFor(
    `${label}: ${IDLE_TICKS + 1} delta queries`,
    () => {
      const found = tracker.searchRequests
        .slice(start)
        .filter((request) => deltaBound(request) !== undefined);
      return found.length > IDLE_TICKS ? found : undefined;
    },
    (IDLE_TICKS + 10) * POLL_INTERVAL_SECONDS * 1000,
  );
  const detail = diagnostics(worker, tracker, label);
  for (let index = 1; index < deltas.length; index++) {
    const previous = deltas[index - 1]!;
    const bound = Date.parse(deltaBound(deltas[index]!)!);
    const cursor = bound + DELTA_LOOKBACK_MS;
    // The cursor was taken just before the previous tick's delta request.
    expect(previous.receivedAt - cursor, detail).toBeGreaterThanOrEqual(0);
    expect(previous.receivedAt - cursor, detail).toBeLessThan(1_000);
  }
  expect(worker.runRecords().length, detail).toBe(runs);
  expect(worker.agentInvocations().length, detail).toBe(invocations);
  expect(worker.logs, detail).not.toContain("polling tick failed");
}

/**
 * Wait for the next idle delta, then stop the worker gracefully and start it
 * again on the same workspace and queue DB. Proves the first request of the
 * new daemon is the delta filter built from the saved cursor.
 */
async function restartAndAssertCursor(
  worker: LinearWorkerFixture,
  tracker: FakeLinearTracker,
): Promise<void> {
  await worker.stop();
  const savedCursor = worker.pollCursor();
  const detail = diagnostics(worker, tracker, "before restart");
  expect(savedCursor, detail).toBeDefined();
  expect(Number.isFinite(Number(savedCursor)), detail).toBe(true);

  const mark = tracker.searchRequests.length;
  worker.start();
  await worker.waitForReady();
  const first = await waitForSearch(worker, tracker, "the first search after restart", mark, () => {
    return true;
  });
  const afterRestart = diagnostics(worker, tracker, "after restart");
  expect(first.index, afterRestart).toBe(mark);
  // Exactly the saved cursor minus the lookback: the cursor was reused, not reset.
  expect(first.request.filter, afterRestart).toEqual({
    updatedAt: { gt: new Date(Number(savedCursor) - DELTA_LOOKBACK_MS).toISOString() },
  });
}

/** Stop the worker and the fake independently; report anything left behind. */
async function cleanup(
  worker: WorkerFixture,
  tracker: FakeLinearTracker,
  failure: unknown,
): Promise<unknown> {
  const residue: string[] = [];
  try {
    await worker.dispose();
  } catch (error) {
    residue.push(`worker fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    residue.push(`fake Linear server: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (existsSync(worker.root)) residue.push(`temporary directory: ${worker.root}`);
  if (residue.length === 0) return failure;
  const residueError = new Error(`Cleanup left residue:\n${residue.join("\n")}`);
  if (failure) {
    console.error(residueError.message);
    return failure;
  }
  return residueError;
}

function uniqueMarker(): string {
  return `E2EPROMPTMARKER${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
}

test.skipIf(!existsSync(cliPath))(
  "worker polls Linear by updatedAt delta: pickup, delta shape, no re-run, re-arm on state change, cursor restart",
  async () => {
    const tracker = new FakeLinearTracker({ clock: "wall", extraStates: [BACKLOG] });
    // Tracker writes on (no `--skip-comments`): the worker's own comment and
    // state transition are what take the issue out of the status-based query.
    const worker = fixtureFor(tracker, { workerTaskArgs: "--create-pr --skip-clarity-check" });
    let failure: unknown;
    try {
      const eligibleMarker = uniqueMarker();
      const followUpMarker = uniqueMarker();
      const decoy = await tracker.createTicket({
        title: "Backlog grooming (decoy)",
        body: "# Decoy\n\nOutside the task query; must stay untouched.\n",
        state: BACKLOG,
      });
      const eligible = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${eligibleMarker}\n`,
      });
      const followUp = await tracker.createTicket({
        title: "Follow-up greeting (not ready yet)",
        body: `# Follow-up\n\nChange the greeting to Hello, world!\n\n${followUpMarker}\n`,
        state: BACKLOG,
      });
      const decoyStamp = tracker.updatedAt(decoy.key);

      await worker.prepare();
      await commitLinearSettings(worker, tracker);
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(/Polling linear every 1s/, 10_000, "the Linear poller to start");

      // 1. Pickup. With no cursor the first tick skips the delta and evaluates
      // the user's query directly.
      const first = await waitForSearch(worker, tracker, "the first search", 0, () => true);
      let detail = diagnostics(worker, tracker, "first search");
      expect(first.request.filter, detail).toEqual(readyQuery(tracker));
      expect(first.request.matched, detail).toEqual([eligible.key]);

      const firstRun = await waitForSettledRun(worker, eligible.key);
      detail = diagnostics(worker, tracker, "first run");
      expect(firstRun.status, detail).toBe("succeeded");
      expect(firstRun.pr_url, detail).toBeNull();
      expect(promptMarkers(worker), detail).toEqual([eligibleMarker]);
      expect(await worker.remoteBranches(), detail).toContain(
        `feature/${eligible.key.toLowerCase()}`,
      );
      expect(
        await worker.branchFile(`feature/${eligible.key.toLowerCase()}`, "src/greeting.ts"),
        detail,
      ).toBe('export const greeting = "Hello, world!";');
      expect(await tracker.getStatus(eligible.key), detail).toBe(tracker.statuses.inProgress);
      const comments = await tracker.listComments(eligible.key);
      expect(
        comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
        detail,
      ).toHaveLength(1);

      // 2. Delta query shape: a bare `updatedAt.gt` ISO bound, 5 minutes before
      // the detection time of an earlier tick (taken just before its request).
      const delta = await waitForSearch(
        worker,
        tracker,
        "the first delta query",
        first.index + 1,
        (request) => deltaBound(request) !== undefined,
      );
      detail = diagnostics(worker, tracker, "first delta");
      const gt = deltaBound(delta.request)!;
      expect(gt, detail).toMatch(ISO_MS);
      const cursor = Date.parse(gt) + DELTA_LOOKBACK_MS;
      expect(cursor, detail).toBeLessThanOrEqual(delta.request.receivedAt);
      const previousTick = tracker.searchRequests.slice(0, delta.index).some((request) => {
        const lag = request.receivedAt - cursor;
        return lag >= 0 && lag < 1_000;
      });
      expect(previousTick, detail).toBe(true);
      // The worker's own transition and comment are inside the window.
      expect(delta.request.matched, detail).toContain(eligible.key);
      // Every non-delta search is the user's query, never a merged filter.
      for (const request of tracker.searchRequests) {
        if (deltaBound(request) === undefined) {
          expect(request.filter, detail).toEqual(readyQuery(tracker));
        }
      }

      // 3. No re-run while unchanged: each tick re-evaluates (the window still
      // covers the worker's own writes) but the issue left the ready state.
      await assertIdleTicks(worker, tracker, "after the first run");
      expect(worker.runRecords(eligible.key), detail).toHaveLength(1);
      expect(worker.runRecords(followUp.key), detail).toEqual([]);

      // 4. Re-arm: a human moves the follow-up into the ready state.
      tracker.moveTicket(followUp.key, tracker.statuses.todo);
      const secondRun = await waitForSettledRun(worker, followUp.key);
      detail = diagnostics(worker, tracker, "re-armed run");
      expect(secondRun.status, detail).toBe("succeeded");
      expect(await tracker.getStatus(followUp.key), detail).toBe(tracker.statuses.inProgress);
      await assertIdleTicks(worker, tracker, "after the re-armed run");
      expect(worker.runRecords(followUp.key), detail).toHaveLength(1);
      expect(worker.runRecords(eligible.key), detail).toHaveLength(1);
      expect(promptMarkers(worker), detail).toEqual([eligibleMarker, followUpMarker]);

      // 5. Cursor persistence across a graceful restart on the same queue DB.
      await restartAndAssertCursor(worker, tracker);
      await assertIdleTicks(worker, tracker, "after restart");

      detail = diagnostics(worker, tracker, "final");
      expect(worker.runRecords(), detail).toHaveLength(2);
      expect(promptMarkers(worker), detail).toEqual([eligibleMarker, followUpMarker]);
      // The decoy was never run, moved, commented on, or branched.
      expect(tracker.updatedAt(decoy.key), detail).toBe(decoyStamp);
      expect(await tracker.getStatus(decoy.key), detail).toBe(BACKLOG);
      expect(await tracker.listComments(decoy.key), detail).toEqual([]);
      expect(worker.runRecords(decoy.key), detail).toEqual([]);
      expect(await worker.remoteBranches(), detail).not.toContain(
        `feature/${decoy.key.toLowerCase()}`,
      );
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
  "worker Linear polling dedupes an unchanged ready issue by (key, updatedAt) across polls and restart",
  async () => {
    const tracker = new FakeLinearTracker({ clock: "wall" });
    // Fixture default args include `--skip-comments`: the run makes no tracker
    // writes, so the processed issue keeps matching the query with the same
    // `updatedAt`, and only the `(key, updated)` gates (the no-PR actioned
    // marker, then the processed-update dedupe) can stop a re-run.
    const worker = fixtureFor(tracker);
    let failure: unknown;
    try {
      const marker = uniqueMarker();
      const eligible = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      const stamp = tracker.updatedAt(eligible.key);

      await worker.prepare();
      worker.start();
      await worker.waitForReady();

      const firstRun = await waitForSettledRun(worker, eligible.key);
      let detail = diagnostics(worker, tracker, "first run");
      expect(firstRun.status, detail).toBe("succeeded");
      expect(tracker.updatedAt(eligible.key), detail).toBe(stamp);
      expect(await tracker.getStatus(eligible.key), detail).toBe(tracker.statuses.todo);

      // A successful run with no PR (bare remote) records an actioned marker, so
      // the actioned gate skips the issue before the processed-update dedupe.
      const skipLine = `skipping ${eligible.key} (already actioned; no change since the PR)`;
      await assertIdleTicks(worker, tracker, "after the first run");
      detail = diagnostics(worker, tracker, "idle");
      // The evaluate step still returned the issue; the actioned gate skipped it.
      expect(worker.logs, detail).toContain(skipLine);
      const evaluations = tracker.searchRequests.filter(
        (request) => deltaBound(request) === undefined,
      );
      expect(evaluations.at(-1)?.matched, detail).toEqual([eligible.key]);

      await restartAndAssertCursor(worker, tracker);
      await assertIdleTicks(worker, tracker, "after restart");
      detail = diagnostics(worker, tracker, "after restart");
      // The actioned marker survived the restart: same stamp, same skip.
      expect(worker.logs, detail).toContain(skipLine);
      expect(worker.runRecords(eligible.key), detail).toHaveLength(1);

      // A human edit bumps `updatedAt` past the actioned marker: one more run.
      const followUpMarker = uniqueMarker();
      await tracker.editTicket(eligible.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! Also keep it short.\n\n${followUpMarker}\n`,
      });
      await worker.waitFor(
        "the edited issue to run again",
        () =>
          worker.runRecords(eligible.key).filter((run) => run.status !== "in_progress").length >= 2
            ? true
            : undefined,
        60_000,
      );
      await assertIdleTicks(worker, tracker, "after the edit-triggered run");

      detail = diagnostics(worker, tracker, "final");
      expect(worker.runRecords(eligible.key), detail).toHaveLength(2);
      expect(
        worker.agentInvocations().map((invocation) => invocation.mode),
        detail,
      ).toEqual(["implement", "implement"]);
      expect(promptMarkers(worker).at(-1), detail).toBe(followUpMarker);
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
