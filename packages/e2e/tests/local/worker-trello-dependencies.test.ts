/**
 * Worker dependency gate on Trello's `Depends on:` description line, fully offline.
 *
 * Trello has no native blockers. `TrelloTaskTrackerClient.getBlockers`
 * (packages/code/src/lib/trackers/trello/trello-task-tracker-client.ts) reads
 * the dependent card (`getCardWithDetails`), parses its `desc` with
 * `extractDependsOn(desc, toTrelloCardKey)`, and reads every named card with
 * `TrelloClient.getCardStatus` (`GET /1/cards/:id?fields=id,shortLink,closed
 * &list=true&list_fields=name`). A blocker is done once it is archived or in a
 * list named Done/Complete(d)/Closed; a 404 is `not found`. The fleet executor
 * calls the gate (tracker-dependency-gate.ts) before it touches git, so a held
 * card is never started, moved, or commented on, and `worker queue --json`
 * lists it as a `tracker` item.
 *
 * Trello detection runs through `GET /1/boards/:id/actions`: releasing a
 * blocker is itself a board action, and each scenario then edits the
 * dependent so its new `dateLastActivity` stamp re-checks it at once instead
 * of sleeping through the waiting backoff (task-polling.ts).
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { throwCleanupFailures } from "../../helpers/cleanup";
import type { CleanupFailure } from "../../helpers/cleanup";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeTrelloTracker } from "../../providers/fake-trello";

const POLL_INTERVAL_SECONDS = 1;
/** Ticks observed while a card is held; bounded by request counts, not sleeps. */
const QUIET_TICKS = 3;
/** A well-formed short link (8 characters with a digit) that no fake card has. */
const UNKNOWN_SHORT_LINK = "e2e99999";

/** The `worker queue --json` fields this suite reads (queued-work.ts `QueuedWorkItem`). */
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

function diagnostics(worker: WorkerFixture, tracker: FakeTrelloTracker, detail = ""): string {
  const env = tracker.environment();
  return redact(
    [
      detail,
      `blockerStatusRequests: ${JSON.stringify(tracker.blockerStatusRequests)}`,
      `boardActionRequests: ${tracker.boardActionRequests.length}`,
      `boardActions: ${JSON.stringify(tracker.boardActions())}`,
      `searchCount: ${tracker.searchCount}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    [env.TRELLO_API_KEY ?? "", env.TRELLO_API_TOKEN ?? ""],
  );
}

/** Commit the board's list settings to the repo base branch (see worker-trello-polling.test.ts). */
async function commitTrelloSettings(worker: WorkerFixture, tracker: FakeTrelloTracker) {
  const settingsDir = join(worker.seed, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  const settings = buildTrackerSettings("trello", tracker.projectKey(), {
    todoStatus: tracker.statuses.todo,
    inProgressStatus: tracker.statuses.inProgress,
    prStatus: tracker.statuses.pr,
  });
  writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const git = (...args: string[]) => checkedCommand(["git", ...args], worker.seed, worker.env);
  await git("add", "-f", ".devintern-code/settings.json");
  await git("commit", "-m", "Add Trello list settings");
  await git("push", "origin", worker.baseBranch);
}

/**
 * Run a scenario that owns one worker and one fake, then attempt every cleanup
 * step even after an assertion failure. A scenario failure wins; otherwise
 * cleanup failures fail the test.
 */
async function withOwnedResources(
  worker: WorkerFixture,
  tracker: FakeTrelloTracker,
  scenario: () => Promise<void>,
): Promise<void> {
  let scenarioError: unknown;
  try {
    await scenario();
  } catch (error) {
    scenarioError = error;
  }
  const failures: CleanupFailure[] = [];
  try {
    await worker.dispose();
  } catch (error) {
    failures.push({ resource: `worker:${worker.root}`, error });
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    failures.push({ resource: `fake-trello:${tracker.url}`, error });
  }
  if (scenarioError !== undefined) {
    if (failures.length > 0) {
      console.error(
        `Trello worker cleanup also failed for: ${failures.map((failure) => failure.resource).join(", ")}`,
      );
    }
    throw scenarioError;
  }
  throwCleanupFailures("Trello dependency worker cleanup failed", failures);
}

function newWorker(tracker: FakeTrelloTracker, marker: string, query: string, prefix: string) {
  return new WorkerFixture({
    tracker: "trello",
    rootPrefix: prefix,
    env: {
      ...tracker.environment(),
      E2E_EXPECT_DESCRIPTION_MARKER: marker,
      // A 500 must surface on the first attempt instead of after the
      // client's retry backoff.
      DEVINTERN_FETCH_MAX_RETRIES: "0",
    },
    // Comments and transitions enabled, so "never moved or commented on"
    // while held is a real claim, and the released run does both.
    workerTaskArgs: "--create-pr --skip-clarity-check",
    workspaceTomlExtra: [
      `task_query = ${JSON.stringify(query)}`,
      `poll_interval = ${POLL_INTERVAL_SECONDS}`,
    ].join("\n"),
  });
}

async function queueItems(worker: WorkerFixture): Promise<QueueItem[]> {
  const stdout = await checkedCommand(
    [
      process.execPath,
      cliPath,
      "worker",
      "queue",
      "--json",
      "--workspace",
      join(worker.workspaceDir, "workspace.toml"),
    ],
    worker.workspaceDir,
    worker.env,
  );
  return (JSON.parse(stdout) as { items: QueueItem[] }).items;
}

function trackerItem(items: readonly QueueItem[], key: string): QueueItem | undefined {
  return items.find((item) => item.kind === "tracker" && item.taskKey === key);
}

/** Poll `worker queue --json` until `probe` accepts the dependent's tracker item. */
async function waitForQueue(
  worker: WorkerFixture,
  tracker: FakeTrelloTracker,
  label: string,
  probe: (item: QueueItem | undefined) => boolean,
  key: string,
  timeoutMs = 30_000,
): Promise<QueueItem | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: QueueItem[] = [];
  for (;;) {
    if (worker.exitStatus !== undefined) {
      throw new Error(`worker exited while waiting for ${label}\n${diagnostics(worker, tracker)}`);
    }
    last = await queueItems(worker);
    const item = trackerItem(last, key);
    if (probe(item)) return item;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${label}; queue: ${JSON.stringify(last)}\n${diagnostics(worker, tracker)}`,
      );
    }
    await Bun.sleep(250);
  }
}

