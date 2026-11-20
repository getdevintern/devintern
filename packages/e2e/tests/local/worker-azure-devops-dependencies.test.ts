import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanupFailure } from "../../helpers/cleanup";
import { throwCleanupFailures } from "../../helpers/cleanup";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeAzureDevOpsTracker } from "../../providers/fake-azure-devops";

/**
 * Worker dependency gate on Azure DevOps Predecessor links, against the
 * offline fake.
 *
 * The product reads blockers through `AzureDevOpsClient.listPredecessors`:
 * `GET …/workitems/{id}?$expand=relations`, keeping only
 * `System.LinkTypes.Dependency-Reverse` relations, then one
 * `errorPolicy=omit` batch read of the predecessors' states. The fleet
 * executor gates a routed ticket before it touches git, so a held-back work
 * item is never started, transitioned, or commented on, and
 * `worker queue --json` lists it as a `tracker` item.
 *
 * The WIQL day-precision change delta over-reports changes within a day (see
 * worker-azure-devops-polling.test.ts), so the test counts gate checks by the
 * fake's relations reads, not by delta ticks.
 */

const PREDECESSOR = "System.LinkTypes.Dependency-Reverse";
const SUCCESSOR = "System.LinkTypes.Dependency-Forward";
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
/** Gate checks observed while a work item is held back. */
const HELD_CHECKS = 3;

interface QueuedItem {
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
    redacted = redacted.replaceAll(Buffer.from(`:${secret}`).toString("base64"), "[redacted]");
  }
  return redacted;
}

/** One isolated worker polling the fake, with the ready-state `task_query`. */
async function setUp(tracker: FakeAzureDevOpsTracker, rootPrefix: string, marker: string) {
  const { todo, inProgress } = tracker.statuses;
  const taskQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] = '${todo}'`;
  const worker = new WorkerFixture({
    tracker: "azure-devops",
    rootPrefix,
    workerTaskArgs: "--create-pr --skip-clarity-check",
    workspaceTomlExtra: [`task_query = ${JSON.stringify(taskQuery)}`, "poll_interval = 1"].join(
      "\n",
    ),
    env: {
      ...tracker.environment(),
      E2E_EXPECT_DESCRIPTION_MARKER: marker,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
  });
  return {
    worker,
    taskQuery,
    /** Seed the repo and commit the per-project states (read from the task worktree). */
    prepare: async () => {
      await worker.prepare();
      const settingsDir = join(worker.seed, ".devintern-code");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        `${JSON.stringify(
          buildTrackerSettings("azure-devops", tracker.projectKey(), {
            todoStatus: todo,
            inProgressStatus: inProgress,
            prStatus: tracker.statuses.pr,
          }),
          null,
          2,
        )}\n`,
      );
      const git = (...args: string[]) => checkedCommand(["git", ...args], worker.seed, worker.env);
      await git("add", "--force", ".devintern-code/settings.json");
      await git("commit", "-m", "Add Azure DevOps project states");
      await git("push", "origin", worker.baseBranch);
    },
    /** `devintern worker queue --json` tracker items, through the built CLI. */
    trackerQueue: async (): Promise<QueuedItem[]> => {
      const stdout = await checkedCommand(
        [
          process.execPath,
          cliPath,
          "worker",
          "queue",
          "--json",
          "--workspace",
          worker.workspaceDir,
        ],
        worker.root,
        worker.env,
      );
      const body = JSON.parse(stdout) as { items?: QueuedItem[] };
      return (body.items ?? []).filter((item) => item.kind === "tracker");
    },
  };
}

/**
 * Stop the worker and the fake and remove the temp tree, attempting every
 * step. Returns the aggregated failure instead of throwing, so a caller's
 * `finally` cannot mask the test's own assertion error.
 */
async function cleanUp(worker: WorkerFixture, tracker: FakeAzureDevOpsTracker): Promise<unknown> {
  const failures: CleanupFailure[] = [];
  try {
    await worker.stop();
  } catch (error) {
    failures.push({ resource: "worker", error });
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    failures.push({ resource: "fake Azure DevOps server", error });
  }
  try {
    await worker.dispose();
  } catch (error) {
    failures.push({ resource: `workspace ${worker.root}`, error });
  }
  try {
    throwCleanupFailures("Azure DevOps worker dependency cleanup failed", failures);
  } catch (error) {
    // Logged too: when the test body already failed, its error wins.
    console.warn(String(error));
    return error;
  }
  return undefined;
}

/** Poll an async probe (the queue CLI) until it returns a value. */
async function pollAsync<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  diagnostics: () => string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\n${diagnostics()}`);
    }
    await Bun.sleep(250);
  }
}

