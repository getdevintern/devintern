/**
 * Worker Mode 1 polling against Asana's Events API, fully offline.
 *
 * Production wiring: `createChangeDetector("asana")` builds
 * `createAsanaChangeDetector` over `AsanaClient.getEvents(projectGid, sync)`
 * (packages/code/src/lib/acquirers/change-detector.ts,
 * packages/task-trackers/src/clients/asana.ts). A 412 (no or expired token) is
 * a full sync and counts as "changed"; a 200 page counts only when it has
 * events. The evaluate step re-runs `[defaults].task_query` and dedupes by
 * `(key, updated)` (packages/code/src/lib/acquirers/task-polling.ts).
 *
 * Every resource is local: a loopback fake Asana, a bare Git remote, the
 * deterministic agent, and a per-test temporary HOME/workspace/queue.db.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeAsanaTracker } from "../../providers/fake-asana";
import type { FakeAsanaSyncRequest } from "../../providers/fake-asana";
import type { TrackerTicket } from "../../providers/tracker";

const POLL_INTERVAL_SECONDS = 1;
/** Idle ticks observed per quiet window: enough to prove no evaluate or re-run. */
const IDLE_TICKS = 3;

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "[redacted]");
    redacted = redacted.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return redacted;
}

function diagnostics(worker: WorkerFixture, tracker: FakeAsanaTracker, detail = ""): string {
  const token = tracker.environment().ASANA_API_TOKEN ?? "";
  return redact(
    [
      detail,
      `sync requests: ${JSON.stringify(tracker.syncRequests)}`,
      `evaluations: ${tracker.projectTaskListings.length}`,
      `events: ${JSON.stringify(tracker.eventLog().map((event) => `${event.type}:${event.action}:${event.resource.gid}`))}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    [token],
  );
}

/**
 * Commit the Asana section names to the seeded repo.
 *
 * The task child reads `.devintern-code/settings.json` from its worktree cwd
 * (`loadProjectSettings` in packages/code/src/lib/config/project-settings.ts),
 * so the file must travel with the repository, as it does in production.
 */
async function commitAsanaSettings(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
): Promise<void> {
  const settingsDir = join(worker.seed, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(
      buildTrackerSettings("asana", tracker.projectKey(), {
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
  await git("commit", "-m", "Configure Asana sections");
  await git("push", "origin", worker.baseBranch);
}

function workspaceToml(query: string): string {
  return [`task_query = ${JSON.stringify(query)}`, `poll_interval = ${POLL_INTERVAL_SECONDS}`].join(
    "\n",
  );
}

/** Prompt markers the deterministic agent saw, in invocation order. */
function promptMarkers(worker: WorkerFixture): string[] {
  return worker
    .agentInvocations()
    .flatMap((invocation) => (invocation as { promptMarkers?: string[] }).promptMarkers ?? []);
}

/** Wait until one polled task has a settled run record. */
async function waitForSettledRun(worker: WorkerFixture, key: string, timeoutMs = 60_000) {
  return await worker.waitFor(
    `the polled run for ${key} to settle`,
    () => worker.runRecords(key).find((run) => run.status !== "in_progress"),
    timeoutMs,
  );
}

/** Wait for a sync request after `from` that satisfies `predicate`. */
async function waitForSyncRequest(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
  label: string,
  from: number,
  predicate: (request: FakeAsanaSyncRequest) => boolean,
  timeoutMs = 20_000,
): Promise<{ request: FakeAsanaSyncRequest; index: number }> {
  return await worker.waitFor(
    label,
    () => {
      for (let index = from; index < tracker.syncRequests.length; index++) {
        const request = tracker.syncRequests[index]!;
        if (predicate(request)) return { request, index };
      }
      return undefined;
    },
    timeoutMs,
  );
}

/**
 * Wait until the worker has consumed every pending event (a 200 page with no
 * events), then observe {@link IDLE_TICKS} more ticks and prove each presents
 * the token the previous response issued, returns an empty page, and causes
 * neither an evaluate query nor a run.
 */
async function assertIdleTicks(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
  label: string,
): Promise<void> {
  const quiet = await waitForSyncRequest(
    worker,
    tracker,
    `${label}: an empty events page`,
    tracker.syncRequests.length,
    (request) => request.status === 200 && request.eventCount === 0,
  );
  const evaluations = tracker.projectTaskListings.length;
  const runs = worker.runRecords().length;
  const invocations = worker.agentInvocations().length;
  const start = quiet.index;
  await worker.waitFor(
    `${label}: ${IDLE_TICKS} idle ticks`,
    () => (tracker.syncRequests.length > start + IDLE_TICKS ? true : undefined),
    (IDLE_TICKS + 10) * POLL_INTERVAL_SECONDS * 1000,
  );
  const detail = diagnostics(worker, tracker, label);
  const window = tracker.syncRequests.slice(start, start + IDLE_TICKS + 1);
  for (let index = 1; index < window.length; index++) {
    // The rotated token from the previous response is the next cursor.
    expect(window[index]?.received, detail).toBe(window[index - 1]!.issued);
    expect(window[index]?.status, detail).toBe(200);
    expect(window[index]?.eventCount, detail).toBe(0);
  }
  // Empty pages do not trigger the evaluate step or any run.
  expect(tracker.projectTaskListings.length, detail).toBe(evaluations);
  expect(worker.runRecords().length, detail).toBe(runs);
  expect(worker.agentInvocations().length, detail).toBe(invocations);
}

/**
 * Expire every token and prove the next tick takes the 412 full-sync path:
 * the stale token is rejected, the worker re-evaluates the query, recovers on
 * the fresh token, and starts no run.
 */
async function assertExpiredTokenRecovery(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
): Promise<void> {
  const runs = worker.runRecords().length;
  const invocations = worker.agentInvocations().length;
  const evaluations = tracker.projectTaskListings.length;
  const mark = tracker.syncRequests.length;
  const issuedBefore = new Set(tracker.syncRequests.map((request) => request.issued));
  tracker.expireSyncTokens();

  const rejected = await waitForSyncRequest(
    worker,
    tracker,
    "a 412 for the expired token",
    mark,
    (request) => request.status === 412,
  );
  // The worker presented a previously issued (now expired) token, not none.
  expect(rejected.request.received, diagnostics(worker, tracker)).not.toBeNull();
  expect(issuedBefore.has(rejected.request.received ?? ""), diagnostics(worker, tracker)).toBe(
    true,
  );
  const recovered = await waitForSyncRequest(
    worker,
    tracker,
    "the worker to resume on the 412's fresh token",
    rejected.index + 1,
    (request) => request.received === rejected.request.issued,
  );
  expect(recovered.request.status, diagnostics(worker, tracker)).toBe(200);

  const detail = diagnostics(worker, tracker, "expired-token recovery");
  // Full sync means the gap is unknown: the worker re-ran the query.
  expect(tracker.projectTaskListings.length, detail).toBeGreaterThan(evaluations);
  expect(worker.runRecords().length, detail).toBe(runs);
  expect(worker.agentInvocations().length, detail).toBe(invocations);
  expect(worker.logs, detail).not.toContain("polling tick failed");
  expect(worker.running, detail).toBe(true);
}

/** Stop the worker and fake independently; report anything left behind. */
async function cleanup(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
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
    residue.push(`fake Asana server: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (residue.length === 0) return failure;
  const residueError = new Error(`Cleanup left residue:\n${residue.join("\n")}`);
  if (failure) {
    console.error(residueError.message);
    return failure;
  }
  return residueError;
}

function uniqueToken(): string {
  return crypto.randomUUID().replace(/-/g, "").toUpperCase();
}

test.skipIf(!existsSync(cliPath))(
  "worker polls Asana via Events API sync tokens: 412 handshake, rotation, edits, expiry, no self-loop",
  async () => {
    const token = uniqueToken();
    const selector = `E2EASANAPOLL${token}`;
    const query = `section:"To Do" ${selector}`;
    const tracker = new FakeAsanaTracker();
    const worker = new WorkerFixture({
      tracker: "asana",
      env: tracker.environment(),
      // Production default `--create-pr`, with tracker writes enabled so the
      // worker's own section move and comment reach the Events API.
      workerTaskArgs: "--create-pr --skip-clarity-check",
      workspaceTomlExtra: workspaceToml(query),
    });
    let failure: unknown;
    try {
      const eligibleMarker = `E2EPROMPTMARKER${uniqueToken()}`;
      const followUpMarker = `E2EPROMPTMARKER${uniqueToken()}`;
      const decoy: TrackerTicket = await tracker.createTicket({
        title: "Backlog grooming (decoy)",
        body: "# Decoy\n\nOutside the task query; must stay untouched.\n",
      });
      const eligible = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${eligibleMarker}\n`,
      });
      const followUp = await tracker.createTicket({
        title: "Follow-up greeting (not ready yet)",
        body: `# Follow-up\n\nChange the greeting to Hello, world!\n\n${followUpMarker}\n`,
      });
      const decoyStamp = tracker.modifiedAt(decoy.key);

      await worker.prepare();
      await commitAsanaSettings(worker, tracker);
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /Polling asana every 1s/,
        10_000,
        "the Asana polling acquirer to start",
      );

      // Tick 1: no token yet -> 412 handshake -> full sync counts as changed.
      const handshake = await waitForSyncRequest(
        worker,
        tracker,
        "the first events call",
        0,
        () => true,
      );
      expect(handshake.request, diagnostics(worker, tracker)).toMatchObject({
        resource: tracker.projectKey(),
        received: null,
        status: 412,
        authorized: true,
      });
      const first = await waitForSettledRun(worker, eligible.key);
      let detail = diagnostics(worker, tracker, "first run");
      expect(first.status, detail).toBe("succeeded");
      expect(first.pr_url, detail).toBeNull();
      expect(promptMarkers(worker), detail).toEqual([eligibleMarker]);

      // The worker's own writes generated events: the In Progress section move
      // (pipeline.ts transitions to inProgressStatus before implementing) and
      // the implementation comment (run-harness-finalize.ts).
      const events = tracker.eventLog();
      expect(
        events.some(
          (event) =>
            event.type === "task" &&
            event.resource.gid === eligible.key &&
            event.parent?.resource_type === "section",
        ),
        detail,
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "story" &&
            event.action === "added" &&
            event.parent?.gid === eligible.key,
        ),
        detail,
      ).toBe(true);
      expect(await tracker.getStatus(eligible.key), detail).toBe(tracker.statuses.inProgress);

      // Those events reach the worker as a non-empty page and are re-evaluated,
      // yet do not re-run the task: the evaluate step re-runs the user's query
      // (task-polling.ts), and the section move took the task out of
      // `section:"To Do"`. The (key, updated) stamp also changed, so dedupe alone
      // would not stop it; the query is the production rule here. (The
      // PR-actioned gate in actioned-transition.ts needs a created PR, which a
      // local bare remote cannot produce.)
      await waitForSyncRequest(
        worker,
        tracker,
        "a page carrying the worker's own events",
        handshake.index + 1,
        (request) => request.status === 200 && request.eventCount > 0,
      );
      await assertIdleTicks(worker, tracker, "after the first run");
      detail = diagnostics(worker, tracker, "after own events");
      expect(worker.runRecords(eligible.key), detail).toHaveLength(1);
      expect(worker.runRecords(decoy.key), detail).toEqual([]);
      expect(worker.runRecords(followUp.key), detail).toEqual([]);

      // A human edit makes the follow-up match the query: one event, one run.
      const beforeEdit = tracker.syncRequests.length;
      tracker.editTicket(followUp.key, { title: `Follow-up greeting ${selector}` });
      await waitForSyncRequest(
        worker,
        tracker,
        "the page carrying the edit event",
        beforeEdit,
        (request) => request.status === 200 && request.eventCount > 0,
      );
      const second = await waitForSettledRun(worker, followUp.key);
      detail = diagnostics(worker, tracker, "edit-triggered run");
      expect(second.status, detail).toBe("succeeded");
      await assertIdleTicks(worker, tracker, "after the edit-triggered run");
      detail = diagnostics(worker, tracker, "after edit");
      expect(worker.runRecords(followUp.key), detail).toHaveLength(1);
      expect(worker.runRecords(eligible.key), detail).toHaveLength(1);
      expect(promptMarkers(worker), detail).toEqual([eligibleMarker, followUpMarker]);

      // Expired token mid-run: 412 -> full re-evaluation -> no re-run, no crash.
      await assertExpiredTokenRecovery(worker, tracker);
      await assertIdleTicks(worker, tracker, "after the expired-token recovery");

      detail = diagnostics(worker, tracker, "final");
      expect(worker.runRecords(), detail).toHaveLength(2);
      expect(promptMarkers(worker), detail).toEqual([eligibleMarker, followUpMarker]);
      // Every token the worker presented is one the fake issued.
      const issued = new Set(tracker.syncRequests.map((request) => request.issued));
      for (const request of tracker.syncRequests) {
        if (request.received !== null) expect(issued.has(request.received), detail).toBe(true);
        expect(request.authorized, detail).toBe(true);
      }
      // The decoy never ran and was never written.
      expect(tracker.modifiedAt(decoy.key), detail).toBe(decoyStamp);
      expect(await tracker.getStatus(decoy.key), detail).toBe(tracker.statuses.todo);
      expect(await tracker.listComments(decoy.key), detail).toEqual([]);
      expect(tracker.unexpectedRequests, detail).toEqual([]);
      expect(worker.running, detail).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      failure = await cleanup(worker, tracker, failure);
    }
    if (failure) throw failure;
  },
  150_000,
);

