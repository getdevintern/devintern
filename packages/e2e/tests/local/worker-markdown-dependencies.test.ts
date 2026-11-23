/**
 * Worker dependency gate on a Markdown task's `Depends on:` line, fully offline.
 *
 * Markdown tasks have no native blockers. `MarkdownTaskTrackerClient.getBlockers`
 * (packages/code/src/lib/trackers/markdown/markdown-task-tracker-client.ts)
 * parses the task body with `extractDependsOn` + `toMarkdownTaskKey`, reads
 * each named task file, and treats it as done once its `status:` frontmatter
 * is done / complete(d) / closed / cancel(l)ed (`isDoneStatusName`). A key with
 * no task file is kept as `not found` only when it is ticket-shaped
 * (`isDependencyKeyShape`); other words are prose. The fleet executor runs the
 * gate (tracker-dependency-gate.ts) before it touches git, so a held task is
 * never started, and `worker queue --json` lists it as a `tracker` item.
 *
 * There is no fake server to count ticks against, so the suite observes the
 * gate itself: every evaluation upserts the dependent's `tracker_dependencies`
 * row in queue.db and bumps its `updated_at`.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { throwCleanupFailures } from "../../helpers/cleanup";
import type { CleanupFailure } from "../../helpers/cleanup";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const POLL_INTERVAL_SECONDS = 1;
/**
 * Gate re-checks observed while a task is held. The waiting backoff
 * (task-polling.ts `waitingRecheckDelayMs`) re-checks after 0s, 1s, 2s, ...,
 * so two re-checks stay within a few seconds.
 */
const QUIET_RECHECKS = 2;

/** The `worker queue --json` fields this suite reads (queued-work.ts `QueuedWorkItem`). */
interface QueueItem {
  kind: string;
  taskKey?: string;
  tracker?: string;
  dependsOn?: string[];
  dependencyState?: string;
  dependencyReason?: string;
}

/** Exposes the gate's persisted verdict row, the only per-tick signal Markdown has. */
class MarkdownDependencyWorker extends WorkerFixture {
  readonly tasksDir: string;

  constructor(marker: string, prefix: string) {
    super({
      rootPrefix: prefix,
      env: { E2E_EXPECT_DESCRIPTION_MARKER: marker },
      workspaceTomlExtra: [
        'task_query = "status=todo"',
        `poll_interval = ${POLL_INTERVAL_SECONDS}`,
      ].join("\n"),
    });
    this.tasksDir = join(this.root, "markdown-tasks");
    mkdirSync(this.tasksDir, { recursive: true });
    this.env.MARKDOWN_TASKS_DIR = this.tasksDir;
  }

  taskPath(key: string): string {
    return join(this.tasksDir, `${key}.md`);
  }

  /** `updated_at` of the dependent's gate verdict; advances on every gate evaluation. */
  gateCheckedAt(key: string): number | undefined {
    return this.query<{ updated_at: number }>(
      "SELECT updated_at FROM tracker_dependencies WHERE task_key = ?",
      [key],
    )[0]?.updated_at;
  }
}

function writeTask(
  worker: MarkdownDependencyWorker,
  key: string,
  status: string,
  body: string[],
): void {
  writeFileSync(
    worker.taskPath(key),
    ["---", `status: ${status}`, "---", ...body, ""].join("\n"),
    "utf8",
  );
}

function blockerTask(worker: MarkdownDependencyWorker, key: string, status: string): void {
  writeTask(worker, key, status, [
    "# Add the greeting module",
    "",
    "The blocker; outside the worker query.",
  ]);
}

function dependentTask(
  worker: MarkdownDependencyWorker,
  key: string,
  marker: string,
  dependsOnLines: string[],
): void {
  writeTask(worker, key, "todo", [
    "# Expand the greeting",
    "",
    "Change the greeting to Hello, world! and run bun test.",
    "",
    ...dependsOnLines,
    "",
    marker,
  ]);
}

/** Rewrite one frontmatter field the way a user editing the file would. */
function setStatus(worker: MarkdownDependencyWorker, key: string, status: string): void {
  const path = worker.taskPath(key);
  const content = readFileSync(path, "utf8").replace(/^status:.*$/m, `status: ${status}`);
  writeFileSync(path, content, "utf8");
}

function statusOf(worker: MarkdownDependencyWorker, key: string): string | undefined {
  return /^status:\s*(.*)$/m.exec(readFileSync(worker.taskPath(key), "utf8"))?.[1]?.trim();
}

/**
 * Give the dependent a new update stamp. The Markdown stamp is the file mtime,
 * and a held task with an unchanged stamp is re-checked on the waiting backoff
 * (task-polling.ts); a new stamp re-checks it on the next tick, the same way
 * the Trello suite edits the card instead of sleeping through the backoff.
 * An explicit future mtime keeps the stamp distinct even on coarse clocks.
 */
