/**
 * Worker dependency gate on Asana task dependencies, fully offline.
 *
 * Production wiring: the fleet executor gates a routed polled ticket before it
 * touches git (packages/code/src/lib/workspace/tracker-dependency-gate.ts).
 * Asana blockers come from `AsanaTaskTrackerClient.getBlockers` →
 * `AsanaClient.listTaskDependencies` (packages/task-trackers/src/clients/asana.ts):
 * `GET /tasks/{gid}/dependencies?opt_fields=gid,name,completed&limit=100`,
 * following `next_page.offset`, with a 402 (no premium) mapped to "no
 * blockers". Any other read error fails closed: the ticket waits with
 * `could not read <key>'s blockers from asana: …`. The verdict is shown by
 * `devintern worker queue --json` as a `kind: "tracker"` item
 * (packages/code/src/lib/observability/queued-work.ts). User-facing behavior:
 * docs/code/worker.md ("Ticket dependencies").
 *
 * Every resource is local: a loopback fake Asana, a bare Git remote, the
 * deterministic agent, and a per-test temporary HOME/workspace/queue.db.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeAsanaTracker } from "../../providers/fake-asana";
import type { TrackerTicket } from "../../providers/tracker";

const POLL_INTERVAL_SECONDS = 1;
/** Gate evaluations observed while a ticket is held: "several ticks". */
const HELD_EVALUATIONS = 3;

/** The subset of a `worker queue --json` item these tests read. */
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

