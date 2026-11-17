/**
 * Worker Trello polling through the board actions feed, fully offline.
 *
 * Trello change detection does not use card search: `createTrelloChangeDetector`
 * (packages/code/src/lib/acquirers/change-detector.ts) reads
 * `GET /1/boards/:id/actions`, starting with a null cursor (drain the backlog)
 * and then passing `since=<newest action id>`. Only when that feed is
 * non-empty does `TaskPollingAcquirer.tick` (task-polling.ts) re-run the
 * configured `task_query` through `/1/search` and dedupe by
 * `task:<key>:<updated>`. The fake Trello server records every board actions
 * request, so the test asserts the real cursor sequence instead of log text.
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
import type { WorkerRunRecord } from "../../helpers/worker";
import { FakeTrelloTracker } from "../../providers/fake-trello";

const POLL_INTERVAL_SECONDS = 1;
/** Ticks observed for "nothing changed" windows; bounded by event counts, not sleeps. */
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

function diagnostics(worker: WorkerFixture, tracker: FakeTrelloTracker, detail = ""): string {
  const env = tracker.environment();
  return redact(
    [
      detail,
      `boardActionRequests: ${JSON.stringify(tracker.boardActionRequests)}`,
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

/**
 * Commit the board's list settings to the repo base branch.
 *
 * `loadProjectSettings` reads `<cwd>/.devintern-code/settings.json`, and a
 * worker task runs in its repo worktree, so the file must be in the checkout.
 * It is gitignored in the fixture, hence `add -f`.
 */
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
 * step even after an assertion failure. A scenario failure wins (cleanup
 * failures are still printed with their resource names); otherwise cleanup
 * failures fail the test.
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
    // Graceful SIGTERM stop of the daemon and its task children, then rm -rf
    // of the fixture's own temp root (HOME, workspace, queue.db, bare remote).
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
  throwCleanupFailures("Trello worker cleanup failed", failures);
}

function settledRuns(worker: WorkerFixture, key: string, count: number) {
  const records = worker.runRecords(key);
  if (records.length < count) return undefined;
  return records.every((record) => record.status !== "in_progress") ? records : undefined;
}

/**
 * Wait until the detector holds the newest board action as its cursor, then
 * watch {@link QUIET_TICKS} more ticks and prove none of them evaluated or ran.
 */
async function assertQuietTicks(
  worker: WorkerFixture,
  tracker: FakeTrelloTracker,
  key: string,
  expectedRuns: number,
): Promise<void> {
  const newest = tracker.newestActionId();
  expect(newest, diagnostics(worker, tracker)).toBeDefined();
  const caughtUpAt = await worker.waitFor(
    `the detector cursor to reach action ${newest}`,
    () => {
      const requests = tracker.boardActionRequests;
      for (let index = requests.length - 1; index >= 0; index--) {
        if (requests[index]?.since === newest) return index;
      }
      return undefined;
    },
    20_000,
  );
  // The tick that sent `since=newest` may still be finishing; count from the
  // next request so its evaluation (if any) cannot leak into the window.
  const start = caughtUpAt + 1;
  await worker.waitFor(
    "the first tick after the cursor caught up",
    () => (tracker.boardActionRequests.length > start ? true : undefined),
    10_000,
  );
  const searchesBefore = tracker.searchCount;
  const quietStart = tracker.boardActionRequests.length;
  await worker.waitFor(
    `${QUIET_TICKS} quiet ticks`,
    () => (tracker.boardActionRequests.length >= quietStart + QUIET_TICKS ? true : undefined),
    20_000,
  );
  const detail = diagnostics(worker, tracker, `quiet window from request ${quietStart}`);
  // No new actions: every tick sends the same cursor, gets an empty feed, and
  // skips the evaluate step entirely (no /search request).
  expect(tracker.newestActionId(), detail).toBe(newest);
  expect(
    tracker.boardActionRequests.slice(start).every((request) => request.since === newest),
    detail,
  ).toBe(true);
  expect(tracker.searchCount, detail).toBe(searchesBefore);
  expect(worker.runRecords(key), detail).toHaveLength(expectedRuns);
  expect(worker.agentInvocations(), detail).toHaveLength(expectedRuns);
}

test.skipIf(!existsSync(cliPath))(
  "worker polls Trello through the board actions feed: drains once, idles on since, re-runs on a new action",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const marker = `E2ETRELLOPOLL${token}`;
    const tracker = new FakeTrelloTracker();
    // `list:` keeps the query to ready cards; the marker scopes it to this card.
    const query = `list:"${tracker.statuses.todo}" is:open ${marker}`;
    const worker = new WorkerFixture({
      tracker: "trello",
      rootPrefix: "devintern-e2e-worker-trello-",
      env: { ...tracker.environment(), E2E_EXPECT_DESCRIPTION_MARKER: marker },
      // Comments and transitions enabled, so the worker's own list move and
      // implementation comment land on the board actions feed.
      workerTaskArgs: "--create-pr --skip-clarity-check",
      workspaceTomlExtra: [
        `task_query = ${JSON.stringify(query)}`,
        `poll_interval = ${POLL_INTERVAL_SECONDS}`,
      ].join("\n"),
    });
    await withOwnedResources(worker, tracker, async () => {
      // Backlog present before the worker starts: a decoy on the same board
      // outside the query, and the eligible card.
      const decoy = await tracker.createTicket({
        title: "Expand the greeting (decoy)",
        body: "# Decoy\n\nSame board, same list, but outside the worker query.\n",
      });
      const card = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`,
      });
      const backlogNewest = tracker.newestActionId();

      await worker.prepare();
      await commitTrelloSettings(worker, tracker);
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /🔎 Polling trello every 1s/,
        20_000,
        "Trello polling acquirer startup",
      );

      // --- First tick: null cursor drains the backlog. ---
      const firstRuns = await worker.waitFor(
        "the eligible card's first run to settle",
        () => settledRuns(worker, card.key, 1),
        90_000,
      );
      let detail = diagnostics(worker, tracker);
      const first = tracker.boardActionRequests[0];
      expect(first, detail).toEqual({ since: null, filter: null, limit: "50" });
      expect(firstRuns, detail).toHaveLength(1);
      expect(firstRuns[0]?.status, detail).toBe("succeeded");
      expect(firstRuns[0]?.branch, detail).toBe(`feature/${card.key.toLowerCase()}`);
      expect(worker.runRecords(decoy.key), detail).toEqual([]);
      expect(worker.agentInvocations(), detail).toEqual([{ mode: "implement" }]);
      expect(await worker.branchFile(`feature/${card.key.toLowerCase()}`, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );

      // The run wrote to the board itself: moved the card to the in-progress
      // list and posted the implementation comment, both new board actions.
      await worker.waitFor("the worker's own board actions", () => {
        const comments = tracker
          .boardActions()
          .filter((action) => action.cardShortLink === card.key && action.type === "commentCard");
        return comments.length > 0 ? true : undefined;
      });
      detail = diagnostics(worker, tracker);
      expect(await tracker.getStatus(card.key), detail).toBe(tracker.statuses.inProgress);
      const comments = await tracker.listComments(card.key);
      expect(
        comments.some((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
        detail,
      ).toBe(true);
      const ownActions = tracker
        .boardActions()
        .filter((action) => backlogNewest !== undefined && action.id > backlogNewest);
      expect(
        ownActions.map((action) => action.type),
        detail,
      ).toEqual(expect.arrayContaining(["updateCard", "commentCard"]));
      expect(
        ownActions.every((action) => action.cardShortLink === card.key),
        detail,
      ).toBe(true);
      // The decoy was never touched.
      expect(await tracker.getStatus(decoy.key), detail).toBe(tracker.statuses.todo);
      expect(await tracker.listComments(decoy.key), detail).toEqual([]);

      // --- Later ticks: since=<newest action id>, empty feed, no evaluate. ---
      // The worker's own move and comment are new actions, so the detector
      // reports a change and the query is re-evaluated, but nothing re-runs:
      // no PR exists on the local bare remote, so the actioned gate
      // (actioned-transition.ts runs only after PR creation) does not apply,
      // and the card's `updated` stamp changed, so `(key, updated)` dedupe
      // alone would not stop it. What keeps it out is the evaluate step itself:
      // the in-progress transition moved the card out of `list:"To Do"`, so
      // `searchTasks(query)` no longer returns it (task-polling.ts tick()).
      expect(await tracker.findTickets(query), detail).toEqual([]);
      await assertQuietTicks(worker, tracker, card.key, 1);
      expect(tracker.boardActionRequests.slice(1).some((request) => request.since !== null)).toBe(
        true,
      );

      // --- A new action re-arms the card: exactly one more run. ---
      const searchesBeforeEdit = tracker.searchCount;
      const cursorBeforeEdit = tracker.newestActionId();
      await tracker.updateTicket(card.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test. Keep the diff to one file.\n\n${marker}\n`,
        listName: tracker.statuses.todo,
      });
      const editActionId = tracker.newestActionId();
      expect(editActionId, diagnostics(worker, tracker)).not.toBe(cursorBeforeEdit);
      await worker.waitFor(
        "a tick that reads the edit through since=<previous cursor>",
        () =>
          tracker.boardActionRequests.some((request) => request.since === cursorBeforeEdit) &&
          tracker.searchCount > searchesBeforeEdit
            ? true
            : undefined,
        20_000,
      );
      const secondRuns = await worker.waitFor(
        "the edited card's second run to settle",
        () => settledRuns(worker, card.key, 2),
        90_000,
      );
      detail = diagnostics(worker, tracker);
      expect(secondRuns, detail).toHaveLength(2);
      expect(
        secondRuns.map((record: WorkerRunRecord) => record.status),
        detail,
      ).toEqual(["succeeded", "succeeded"]);
      expect(worker.runRecords(decoy.key), detail).toEqual([]);

      await assertQuietTicks(worker, tracker, card.key, 2);
      expect(tracker.unexpectedRequests, diagnostics(worker, tracker)).toEqual([]);
      expect(
        tracker.requests.every((request) => request.credentialsMatched),
        diagnostics(worker, tracker),
      ).toBe(true);
    });
  },
  // Two runs (each well under 90s), readiness, and a 25s+5s graceful stop.
  240_000,
);