function body(title: string, marker: string): string {
  return `# ${title}\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`;
}

test.skipIf(!existsSync(cliPath))(
  "a Predecessor link holds a polled Azure DevOps work item until the predecessor is done",
  async () => {
    const marker = `E2EAZDEP${crypto.randomUUID().replace(/-/g, "")}`;
    // Agile states: New → Active → Closed. One state for in-progress and
    // post-PR: the local bare remote is not a supported code host.
    const tracker = new FakeAzureDevOpsTracker({ statuses: { pr: "Active" }, realClock: true });
    const { todo, inProgress, done } = tracker.statuses;
    const pat = tracker.environment().AZURE_DEVOPS_PAT ?? "";
    const { worker, prepare, trackerQueue } = await setUp(
      tracker,
      "devintern-e2e-worker-azdo-dep-",
      marker,
    );
    const diagnostics = (detail = ""): string =>
      redact(
        [
          detail,
          `blocker reads: ${JSON.stringify(tracker.blockerRequests.slice(-20))}`,
          `runs: ${JSON.stringify(worker.runRecords())}`,
          `agent: ${JSON.stringify(worker.agentInvocations())}`,
          `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
          worker.tail(),
        ]
          .filter(Boolean)
          .join("\n"),
        [pat],
      );

    let cleanupError: unknown;
    try {
      const dep = await tracker.createTicket({
        title: "Expand the greeting",
        body: body("Expand the greeting", marker),
      });
      // BLK is outside the ready state, so only DEP matches the task query.
      const blk = await tracker.createTicket({
        title: "Ship the greeting API",
        body: "# Blocker\n\nNot for the worker.\n",
      });
      await tracker.setState(blk.key, inProgress);
      // OTHER stays open for the whole test. DEP links to it only through
      // Successor and Hierarchy relations, which must not hold DEP.
      const other = await tracker.createTicket({
        title: "Unrelated open work",
        body: "# Other\n\nNot a predecessor.\n",
      });
      await tracker.setState(other.key, inProgress);
      tracker.addRelation(dep.key, SUCCESSOR, other.key);
      tracker.addRelation(dep.key, PARENT, other.key);
      tracker.addRelation(dep.key, CHILD, other.key);
      tracker.addRelation(dep.key, PREDECESSOR, blk.key);

      await prepare();
      worker.start();
      await worker.waitForReady();

      // 1. Held: several gate checks, and DEP is never started or touched.
      const depChangedDate = tracker.changedDate(dep.key);
      await worker.waitFor(
        `${HELD_CHECKS} relations reads of ${dep.key}`,
        () => (tracker.relationReads(dep.key).length >= HELD_CHECKS ? true : undefined),
        30_000,
      );
      const [waiting] = await pollAsync(
        `${dep.key} in the worker queue`,
        async () => {
          const items = (await trackerQueue()).filter((item) => item.taskKey === dep.key);
          return items.length > 0 ? items : undefined;
        },
        diagnostics,
      );
      expect(waiting?.tracker, diagnostics()).toBe("azure-devops");
      expect(waiting?.dependencyState, diagnostics()).toBe("waiting");
      // Only the Predecessor link is a blocker: OTHER is not listed.
      expect(waiting?.dependsOn, diagnostics()).toEqual([blk.key]);
      expect(waiting?.dependencyReason, diagnostics()).toContain(blk.key);
      expect(waiting?.dependencyReason, diagnostics()).toContain(inProgress);
      // Each check read DEP's relations, then BLK's state in one omit batch.
      expect(
        tracker.blockerRequests.some(
          (request) => request.kind === "batch" && request.ids.includes(Number(blk.key)),
        ),
        diagnostics(),
      ).toBe(true);
      expect(worker.runRecords(dep.key), diagnostics()).toEqual([]);
      expect(worker.agentInvocations(), diagnostics()).toEqual([]);
      expect(await tracker.getStatus(dep.key), diagnostics()).toBe(todo);
      expect(await tracker.listComments(dep.key), diagnostics()).toEqual([]);
      expect(tracker.changedDate(dep.key), diagnostics()).toBe(depChangedDate);
      expect(await worker.remoteBranches()).not.toContain(`feature/${dep.key.toLowerCase()}`);

      // 2. Released: BLK reaches a Completed-category state, and editing DEP
      // makes the worker re-check it now instead of after the backoff.
      await tracker.setState(blk.key, done);
      await tracker.setState(dep.key, todo);
      await worker.waitFor(
        `run for work item ${dep.key} to finish`,
        () => worker.runRecords(dep.key).find((run) => run.status !== "in_progress"),
        90_000,
      );
      const runs = worker.runRecords(dep.key);
      expect(runs, diagnostics()).toHaveLength(1);
      expect(runs[0]?.status, diagnostics()).toBe("succeeded");
      expect(await tracker.getStatus(dep.key), diagnostics()).toBe(inProgress);
      const implementation = (await tracker.listComments(dep.key)).filter((comment) =>
        comment.body.includes(IMPLEMENTATION_COMMENT_MARKER),
      );
      expect(implementation, diagnostics()).toHaveLength(1);
      expect(await worker.branchFile(`feature/${dep.key.toLowerCase()}`, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      // OTHER is still open: Successor and Hierarchy links did not hold DEP.
      expect(await tracker.getStatus(other.key)).toBe(inProgress);

      // Exactly once: a few more polls start nothing new, and the queue is clear.
      const pollsAfterRun = tracker.wiqlRequests.length;
      await worker.waitFor(
        "three more poll ticks",
        () => (tracker.wiqlRequests.length >= pollsAfterRun + 6 ? true : undefined),
        30_000,
      );
      expect(worker.runRecords(dep.key), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);
      expect(
        (await trackerQueue()).filter((item) => item.taskKey === dep.key),
        diagnostics(),
      ).toEqual([]);

      // The blocker and the unrelated item were never started.
      expect(worker.runRecords(blk.key), diagnostics()).toEqual([]);
      expect(worker.runRecords(other.key), diagnostics()).toEqual([]);
      expect(await tracker.listComments(blk.key)).toEqual([]);
      expect(tracker.unexpectedRequests, diagnostics()).toEqual([]);
    } finally {
      cleanupError = await cleanUp(worker, tracker);
    }
    if (cleanupError) throw cleanupError;
  },
  // 20s readiness + 30s held checks + 90s run + 30s settle + stop (30s), plus prepare().
  240_000,
);

test.skipIf(!existsSync(cliPath))(
  "an Azure DevOps predecessor read failure fails closed, and an unreadable predecessor is not done",
  async () => {
    const marker = `E2EAZDEPFAIL${crypto.randomUUID().replace(/-/g, "")}`;
    const tracker = new FakeAzureDevOpsTracker({ statuses: { pr: "Active" }, realClock: true });
    const { todo, inProgress, done } = tracker.statuses;
    const pat = tracker.environment().AZURE_DEVOPS_PAT ?? "";
    const { worker, prepare, trackerQueue } = await setUp(
      tracker,
      "devintern-e2e-worker-azdo-depfail-",
      marker,
    );
    const diagnostics = (detail = ""): string =>
      redact(
        [
          detail,
          `blocker reads: ${JSON.stringify(tracker.blockerRequests.slice(-20))}`,
          `runs: ${JSON.stringify(worker.runRecords())}`,
          `agent: ${JSON.stringify(worker.agentInvocations())}`,
          `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
          worker.tail(),
        ]
          .filter(Boolean)
          .join("\n"),
        [pat],
      );

    let cleanupError: unknown;
    try {
      // (a) FAIL's relations read answers 500. Its predecessor is already
      // done, so only the failed read can hold it.
      const failing = await tracker.createTicket({
        title: "Expand the greeting",
        body: body("Expand the greeting", marker),
      });
      const doneBlocker = await tracker.createTicket({
        title: "Finished prerequisite",
        body: "# Done blocker\n\nAlready finished.\n",
      });
      await tracker.setState(doneBlocker.key, done);
      tracker.addRelation(failing.key, PREDECESSOR, doneBlocker.key);
      tracker.failRelationReads(failing.key);

      // (b) HIDDEN's predecessor is done too, but the omit batch returns a
      // `null` entry for it (deleted or unreadable), so its state is unknown.
      const hidden = await tracker.createTicket({
        title: "Expand the greeting again",
        body: body("Expand the greeting again", marker),
      });
      const unreadable = await tracker.createTicket({
        title: "Prerequisite the token cannot read",
        body: "# Unreadable blocker\n\nOmitted from batch reads.\n",
      });
      await tracker.setState(unreadable.key, done);
      tracker.addRelation(hidden.key, PREDECESSOR, unreadable.key);
      tracker.setUnreadable(unreadable.key);

      await prepare();
      worker.start();
      await worker.waitForReady();

      await worker.waitFor(
        `${HELD_CHECKS} relations reads of ${failing.key} and ${hidden.key}`,
        () =>
          tracker.relationReads(failing.key).length >= HELD_CHECKS &&
          tracker.relationReads(hidden.key).length >= HELD_CHECKS
            ? true
            : undefined,
        30_000,
      );
      expect(
        tracker.relationReads(failing.key).every((request) => request.status === 500),
        diagnostics(),
      ).toBe(true);
      const held = await pollAsync(
        `${failing.key} and ${hidden.key} in the worker queue`,
        async () => {
          const items = await trackerQueue();
          const a = items.find((item) => item.taskKey === failing.key);
          const b = items.find((item) => item.taskKey === hidden.key);
          return a && b ? { a, b } : undefined;
        },
        diagnostics,
      );

      // (a) Fail closed with the read error as the reason.
      expect(held.a.tracker, diagnostics()).toBe("azure-devops");
      expect(held.a.dependencyState, diagnostics()).toBe("waiting");
      expect(held.a.dependsOn, diagnostics()).toEqual([]);
      expect(held.a.dependencyReason, diagnostics()).toStartWith(
        `could not read ${failing.key}'s blockers from azure-devops: `,
      );
      expect(held.a.dependencyReason, diagnostics()).not.toContain(pat);

      // (b) The unreadable predecessor is reported without a state and holds
      // the item; the batch read really returned a null entry for it.
      expect(
        tracker.blockerRequests.some(
          (request) => request.kind === "batch" && request.ids.includes(Number(unreadable.key)),
        ),
        diagnostics(),
      ).toBe(true);
      expect(held.b.tracker, diagnostics()).toBe("azure-devops");
      expect(held.b.dependencyState, diagnostics()).toBe("waiting");
      expect(held.b.dependsOn, diagnostics()).toEqual([unreadable.key]);
      // Pinned from the product's output for a blocker with no done state.
      expect(held.b.dependencyReason, diagnostics()).toBe(`${unreadable.key} not done`);

      for (const key of [failing.key, hidden.key]) {
        expect(worker.runRecords(key), diagnostics()).toEqual([]);
        expect(await tracker.getStatus(key), diagnostics()).toBe(todo);
        expect(await tracker.listComments(key), diagnostics()).toEqual([]);
      }
      expect(worker.agentInvocations(), diagnostics()).toEqual([]);

      // (a) Recovery: the read succeeds again, and editing FAIL re-checks it now.
      tracker.failRelationReads(failing.key, false);
      await tracker.setState(failing.key, todo);
      await worker.waitFor(
        `run for work item ${failing.key} to finish`,
        () => worker.runRecords(failing.key).find((run) => run.status !== "in_progress"),
        90_000,
      );
      expect(worker.runRecords(failing.key), diagnostics()).toHaveLength(1);
      expect(worker.runRecords(failing.key)[0]?.status, diagnostics()).toBe("succeeded");
      expect(await tracker.getStatus(failing.key), diagnostics()).toBe(inProgress);

      // (b) is still held after the recovery and a fresh check of its own.
      const hiddenReads = tracker.relationReads(hidden.key).length;
      await tracker.setState(hidden.key, todo);
      await worker.waitFor(
        `a re-check of ${hidden.key} after its edit`,
        () => (tracker.relationReads(hidden.key).length > hiddenReads ? true : undefined),
        30_000,
      );
      const stillHeld = (await trackerQueue()).find((item) => item.taskKey === hidden.key);
      expect(stillHeld?.dependencyState, diagnostics()).toBe("waiting");
      expect(stillHeld?.dependencyReason, diagnostics()).toContain(unreadable.key);
      expect(worker.runRecords(hidden.key), diagnostics()).toEqual([]);
      expect(await tracker.listComments(hidden.key), diagnostics()).toEqual([]);
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);

      for (const key of [doneBlocker.key, unreadable.key]) {
        expect(worker.runRecords(key), diagnostics()).toEqual([]);
      }
      expect(tracker.unexpectedRequests, diagnostics()).toEqual([]);
    } finally {
      cleanupError = await cleanUp(worker, tracker);
    }
    if (cleanupError) throw cleanupError;
  },
  // 20s readiness + 30s held checks + 90s run + 30s re-check + stop (30s), plus prepare().
  240_000,
);