function touch(worker: MarkdownDependencyWorker, key: string): void {
  const at = new Date(Date.now() + 5_000);
  utimesSync(worker.taskPath(key), at, at);
}

function diagnostics(worker: MarkdownDependencyWorker, detail = ""): string {
  return [
    detail,
    `runs: ${JSON.stringify(worker.runRecords())}`,
    `agent: ${JSON.stringify(worker.agentInvocations())}`,
    worker.tail(),
  ]
    .filter(Boolean)
    .join("\n");
}

async function withOwnedWorker(
  worker: MarkdownDependencyWorker,
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
  if (scenarioError !== undefined) {
    if (failures.length > 0) {
      console.error(
        `Markdown worker cleanup also failed for: ${failures.map((failure) => failure.resource).join(", ")}`,
      );
    }
    throw scenarioError;
  }
  throwCleanupFailures("Markdown dependency worker cleanup failed", failures);
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

/** Poll `worker queue --json` until `probe` accepts the task's tracker item. */
async function waitForQueue(
  worker: MarkdownDependencyWorker,
  label: string,
  key: string,
  probe: (item: QueueItem | undefined) => boolean,
  timeoutMs = 30_000,
): Promise<QueueItem | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: QueueItem[] = [];
  for (;;) {
    if (worker.exitStatus !== undefined) {
      throw new Error(`worker exited while waiting for ${label}\n${diagnostics(worker)}`);
    }
    last = await queueItems(worker);
    const item = trackerItem(last, key);
    if (probe(item)) return item;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${label}; queue: ${JSON.stringify(last)}\n${diagnostics(worker)}`,
      );
    }
    await Bun.sleep(250);
  }
}

async function waitHeld(
  worker: MarkdownDependencyWorker,
  key: string,
  dependsOn: string[],
): Promise<QueueItem | undefined> {
  const held = await waitForQueue(
    worker,
    `${key} held on ${dependsOn.join(", ")}`,
    key,
    (item) => item?.dependencyState === "waiting",
  );
  const detail = diagnostics(worker, `queue item: ${JSON.stringify(held)}`);
  expect(held?.tracker, detail).toBe("markdown");
  expect(held?.dependsOn, detail).toEqual(dependsOn);
  return held;
}

/**
 * Watch {@link QUIET_RECHECKS} more gate evaluations of each dependent and
 * prove none of them was started: no run, no agent call, no pushed branch,
 * and the file still says `todo`.
 */
async function assertHeld(worker: MarkdownDependencyWorker, keys: string[]): Promise<void> {
  for (const key of keys) {
    let seen = worker.gateCheckedAt(key) ?? 0;
    let rechecks = 0;
    await worker.waitFor(
      `${QUIET_RECHECKS} gate re-checks of ${key}`,
      () => {
        const at = worker.gateCheckedAt(key) ?? 0;
        if (at > seen) {
          seen = at;
          rechecks++;
        }
        return rechecks >= QUIET_RECHECKS ? true : undefined;
      },
      30_000,
    );
  }
  const branches = await worker.remoteBranches();
  const detail = diagnostics(worker, `remote branches: ${JSON.stringify(branches)}`);
  for (const key of keys) {
    expect(worker.runRecords(key), detail).toEqual([]);
    expect(branches, detail).not.toContain(`feature/${key}`);
    expect(statusOf(worker, key), detail).toBe("todo");
    expect(trackerItem(await queueItems(worker), key)?.dependencyState, detail).toBe("waiting");
  }
}

/** Wait for exactly one settled, successful run of `key`, then prove later ticks leave it alone. */
async function assertRunsOnce(worker: MarkdownDependencyWorker, key: string): Promise<void> {
  const runs = await worker.waitFor(
    `${key}'s run to settle`,
    () => {
      const records = worker.runRecords(key);
      return records.length > 0 && records.every((record) => record.status !== "in_progress")
        ? records
        : undefined;
    },
    90_000,
  );
  let detail = diagnostics(worker);
  expect(
    runs.map((record) => record.status),
    detail,
  ).toEqual(["succeeded"]);
  expect(runs[0]?.branch, detail).toBe(`feature/${key}`);
  expect(await worker.branchFile(`feature/${key}`, "src/greeting.ts"), detail).toBe(
    'export const greeting = "Hello, world!";',
  );
  // A successful Markdown run moves the file out of the `status=todo` query.
  await worker.waitFor(`${key} to leave todo`, () =>
    statusOf(worker, key) !== "todo" ? true : undefined,
  );
  await waitForQueue(worker, `${key} to leave the queue`, key, (item) => item === undefined);
  // Later ticks must not start it again. Its own status write is a change the
  // poller detects, so this window covers the tick that sees it.
  await worker.waitForOutput(
    new RegExp(`\\[poll:markdown\\] ${key} completed`),
    10_000,
    `${key} completion log`,
  );
  const quietUntil = Date.now() + 3 * POLL_INTERVAL_SECONDS * 1_000;
  await worker.waitFor(
    `${key} quiet window`,
    () => (Date.now() >= quietUntil ? true : undefined),
    10_000,
  );
  detail = diagnostics(worker);
  expect(worker.runRecords(key), detail).toHaveLength(1);
  expect(statusOf(worker, key), detail).not.toBe("todo");
}

