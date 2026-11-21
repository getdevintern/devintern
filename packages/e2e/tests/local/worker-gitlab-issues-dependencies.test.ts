/**
 * Worker polling of GitLab Issues and the `is_blocked_by` dependency gate,
 * fully offline.
 *
 * Production wiring: the worker polls through `GitLabClient.searchIssues`
 * (`GET /projects/:id/issues?state=&labels=&per_page=100`, plus an
 * `updated_after` change-detector query), and the fleet executor gates each
 * routed issue through `GitLabTaskTrackerClient.getBlockers` →
 * `GitLabClient.listIssueLinks` (`GET /projects/:id/issues/:iid/links`),
 * keeping only `link_type === "is_blocked_by"`. A blocker counts as done when
 * its link `state` is `closed`; a same-project blocker is keyed by its iid and
 * a cross-project one `group/project#iid`. Status transitions are label swaps
 * (`add_labels`/`remove_labels`) over the configured `GITLAB_STATUS_LABELS`.
 *
 * Blocking links need GitLab Premium, so the live CE container suite cannot
 * exercise them; the loopback fake (`providers/fake-gitlab-issues.ts`) is the
 * reproducible stand-in. Held-back issues are read through
 * `devintern worker queue --json`, never the database. Every release is
 * followed by a `touch` (an `updated_at` bump) so the waiting issue is
 * re-checked at once instead of after the gate's backoff.
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
import { FakeGitLabIssues } from "../../providers/fake-gitlab-issues";
import type { FakeGitLabExternalIssue } from "../../providers/fake-gitlab-issues";

const STATUS = { todo: "e2e-todo", inProgress: "e2e-in-progress" } as const;
/** A non-status label that must survive every transition. */
const KEEP = "e2e-keep";
const TASK_QUERY = `is:open label:${STATUS.todo}`;
/** Gate evaluations observed while held back: enough to span several ticks. */
const HELD_CHECKS = 3;

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

function uniqueMarker(): string {
  return `E2EPROMPTMARKER${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
}

function description(title: string, marker: string): string {
  return `# ${title}\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`;
}