function blockerReads(tracker: FakeTrelloTracker, blockerKey: string): number {
  return tracker.blockerStatusRequests.filter((key) => key === blockerKey).length;
}

/**
 * Watch {@link QUIET_TICKS} more ticks plus at least one more blocker read of
 * `blockerKey`, and prove the dependent was not started, moved, or commented
 * on in that window.
 */
async function assertHeld(
  worker: WorkerFixture,
  tracker: FakeTrelloTracker,
  dependent: TrackerTicket,
  blockerKey: string,
): Promise<void> {
  const ticksAt = tracker.boardActionRequests.length;
  const readsAt = blockerReads(tracker, blockerKey);
  const dependentActions = tracker
    .boardActions()
    .filter((action) => action.cardShortLink === dependent.key).length;
  await worker.waitFor(
    `${QUIET_TICKS} ticks and a re-check of ${blockerKey}`,
    () =>
      tracker.boardActionRequests.length >= ticksAt + QUIET_TICKS &&
      blockerReads(tracker, blockerKey) > readsAt
        ? true
        : undefined,
    30_000,
  );
  const detail = diagnostics(worker, tracker, `held window from tick ${ticksAt}`);
  expect(worker.runRecords(dependent.key), detail).toEqual([]);
  expect(worker.agentInvocations(), detail).toEqual([]);
  expect(await tracker.getStatus(dependent.key), detail).toBe(tracker.statuses.todo);
  expect(await tracker.listComments(dependent.key), detail).toEqual([]);
  expect(
    tracker.boardActions().filter((action) => action.cardShortLink === dependent.key),
    detail,
  ).toHaveLength(dependentActions);
}

/** Wait for exactly one settled, successful run of the released dependent. */
async function assertRunsOnce(
  worker: WorkerFixture,
  tracker: FakeTrelloTracker,
  dependent: TrackerTicket,
): Promise<void> {
  const runs = await worker.waitFor(
    `${dependent.key}'s released run to settle`,
    () => {
      const records = worker.runRecords(dependent.key);
      return records.length > 0 && records.every((record) => record.status !== "in_progress")
        ? records
        : undefined;
    },
    90_000,
  );
  let detail = diagnostics(worker, tracker);
  expect(
    runs.map((record) => record.status),
    detail,
  ).toEqual(["succeeded"]);
  expect(worker.agentInvocations(), detail).toEqual([{ mode: "implement" }]);
  await worker.waitFor("the released run's implementation comment", () =>
    tracker
      .boardActions()
      .some((action) => action.cardShortLink === dependent.key && action.type === "commentCard")
      ? true
      : undefined,
  );
  await waitForQueue(
    worker,
    tracker,
    `${dependent.key} to leave the queue`,
    (item) => item === undefined,
    dependent.key,
  );
  // The released run moved the card out of the query, so later ticks (the
  // run's own move and comment are new board actions) do not start it again.
  const ticksAt = tracker.boardActionRequests.length;
  await worker.waitFor(
    `${QUIET_TICKS} ticks after the released run`,
    () => (tracker.boardActionRequests.length >= ticksAt + QUIET_TICKS ? true : undefined),
    30_000,
  );
  detail = diagnostics(worker, tracker);
  expect(worker.runRecords(dependent.key), detail).toHaveLength(1);
  expect(worker.agentInvocations(), detail).toHaveLength(1);
  expect(await tracker.getStatus(dependent.key), detail).toBe(tracker.statuses.inProgress);
  expect(
    (await tracker.listComments(dependent.key)).some((comment) =>
      comment.body.includes(IMPLEMENTATION_COMMENT_MARKER),
    ),
    detail,
  ).toBe(true);
  expect(tracker.unexpectedRequests, detail).toEqual([]);
  expect(
    tracker.requests.every((request) => request.credentialsMatched),
    detail,
  ).toBe(true);
}