async function startWorker(worker: MarkdownDependencyWorker): Promise<void> {
  await worker.prepare();
  worker.start();
  await worker.waitForReady();
  await worker.waitForOutput(
    /🔎 Polling markdown every 1s \(query: status=todo\)/,
    20_000,
    "markdown polling startup",
  );
}

test.skipIf(!existsSync(cliPath))(
  "Markdown Depends-on line holds a polled task until its blocker is done or cancelled",
  async () => {
    const marker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
    const worker = new MarkdownDependencyWorker(marker, "devintern-e2e-worker-markdown-dep-");
    await withOwnedWorker(worker, async () => {
      // Blockers are open (`in-progress`): not matched by the query, not done.
      blockerTask(worker, "api-schema", "in-progress");
      blockerTask(worker, "docs-update", "in-progress");
      dependentTask(worker, "task-12", marker, ["Depends on: api-schema"]);
      dependentTask(worker, "task-13", marker, ["Depends on: docs-update"]);

      await startWorker(worker);

      let held = await waitHeld(worker, "task-12", ["api-schema"]);
      expect(held?.dependencyReason, diagnostics(worker)).toBe("api-schema not done (in-progress)");
      held = await waitHeld(worker, "task-13", ["docs-update"]);
      expect(held?.dependencyReason, diagnostics(worker)).toBe(
        "docs-update not done (in-progress)",
      );
      await assertHeld(worker, ["task-12", "task-13"]);
      expect(worker.agentInvocations(), diagnostics(worker)).toEqual([]);

      // --- Release task-12: its blocker is marked done. ---
      setStatus(worker, "api-schema", "done");
      touch(worker, "task-12");
      await assertRunsOnce(worker, "task-12");
      // task-13's blocker is still open, so it stays held.
      expect(worker.runRecords("task-13"), diagnostics(worker)).toEqual([]);
      expect(statusOf(worker, "task-13"), diagnostics(worker)).toBe("todo");

      // --- Release task-13: a cancelled blocker also counts as done. ---
      setStatus(worker, "docs-update", "cancelled");
      touch(worker, "task-13");
      await assertRunsOnce(worker, "task-13");

      const detail = diagnostics(worker);
      expect(worker.agentInvocations(), detail).toEqual([
        { mode: "implement" },
        { mode: "implement" },
      ]);
      // Blockers are never run by the worker; only their status was read.
      expect(worker.runRecords("api-schema"), detail).toEqual([]);
      expect(worker.runRecords("docs-update"), detail).toEqual([]);
    });
  },
  240_000,
);

test.skipIf(!existsSync(cliPath))(
  "Markdown Depends-on unknown ticket-shaped keys wait as not found; prose words are ignored",
  async () => {
    const marker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
    const worker = new MarkdownDependencyWorker(marker, "devintern-e2e-worker-markdown-dep-nf-");
    await withOwnedWorker(worker, async () => {
      // Ticket-shaped keys with no task file: held as `not found`.
      dependentTask(worker, "task-20", marker, ["Depends on: PROJ-12, local-missing-thing"]);
      // Only prose: `database` and `misc words` are not key-shaped, and the
      // key-shaped `task-99` / `task-98` sit after a parenthesis or a dash, so
      // they are not part of the list (docs/code/worker.md, Ticket dependencies).
      // Were they parsed, they would hold this task as `not found`.
      dependentTask(worker, "task-21", marker, [
        "Depends on: database (see task-99)",
        "Depends on: misc words - after task-98",
      ]);

      await startWorker(worker);

      // task-21 has no blockers and runs straight away.
      await assertRunsOnce(worker, "task-21");
      expect(worker.gateCheckedAt("task-21"), diagnostics(worker)).toBeUndefined();

      const held = await waitHeld(worker, "task-20", ["PROJ-12", "local-missing-thing"]);
      const detail = diagnostics(worker, `queue item: ${JSON.stringify(held)}`);
      // The tracker key keeps its original case so it matches that tracker's runs.
      expect(held?.dependencyReason, detail).toContain("PROJ-12");
      expect(held?.dependencyReason, detail).toContain("not found");
      await worker.waitForOutput(
        /task-20 names blockers markdown cannot find: PROJ-12, local-missing-thing/,
        10_000,
        "the unknown-blocker warning",
      );
      await assertHeld(worker, ["task-20"]);
      expect(worker.agentInvocations(), diagnostics(worker)).toEqual([{ mode: "implement" }]);
    });
  },
  240_000,
);