test.skipIf(!existsSync(cliPath))(
  "worker Asana full resync after an expired token skips the processed unchanged task by (key, updated)",
  async () => {
    const selector = `E2EASANADEDUPE${uniqueToken()}`;
    const tracker = new FakeAsanaTracker();
    // Fixture default worker args include `--skip-comments`: the run makes no
    // tracker writes, so the processed task still matches the query with the
    // same `modified_at`, and only the `(key, updated)` dedupe can stop a re-run.
    const worker = new WorkerFixture({
      tracker: "asana",
      env: tracker.environment(),
      workspaceTomlExtra: workspaceToml(`section:"To Do" ${selector}`),
    });
    let failure: unknown;
    try {
      const marker = `E2EPROMPTMARKER${uniqueToken()}`;
      const eligible = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      const decoy = await tracker.createTicket({
        title: "Unrelated chore (decoy)",
        body: "# Decoy\n\nOutside the task query.\n",
      });
      const stamp = tracker.modifiedAt(eligible.key);

      await worker.prepare();
      worker.start();
      await worker.waitForReady();

      const first = await waitForSettledRun(worker, eligible.key);
      let detail = diagnostics(worker, tracker, "first run");
      expect(tracker.syncRequests[0], detail).toMatchObject({ received: null, status: 412 });
      expect(first.status, detail).toBe("succeeded");
      expect(tracker.modifiedAt(eligible.key), detail).toBe(stamp);
      expect(await tracker.getStatus(eligible.key), detail).toBe(tracker.statuses.todo);
      await assertIdleTicks(worker, tracker, "after the first run");

      const skipLine = `skipping ${eligible.key} (already processed at this update)`;
      const skipsBefore = worker.logs.split(skipLine).length - 1;
      await assertExpiredTokenRecovery(worker, tracker);
      // The full resync re-evaluated the still-matching task and skipped it.
      await worker.waitFor(
        "the full resync to log the dedupe skip",
        () => (worker.logs.split(skipLine).length - 1 > skipsBefore ? true : undefined),
        5_000,
      );
      await assertIdleTicks(worker, tracker, "after the expired-token recovery");

      detail = diagnostics(worker, tracker, "final");
      expect(worker.runRecords(), detail).toHaveLength(1);
      expect(promptMarkers(worker), detail).toEqual([marker]);
      expect(worker.runRecords(decoy.key), detail).toEqual([]);
      expect(tracker.unexpectedRequests, detail).toEqual([]);
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
  "worker refuses Asana polling without ASANA_DEFAULT_PROJECT_GID and never calls the Events API",
  async () => {
    const selector = `E2EASANANOPROJECT${uniqueToken()}`;
    const tracker = new FakeAsanaTracker();
    const env = tracker.environment();
    // docs/code/worker.md (Polling mode): Asana polling "requires
    // ASANA_DEFAULT_PROJECT_GID". createChangeDetector returns null without it
    // (change-detector.ts), and with a task_query configured the workspace
    // worker fails startup instead of polling (workspace-worker.ts).
    delete env.ASANA_DEFAULT_PROJECT_GID;
    const worker = new WorkerFixture({
      tracker: "asana",
      env,
      workspaceTomlExtra: workspaceToml(`section:"To Do" ${selector}`),
    });
    let failure: unknown;
    try {
      const eligible = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: "# Expand the greeting\n\nWould be eligible if polling ran.\n",
      });
      await worker.prepare();
      worker.start();
      const deadline = Date.now() + 20_000;
      while (worker.exitStatus === undefined && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      const detail = diagnostics(worker, tracker, "missing project gid");
      expect(worker.exitStatus, detail).toBeDefined();
      expect(worker.exitStatus, detail).not.toBe(0);
      expect(worker.logs, detail).toContain("Could not initialize the asana change detector");
      expect(worker.logs, detail).not.toContain("Polling asana");
      expect(tracker.syncRequests, detail).toEqual([]);
      expect(tracker.projectTaskListings, detail).toEqual([]);
      expect(worker.agentInvocations(), detail).toEqual([]);
      expect(await tracker.getStatus(eligible.key), detail).toBe(tracker.statuses.todo);
      // The secret never reaches the worker log, even on a startup failure.
      expect(worker.logs, detail).not.toContain(env.ASANA_API_TOKEN ?? "unset");
    } catch (error) {
      failure = error;
    } finally {
      failure = await cleanup(worker, tracker, failure);
    }
    if (failure) throw failure;
  },
  60_000,
);