test.skipIf(!existsSync(cliPath))(
  "worker refuses Trello polling without TRELLO_DEFAULT_BOARD_ID and runs no cards",
  async () => {
    const tracker = new FakeTrelloTracker();
    const { TRELLO_DEFAULT_BOARD_ID: _boardId, ...env } = tracker.environment();
    const query = `list:"${tracker.statuses.todo}" is:open`;
    const worker = new WorkerFixture({
      tracker: "trello",
      rootPrefix: "devintern-e2e-worker-trello-noboard-",
      env,
      workspaceTomlExtra: [
        `task_query = ${JSON.stringify(query)}`,
        `poll_interval = ${POLL_INTERVAL_SECONDS}`,
      ].join("\n"),
    });
    await withOwnedResources(worker, tracker, async () => {
      const card = await tracker.createTicket({
        title: "Expand the greeting",
        body: "# Expand the greeting\n\nReady card that must not run without a board id.\n",
      });
      await worker.prepare();
      worker.start();
      // createChangeDetector returns null without TRELLO_DEFAULT_BOARD_ID
      // (change-detector.ts), and a workspace with a task_query treats a null
      // detector as a startup error (workspace-worker.ts), so the worker exits
      // instead of silently never polling.
      const deadline = Date.now() + 30_000;
      while (worker.exitStatus === undefined && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      const detail = diagnostics(worker, tracker);
      expect(worker.exitStatus, detail).toBeDefined();
      expect(worker.exitStatus, detail).not.toBe(0);
      expect(worker.logs, detail).toContain("Could not initialize the trello change detector");
      expect(worker.logs, detail).not.toContain("🔎 Polling trello");
      expect(tracker.boardActionRequests, detail).toEqual([]);
      expect(tracker.searchCount, detail).toBe(0);
      expect(worker.runRecords(card.key), detail).toEqual([]);
      expect(worker.agentInvocations(), detail).toEqual([]);
      expect(await tracker.getStatus(card.key), detail).toBe(tracker.statuses.todo);
      expect(await tracker.listComments(card.key), detail).toEqual([]);
    });
  },
  60_000,
);