function diagnostics(worker: WorkerFixture, tracker: FakeAsanaTracker, detail = ""): string {
  const token = tracker.environment().ASANA_API_TOKEN ?? "";
  return redact(
    [
      detail,
      `dependency requests: ${JSON.stringify(tracker.dependencyRequests)}`,
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

/** Commit the Asana section names to the seeded repo (see worker-asana-polling). */
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

function createWorker(tracker: FakeAsanaTracker, selector: string): WorkerFixture {
  return new WorkerFixture({
    tracker: "asana",
    env: tracker.environment(),
    // Tracker writes enabled, so a gate leak would show up as a section move
    // or an implementation story on the held task.
    workerTaskArgs: "--create-pr --skip-clarity-check",
    workspaceTomlExtra: [
      `task_query = ${JSON.stringify(`section:"To Do" ${selector}`)}`,
      `poll_interval = ${POLL_INTERVAL_SECONDS}`,
    ].join("\n"),
  });
}

async function startWorker(worker: WorkerFixture, tracker: FakeAsanaTracker): Promise<void> {
  await worker.prepare();
  await commitAsanaSettings(worker, tracker);
  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(/Polling asana every 1s/, 10_000, "the Asana polling acquirer");
}

/** `devintern worker queue --json` items for one task key. */
async function queueItems(worker: WorkerFixture, taskKey: string): Promise<QueueItem[]> {
  const stdout = await checkedCommand(
    [process.execPath, cliPath, "worker", "queue", "--json", "--workspace", worker.workspaceDir],
    worker.workspaceDir,
    worker.env,
  );
  const body = JSON.parse(stdout) as { items?: QueueItem[] };
  return (body.items ?? []).filter((item) => item.taskKey === taskKey);
}

/** First-page dependencies reads for `taskGid`: one per gate evaluation. */
function evaluations(tracker: FakeAsanaTracker, taskGid: string) {
  return tracker.dependencyRequests.filter(
    (request) => request.taskGid === taskGid && request.offset === null,
  );
}

async function waitForEvaluations(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
  taskGid: string,
  count: number,
  timeoutMs = 30_000,
): Promise<void> {
  try {
    await worker.waitFor(
      `${count} gate evaluations of ${taskGid}`,
      () => (evaluations(tracker, taskGid).length >= count ? true : undefined),
      timeoutMs,
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${diagnostics(worker, tracker)}`);
  }
}

async function waitForSettledRun(worker: WorkerFixture, key: string, timeoutMs = 60_000) {
  return await worker.waitFor(
    `the polled run for ${key} to settle`,
    () => worker.runRecords(key).find((run) => run.status !== "in_progress"),
    timeoutMs,
  );
}

function promptMarkers(worker: WorkerFixture): string[] {
  return worker
    .agentInvocations()
    .flatMap((invocation) => (invocation as { promptMarkers?: string[] }).promptMarkers ?? []);
}

/** Assert the held task was never started, moved, or written. */
async function expectUntouched(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
  task: TrackerTicket,
  stamp: string,
  detail: string,
): Promise<void> {
  expect(worker.runRecords(task.key), detail).toEqual([]);
  expect(worker.agentInvocations(), detail).toEqual([]);
  expect(await tracker.getStatus(task.key), detail).toBe(tracker.statuses.todo);
  expect(await tracker.listComments(task.key), detail).toEqual([]);
  expect(tracker.modifiedAt(task.key), detail).toBe(stamp);
}

/** Assert the released task ran once, end to end, with its tracker writes. */
async function expectRanOnce(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
  task: TrackerTicket,
  marker: string,
): Promise<void> {
  const run = await waitForSettledRun(worker, task.key);
  const detail = diagnostics(worker, tracker, `run of ${task.key}`);
  expect(run.status, detail).toBe("succeeded");
  expect(worker.runRecords(task.key), detail).toHaveLength(1);
  expect(promptMarkers(worker), detail).toEqual([marker]);
  expect(await tracker.getStatus(task.key), detail).toBe(tracker.statuses.inProgress);
  const comments = await tracker.listComments(task.key);
  expect(
    comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
    detail,
  ).toHaveLength(1);
}

/** A few more ticks after the run: the moved task does not run again. */
async function expectNoRerun(
  worker: WorkerFixture,
  tracker: FakeAsanaTracker,
  task: TrackerTicket,
): Promise<void> {
  await Bun.sleep(3 * POLL_INTERVAL_SECONDS * 1000);
  const detail = diagnostics(worker, tracker, `after the run of ${task.key}`);
  expect(worker.runRecords(task.key), detail).toHaveLength(1);
  expect(worker.agentInvocations(), detail).toHaveLength(1);
  expect(tracker.unexpectedRequests, detail).toEqual([]);
  expect(worker.logs, detail).not.toContain(tracker.environment().ASANA_API_TOKEN ?? "unset");
  expect(worker.running, detail).toBe(true);
}

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
  "worker holds an Asana task on an open dependency (second page) until the blocker is completed",
  async () => {
    const selector = `E2EASANADEPGATE${uniqueToken()}`;
    const tracker = new FakeAsanaTracker();
    const worker = createWorker(tracker, selector);
    let failure: unknown;
    try {
      const marker = `E2EPROMPTMARKER${uniqueToken()}`;
      // Neither blocker matches the task query (no selector in the title).
      const done = await tracker.createTicket({
        title: "Already shipped prerequisite",
        body: "# Done\n\nCompleted dependency on page one.\n",
      });
      await tracker.closeTicket(done.key);
      const blocker = await tracker.createTicket({
        title: "Schema migration (blocker)",
        body: "# Blocker\n\nOpen dependency on page two.\n",
      });
      const dependent = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      // One record per page: the open blocker is only on the second page, so a
      // client that ignores `next_page.offset` sees only the completed one and
      // would start the task.
      tracker.setDependencies(dependent.key, [done.key, blocker.key]);
      tracker.setDependencyPageSize(1);
      const stamp = tracker.modifiedAt(dependent.key);

      await startWorker(worker, tracker);
      await waitForEvaluations(worker, tracker, dependent.key, HELD_EVALUATIONS);
      let detail = diagnostics(worker, tracker, "held");

      // The client asked the documented endpoint with the fields it parses and
      // followed the offset the first page issued.
      const first = evaluations(tracker, dependent.key)[0]!;
      expect(first, detail).toMatchObject({ limit: "100", status: 200, returned: [done.key] });
      expect([...first.optFields].sort(), detail).toEqual(["completed", "gid", "name"]);
      expect(first.nextOffset, detail).not.toBeNull();
      const second = tracker.dependencyRequests.find(
        (request) => request.offset !== null && request.offset === first.nextOffset,
      );
      expect(second, detail).toMatchObject({
        taskGid: dependent.key,
        status: 200,
        returned: [blocker.key],
        nextOffset: null,
      });
      expect(
        tracker.dependencyRequests.filter((request) => request.status !== 200),
        detail,
      ).toEqual([]);

      await expectUntouched(worker, tracker, dependent, stamp, detail);
      expect(worker.runRecords(blocker.key), detail).toEqual([]);

      const items = await queueItems(worker, dependent.key);
      detail = diagnostics(worker, tracker, `queue: ${JSON.stringify(items)}`);
      expect(items, detail).toHaveLength(1);
      const [item] = items;
      expect(item, detail).toMatchObject({
        kind: "tracker",
        tracker: "asana",
        dependencyState: "waiting",
      });
      expect(item?.dependsOn, detail).toContain(blocker.key);
      expect(item?.dependencyReason, detail).toContain(blocker.key);
      expect(item?.dependencyReason, detail).not.toContain(done.key);

      // Still held on later ticks, even with the queue read in between.
      await waitForEvaluations(worker, tracker, dependent.key, HELD_EVALUATIONS + 1);
      await expectUntouched(worker, tracker, dependent, stamp, diagnostics(worker, tracker));

      // Release: complete the blocker, then edit the dependent so it re-checks
      // at once instead of after the backoff.
      await tracker.closeTicket(blocker.key);
      tracker.editTicket(dependent.key, {
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! Unblocked.\n\n${marker}\n`,
      });
      await expectRanOnce(worker, tracker, dependent, marker);
      detail = diagnostics(worker, tracker, "released");
      expect(await queueItems(worker, dependent.key), detail).toEqual([]);
      expect(worker.runRecords(blocker.key), detail).toEqual([]);
      await expectNoRerun(worker, tracker, dependent);
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
  "worker treats an Asana dependencies 402 (no premium) as no blockers and runs the task",
  async () => {
    const selector = `E2EASANADEP402${uniqueToken()}`;
    const tracker = new FakeAsanaTracker();
    const worker = createWorker(tracker, selector);
    let failure: unknown;
    try {
      const marker = `E2EPROMPTMARKER${uniqueToken()}`;
      const blocker = await tracker.createTicket({
        title: "Unreadable blocker",
        body: "# Blocker\n\nWould block if the plan exposed dependencies.\n",
      });
      const dependent = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      tracker.setDependencies(dependent.key, [blocker.key]);
      // The workspace plan has no dependencies: Asana answers 402.
      tracker.failDependencies(402);

      await startWorker(worker, tracker);
      await expectRanOnce(worker, tracker, dependent, marker);
      const detail = diagnostics(worker, tracker, "402");
      const reads = evaluations(tracker, dependent.key);
      expect(reads.length, detail).toBeGreaterThanOrEqual(1);
      expect(
        reads.every((request) => request.status === 402),
        detail,
      ).toBe(true);
      expect(await queueItems(worker, dependent.key), detail).toEqual([]);
      expect(worker.logs, detail).not.toContain("could not read");
      await expectNoRerun(worker, tracker, dependent);
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
  "worker fails closed on an Asana dependencies 500 and runs the task once the endpoint recovers",
  async () => {
    const selector = `E2EASANADEP500${uniqueToken()}`;
    const tracker = new FakeAsanaTracker();
    const worker = createWorker(tracker, selector);
    let failure: unknown;
    try {
      const marker = `E2EPROMPTMARKER${uniqueToken()}`;
      const dependent = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: `# Expand the greeting\n\nChange the greeting to Hello, world!\n\n${marker}\n`,
      });
      // No blockers at all: only the read failure can hold the task.
      tracker.failDependencies(500);
      const stamp = tracker.modifiedAt(dependent.key);

      await startWorker(worker, tracker);
      await waitForEvaluations(worker, tracker, dependent.key, HELD_EVALUATIONS);
      let detail = diagnostics(worker, tracker, "500 held");
      expect(
        evaluations(tracker, dependent.key).every((request) => request.status === 500),
        detail,
      ).toBe(true);
      await expectUntouched(worker, tracker, dependent, stamp, detail);

      const items = await queueItems(worker, dependent.key);
      detail = diagnostics(worker, tracker, `queue: ${JSON.stringify(items)}`);
      expect(items, detail).toHaveLength(1);
      expect(items[0], detail).toMatchObject({
        kind: "tracker",
        tracker: "asana",
        dependencyState: "waiting",
      });
      expect(items[0]?.dependencyReason, detail).toContain(
        `could not read ${dependent.key}'s blockers from asana`,
      );
      // The reason carries Asana's error status, not a credential.
      expect(items[0]?.dependencyReason, detail).toContain("500");

      // Recover without touching the task: the backoff re-check alone runs it.
      tracker.failDependencies(null);
      await expectRanOnce(worker, tracker, dependent, marker);
      detail = diagnostics(worker, tracker, "500 recovered");
      expect(evaluations(tracker, dependent.key).at(-1)?.status, detail).toBe(200);
      expect(await queueItems(worker, dependent.key), detail).toEqual([]);
      await expectNoRerun(worker, tracker, dependent);
    } catch (error) {
      failure = error;
    } finally {
      failure = await cleanup(worker, tracker, failure);
    }
    if (failure) throw failure;
  },
  150_000,
);