function dependentBody(marker: string, dependsOn: string, extra = ""): string {
  return [
    "# Expand the greeting",
    "",
    `Change the greeting to Hello, world! and run bun test.${extra}`,
    "",
    `Depends on: ${dependsOn}`,
    "",
    marker,
    "",
  ].join("\n");
}

async function startWorker(worker: WorkerFixture, tracker: FakeTrelloTracker): Promise<void> {
  await worker.prepare();
  await commitTrelloSettings(worker, tracker);
  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(
    /🔎 Polling trello every 1s/,
    20_000,
    "Trello polling acquirer startup",
  );
}

/**
 * Scenario shared by the two release paths: DEP names BLK, BLK sits in an
 * open list, DEP is held across several ticks, then `release` resolves BLK
 * and an edit of DEP re-checks it, and DEP runs exactly once.
 */
async function heldThenReleased(input: {
  prefix: string;
  dependsOn: (blocker: TrackerTicket) => string;
  release: (tracker: FakeTrelloTracker, blocker: TrackerTicket) => Promise<void>;
}): Promise<void> {
  const marker = `E2ETRELLODEP${crypto.randomUUID().replace(/-/g, "")}`;
  const tracker = new FakeTrelloTracker();
  const query = `list:"${tracker.statuses.todo}" is:open ${marker}`;
  const worker = newWorker(tracker, marker, query, input.prefix);
  await withOwnedResources(worker, tracker, async () => {
    // BLK is outside the query (no marker) and in an open list.
    const blocker = await tracker.createTicket({
      title: "Add the greeting module",
      body: "# Add the greeting module\n\nThe blocker; outside the worker query.\n",
    });
    await tracker.updateTicket(blocker.key, { listName: tracker.statuses.inProgress });
    const dependsOn = input.dependsOn(blocker);
    const dependent = await tracker.createTicket({
      title: "Expand the greeting",
      body: dependentBody(marker, dependsOn),
    });
    expect(await tracker.findTickets(query)).toEqual([dependent]);

    await startWorker(worker, tracker);

    const held = await waitForQueue(
      worker,
      tracker,
      `${dependent.key} held on ${blocker.key}`,
      (item) => item?.dependencyState === "waiting",
      dependent.key,
    );
    let detail = diagnostics(worker, tracker, `queue item: ${JSON.stringify(held)}`);
    expect(held?.tracker, detail).toBe("trello");
    expect(held?.dependsOn, detail).toEqual([blocker.key]);
    expect(held?.dependencyReason, detail).toContain(blocker.key);
    expect(held?.dependencyReason, detail).toBe(
      `${blocker.key} not done (${tracker.statuses.inProgress})`,
    );
    await assertHeld(worker, tracker, dependent, blocker.key);
    // The gate read the blocker's status, not just the dependent's card.
    expect(blockerReads(tracker, blocker.key), detail).toBeGreaterThanOrEqual(2);

    // --- Release: resolve BLK (a board action), then edit DEP. ---
    await input.release(tracker, blocker);
    await tracker.updateTicket(dependent.key, {
      body: dependentBody(marker, dependsOn, " Keep the diff to one file."),
    });
    await assertRunsOnce(worker, tracker, dependent);
    detail = diagnostics(worker, tracker);
    expect(worker.runRecords(blocker.key), detail).toEqual([]);
  });
}