function setUp(rootPrefix: string, marker: string) {
  const tracker = new FakeGitLabIssues({ labels: [STATUS.todo, STATUS.inProgress, KEEP] });
  const worker = new WorkerFixture({
    tracker: "gitlab",
    rootPrefix,
    workerTaskArgs: "--create-pr --skip-clarity-check",
    workspaceTomlExtra: [`task_query = ${JSON.stringify(TASK_QUERY)}`, "poll_interval = 1"].join(
      "\n",
    ),
    env: {
      ...tracker.environment(),
      GITLAB_STATUS_LABELS: `${STATUS.todo},${STATUS.inProgress}`,
      E2E_EXPECT_DESCRIPTION_MARKER: marker,
      // Loopback fetches must never route through an ambient proxy.
      NO_PROXY: "127.0.0.1,localhost,::1,[::1]",
      no_proxy: "127.0.0.1,localhost,::1,[::1]",
    },
  });
  const diagnostics = (detail = ""): string =>
    redact(
      [
        detail,
        `requests: ${JSON.stringify(tracker.requests().slice(-30))}`,
        `runs: ${JSON.stringify(worker.runRecords())}`,
        `agent: ${JSON.stringify(worker.agentInvocations())}`,
        `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
        worker.tail(),
      ]
        .filter(Boolean)
        .join("\n"),
      [tracker.token],
    );
  return { tracker, worker, diagnostics };
}

/**
 * Seed the repo, commit the per-project status labels (the task child reads
 * `.devintern-code/settings.json` from its worktree), and start the worker.
 * `prStatus` equals `inProgressStatus`: the bare remote opens no PR.
 */
async function startWorker(worker: WorkerFixture, tracker: FakeGitLabIssues): Promise<void> {
  await worker.prepare();
  const settingsDir = join(worker.seed, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(
      buildTrackerSettings("gitlab", tracker.projectPath, {
        todoStatus: STATUS.todo,
        inProgressStatus: STATUS.inProgress,
        prStatus: STATUS.inProgress,
      }),
      null,
      2,
    )}\n`,
  );
  const git = (...args: string[]) => checkedCommand(["git", ...args], worker.seed, worker.env);
  await git("add", "--force", ".devintern-code/settings.json");
  await git("commit", "-m", "Configure GitLab status labels");
  await git("push", "origin", worker.baseBranch);
  worker.start();
  await worker.waitForReady();
}

async function trackerQueue(worker: WorkerFixture): Promise<QueueItem[]> {
  const stdout = await checkedCommand(
    [process.execPath, cliPath, "worker", "queue", "--json", "--workspace", worker.workspaceDir],
    worker.root,
    worker.env,
  );
  const parsed = JSON.parse(stdout) as { items?: QueueItem[] };
  if (!Array.isArray(parsed.items)) throw new Error(`worker queue --json has no items: ${stdout}`);
  return parsed.items.filter((item) => item.kind === "tracker");
}

async function waitForQueueItem(
  worker: WorkerFixture,
  key: string,
  label: string,
  predicate: (item: QueueItem) => boolean,
  diagnostics: () => string,
  timeoutMs = 20_000,
): Promise<QueueItem> {
  const deadline = Date.now() + timeoutMs;
  let last: QueueItem | undefined;
  for (;;) {
    if (!worker.running)
      throw new Error(`Worker exited while waiting for ${label}\n${diagnostics()}`);
    last = (await trackerQueue(worker)).find((item) => item.taskKey === key);
    if (last && predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label}; last: ${JSON.stringify(last)}\n${diagnostics()}`,
      );
    }
    await Bun.sleep(250);
  }
}

/** Wait for `count` more poll searches (task-query or change-detector ticks). */
async function waitForSearches(
  worker: WorkerFixture,
  tracker: FakeGitLabIssues,
  count: number,
): Promise<void> {
  const from = tracker.searchRequests().length;
  await worker.waitFor(
    `${count} more GitLab issue searches`,
    () => (tracker.searchRequests().length >= from + count ? true : undefined),
    20_000,
  );
}

/** No run, no agent call, no write, no label change, no note, no branch. */
async function assertUntouched(
  worker: WorkerFixture,
  tracker: FakeGitLabIssues,
  iid: number,
  labels: string[],
  stamp: string,
  detail: string,
): Promise<void> {
  expect(worker.runRecords(String(iid)), detail).toEqual([]);
  expect(tracker.writesTo(iid), detail).toEqual([]);
  expect(tracker.labelsOf(iid), detail).toEqual(labels);
  expect(tracker.notesOf(iid), detail).toEqual([]);
  expect(tracker.issue(iid).updated_at, detail).toBe(stamp);
  expect(await worker.remoteBranches(), detail).not.toContain(`feature/${iid}`);
}

/** Wait for `iid`'s single run to settle and prove it ran exactly once, end to end. */
async function assertRanOnce(
  worker: WorkerFixture,
  tracker: FakeGitLabIssues,
  iid: number,
  marker: string,
  diagnostics: (detail?: string) => string,
): Promise<void> {
  const key = String(iid);
  const run = await worker.waitFor(
    `the run for #${iid} to settle`,
    () => worker.runRecords(key).find((record) => record.status !== "in_progress"),
    90_000,
  );
  let detail = diagnostics(`run of #${iid}`);
  expect(run.status, detail).toBe("succeeded");
  // Status labels swapped as configured; the unrelated label survives.
  const labels = tracker.labelsOf(iid);
  expect(labels, detail).toContain(STATUS.inProgress);
  expect(labels, detail).not.toContain(STATUS.todo);
  expect(labels, detail).toContain(KEEP);
  expect(tracker.issue(iid).state, detail).toBe("opened");
  expect(
    tracker.notesOf(iid).filter((note) => note.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
    detail,
  ).toHaveLength(1);
  expect(await worker.branchFile(`feature/${iid}`, "src/greeting.ts"), detail).toBe(
    'export const greeting = "Hello, world!";',
  );

  // Later ticks: the issue left the `label:e2e-todo` query, so it never re-runs.
  await waitForSearches(worker, tracker, 4);
  detail = diagnostics(`after the run of #${iid}`);
  expect(worker.runRecords(key), detail).toHaveLength(1);
  const markers = worker
    .agentInvocations()
    .flatMap((invocation) => (invocation as { promptMarkers?: string[] }).promptMarkers ?? []);
  expect(markers, detail).toEqual([marker]);
  expect(
    tracker.notesOf(iid).filter((note) => note.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
    detail,
  ).toHaveLength(1);
  expect(
    (await trackerQueue(worker)).find((item) => item.taskKey === key),
    detail,
  ).toBeUndefined();
  expect(worker.logs, detail).not.toContain("polling tick failed");
}

/** Stop the worker and the fake and remove the temp tree, attempting every step. */
async function cleanUp(worker: WorkerFixture, tracker: FakeGitLabIssues): Promise<unknown> {
  const failures: CleanupFailure[] = [];
  try {
    await worker.stop();
  } catch (error) {
    failures.push({ resource: "worker", error });
  }
  try {
    await tracker.cleanup();
  } catch (error) {
    failures.push({ resource: "fake GitLab Issues server", error });
  }
  try {
    await worker.dispose();
  } catch (error) {
    failures.push({ resource: `workspace ${worker.root}`, error });
  }
  if (existsSync(worker.root)) {
    failures.push({ resource: `temporary directory ${worker.root}`, error: new Error("left") });
  }
  try {
    throwCleanupFailures("GitLab Issues worker cleanup failed", failures);
  } catch (error) {
    console.warn(redact(String(error), [tracker.token]));
    return error;
  }
  return undefined;
}

test.skipIf(!existsSync(cliPath))(
  "the worker polls GitLab Issues, implements the ready issue once, and leaves decoys alone",
  async () => {
    const marker = uniqueMarker();
    const { tracker, worker, diagnostics } = setUp("devintern-e2e-worker-gitlab-poll-", marker);
    let failure: unknown;
    try {
      const ready = tracker.createIssue({
        title: "Expand the greeting",
        description: description("Expand the greeting", marker),
        labels: [STATUS.todo, KEEP],
      });
      // Decoys: open without the ready label, and closed with it.
      const unlabelled = tracker.createIssue({
        title: "Not ready yet",
        description: "# Not ready\n\nNo ready label.\n",
        labels: [KEEP],
      });
      const closed = tracker.createIssue({
        title: "Already shipped",
        description: "# Closed\n\nClosed with the ready label.\n",
        labels: [STATUS.todo],
        state: "closed",
      });
      const decoys = [unlabelled, closed].map((issue) => ({
        ...issue,
        labels: tracker.labelsOf(issue.iid),
        stamp: tracker.issue(issue.iid).updated_at,
      }));

      await startWorker(worker, tracker);
      await worker.waitForOutput(/Polling gitlab every 1s/, 10_000, "the GitLab poller to start");
      await assertRanOnce(worker, tracker, ready.iid, marker, diagnostics);

      const detail = diagnostics("final");
      // The poll query reached the fake as the documented list filters.
      expect(
        tracker
          .searchRequests()
          .some(
            (search) =>
              search.params.state === "opened" &&
              search.params.labels === STATUS.todo &&
              search.params.per_page === "100",
          ),
        detail,
      ).toBe(true);
      // One agent call, implementing (prompt markers are checked in assertRanOnce).
      expect(
        worker.agentInvocations().map((invocation) => invocation.mode),
        detail,
      ).toEqual(["implement"]);
      for (const decoy of decoys) {
        await assertUntouched(worker, tracker, decoy.iid, decoy.labels, decoy.stamp, detail);
      }
      // No polled issue is held back without links.
      expect(
        tracker.linkReads(ready.iid).every((read) => read.status === 200),
        detail,
      ).toBe(true);
      expect(tracker.unexpectedRequests, detail).toEqual([]);
      expect(
        tracker.requests().every((request) => request.status !== 401),
        detail,
      ).toBe(true);
      expect(worker.running, detail).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const residue = await cleanUp(worker, tracker);
      failure ??= residue;
    }
    if (failure) throw failure;
  },
  180_000,
);

test.skipIf(!existsSync(cliPath))(
  "an is_blocked_by link holds a polled GitLab issue until every blocker closes; relates_to and blocks do not",
  async () => {
    const marker = uniqueMarker();
    const { tracker, worker, diagnostics } = setUp("devintern-e2e-worker-gitlab-dep-", marker);
    let failure: unknown;
    try {
      // A: same-project blocker, open, outside the ready query.
      const blocker = tracker.createIssue({
        title: "Ship the greeting API",
        description: "# Blocker\n\nIn progress elsewhere.\n",
        labels: [STATUS.inProgress],
      });
      // R and C: open issues linked only as `relates_to` and `blocks` (B blocks C).
      const related = tracker.createIssue({
        title: "Related work",
        description: "# Related\n",
      });
      const downstream = tracker.createIssue({
        title: "Downstream work B blocks",
        description: "# Downstream\n",
      });
      const dependent = tracker.createIssue({
        title: "Expand the greeting",
        description: description("Expand the greeting", marker),
        labels: [STATUS.todo, KEEP],
      });
      // X: a cross-project blocker, keyed `group/project#iid`.
      const external: FakeGitLabExternalIssue = {
        projectPath: "e2e-group/upstream-api",
        projectId: 777,
        iid: 7,
        state: "opened",
      };
      const externalKey = `${external.projectPath}#${external.iid}`;
      tracker.link(dependent.iid, related.iid, "relates_to");
      tracker.link(related.iid, dependent.iid, "relates_to");
      tracker.linkBlockedBy(downstream.iid, dependent.iid);
      tracker.linkBlockedBy(dependent.iid, blocker.iid);
      tracker.linkBlockedBy(dependent.iid, external);
      const heldLabels = tracker.labelsOf(dependent.iid);
      const stamp = tracker.issue(dependent.iid).updated_at;

      await startWorker(worker, tracker);

      // 1. Held across several gate evaluations.
      const held = await waitForQueueItem(
        worker,
        dependent.key,
        "the dependent to be listed as waiting",
        (item) => item.dependencyState === "waiting",
        diagnostics,
      );
      await worker.waitFor(
        `${HELD_CHECKS} link reads of #${dependent.iid}`,
        () => (tracker.linkReads(dependent.iid).length >= HELD_CHECKS ? true : undefined),
        30_000,
      );
      let detail = diagnostics("held");
      expect(held.tracker, detail).toBe("gitlab");
      // Only `is_blocked_by` links are dependencies.
      expect([...(held.dependsOn ?? [])].sort(), detail).toEqual([blocker.key, externalKey].sort());
      expect(held.dependsOn, detail).not.toContain(related.key);
      expect(held.dependsOn, detail).not.toContain(downstream.key);
      // Pinned from the product's output: each open blocker with its link state.
      expect(held.dependencyReason, detail).toBe(
        `${blocker.key} not done (opened); ${externalKey} not done (opened)`,
      );
      expect(
        tracker.linkReads(dependent.iid).every((read) => read.status === 200),
        detail,
      ).toBe(true);
      expect(worker.agentInvocations(), detail).toEqual([]);
      await assertUntouched(worker, tracker, dependent.iid, heldLabels, stamp, detail);

      // 2. The same-project blocker closes; the cross-project one still holds.
      tracker.closeIssue(blocker.iid);
      tracker.touch(dependent.iid);
      const touched = tracker.issue(dependent.iid).updated_at;
      const reads = tracker.linkReads(dependent.iid).length;
      await worker.waitFor(
        `a re-check of #${dependent.iid} after the first release`,
        () => (tracker.linkReads(dependent.iid).length > reads ? true : undefined),
        30_000,
      );
      const stillHeld = await waitForQueueItem(
        worker,
        dependent.key,
        "the dependent to wait on the cross-project blocker only",
        (item) =>
          item.dependencyState === "waiting" &&
          !(item.dependencyReason ?? "").includes(`${blocker.key} not done`),
        diagnostics,
      );
      detail = diagnostics("held by the cross-project blocker");
      // `dependsOn` keeps every blocker; the reason names only the open one.
      expect([...(stillHeld.dependsOn ?? [])].sort(), detail).toEqual(
        [blocker.key, externalKey].sort(),
      );
      expect(stillHeld.dependencyReason, detail).toBe(`${externalKey} not done (opened)`);
      expect(worker.agentInvocations(), detail).toEqual([]);
      await assertUntouched(worker, tracker, dependent.iid, heldLabels, touched, detail);

      // 3. The cross-project blocker closes too: B runs exactly once.
      external.state = "closed";
      tracker.touch(dependent.iid);
      await assertRanOnce(worker, tracker, dependent.iid, marker, diagnostics);

      detail = diagnostics("final");
      // R and C stayed open the whole time; neither link held B.
      expect(tracker.issue(related.iid).state, detail).toBe("opened");
      expect(tracker.issue(downstream.iid).state, detail).toBe("opened");
      for (const other of [blocker, related, downstream]) {
        expect(worker.runRecords(other.key), detail).toEqual([]);
        expect(tracker.notesOf(other.iid), detail).toEqual([]);
      }
      expect(tracker.unexpectedRequests, detail).toEqual([]);
      expect(worker.running, detail).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const residue = await cleanUp(worker, tracker);
      failure ??= residue;
    }
    if (failure) throw failure;
  },
  240_000,
);