test.skipIf(!existsSync(cliPath))(
  "Trello Depends-on card URL holds the dependent until the blocker is in a Done list",
  () =>
    heldThenReleased({
      prefix: "devintern-e2e-worker-trello-dep-done-",
      dependsOn: (blocker) => `https://trello.com/c/${blocker.key}`,
      release: (tracker, blocker) =>
        tracker.updateTicket(blocker.key, { listName: tracker.statuses.done }),
    }),
  240_000,
);

test.skipIf(!existsSync(cliPath))(
  "Trello Depends-on bare short link holds the dependent until the blocker is archived",
  () =>
    heldThenReleased({
      prefix: "devintern-e2e-worker-trello-dep-archive-",
      // Fake short links (`e2e00001`) are 8 characters with a digit, the
      // shape `toTrelloCardKey` accepts without a URL.
      dependsOn: (blocker) => blocker.key,
      release: (tracker, blocker) => tracker.closeTicket(blocker.key),
    }),
  240_000,
);

test.skipIf(!existsSync(cliPath))(
  "Trello Depends-on unknown card waits as not found; a failed blocker read fails closed",
  async () => {
    const marker = `E2ETRELLODEPFAIL${crypto.randomUUID().replace(/-/g, "")}`;
    const tracker = new FakeTrelloTracker();
    const query = `list:"${tracker.statuses.todo}" is:open ${marker}`;
    const worker = newWorker(tracker, marker, query, "devintern-e2e-worker-trello-dep-fail-");
    await withOwnedResources(worker, tracker, async () => {
      // BLK is already done, so only the read failure can hold DEP in (b).
      const blocker = await tracker.createTicket({
        title: "Add the greeting module",
        body: "# Add the greeting module\n\nThe blocker; outside the worker query.\n",
      });
      await tracker.updateTicket(blocker.key, { listName: tracker.statuses.done });
      const dependent = await tracker.createTicket({
        title: "Expand the greeting",
        body: dependentBody(marker, UNKNOWN_SHORT_LINK),
      });

      await startWorker(worker, tracker);

      // --- (a) A short link that matches no card waits as `not found`. ---
      const missing = await waitForQueue(
        worker,
        tracker,
        `${dependent.key} waiting on unknown ${UNKNOWN_SHORT_LINK}`,
        (item) => item?.dependencyState === "waiting",
        dependent.key,
      );
      let detail = diagnostics(worker, tracker, `queue item: ${JSON.stringify(missing)}`);
      expect(missing?.dependsOn, detail).toEqual([UNKNOWN_SHORT_LINK]);
      expect(missing?.dependencyReason, detail).toContain(UNKNOWN_SHORT_LINK);
      expect(missing?.dependencyReason, detail).toContain("not found");
      await worker.waitForOutput(
        new RegExp(`${dependent.key} names blockers trello cannot find: ${UNKNOWN_SHORT_LINK}`),
        10_000,
        "the unknown-blocker warning",
      );
      expect(tracker.blockerStatusRequests, detail).toContain(UNKNOWN_SHORT_LINK);
      await assertHeld(worker, tracker, dependent, UNKNOWN_SHORT_LINK);

      // --- (b) The blocker read answers HTTP 500: fail closed. ---
      tracker.failBlockerStatusReads(500);
      const readsBeforeFailure = blockerReads(tracker, blocker.key);
      await tracker.updateTicket(dependent.key, {
        body: dependentBody(marker, `https://trello.com/c/${blocker.key}`),
      });
      const failedRead = await waitForQueue(
        worker,
        tracker,
        `${dependent.key} waiting on a failed blocker read`,
        (item) => item?.dependencyReason?.startsWith("could not read") === true,
        dependent.key,
      );
      detail = diagnostics(worker, tracker, `queue item: ${JSON.stringify(failedRead)}`);
      expect(failedRead?.dependencyState, detail).toBe("waiting");
      expect(failedRead?.dependencyReason, detail).toContain(
        `could not read ${dependent.key}'s blockers from trello:`,
      );
      expect(failedRead?.dependencyReason, detail).toContain("500");
      expect(blockerReads(tracker, blocker.key), detail).toBeGreaterThan(readsBeforeFailure);
      await worker.waitForOutput(
        new RegExp(`${dependent.key} waiting: could not read ${dependent.key}'s blockers`),
        10_000,
        "the fail-closed warning",
      );
      await assertHeld(worker, tracker, dependent, blocker.key);

      // --- Recovery: reads succeed again; BLK is done, so DEP runs once. ---
      tracker.restoreBlockerStatusReads();
      await tracker.updateTicket(dependent.key, {
        body: dependentBody(
          marker,
          `https://trello.com/c/${blocker.key}`,
          " Keep the diff to one file.",
        ),
      });
      await assertRunsOnce(worker, tracker, dependent);
    });
  },
  240_000,
);
