import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings } from "../../helpers/tracker-scenario";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { FakeAzureDevOpsTracker } from "../../providers/fake-azure-devops";
import type { FakeAzureDevOpsWiqlRequest } from "../../providers/fake-azure-devops";

/**
 * Worker Azure DevOps polling against the offline fake WIQL server.
 *
 * The product's Azure DevOps change detector asks WIQL for
 * `[System.ChangedDate] >= '<cursor day, UTC>'`. WIQL date literals have day
 * precision, so within an active day the detector reports "changed" on almost
 * every tick. Exactly-once execution then depends on the evaluate step (the
 * configured status-based `task_query`) and the `(key, updated)` dedupe. This
 * test drives the built daemon through pickup, over-reported ticks, re-arm,
 * and a restart on the same queue database.
 */

const DELTA_PREFIX = "SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '";
/** Matches the product's delta query and captures its day literal. */
const DELTA_PATTERN =
  /^SELECT \[System\.Id\] FROM WorkItems WHERE \[System\.ChangedDate\] >= '(\d{4}-\d{2}-\d{2})'$/;
/** Ticks observed after pickup; with `poll_interval = 1` this takes a few seconds. */
const OVER_REPORTED_TICKS = 4;
/** The detector looks back five minutes; allow slack for a tick that straddles midnight. */
const LOOKBACK_SLACK_MS = 10 * 60_000;

function isDelta(request: FakeAzureDevOpsWiqlRequest): boolean {
  return request.query.startsWith(DELTA_PREFIX);
}

/** UTC calendar days a delta literal may legitimately name during this test. */
function plausibleDays(startedAt: number): Set<string> {
  const days = new Set<string>();
  for (let at = startedAt - LOOKBACK_SLACK_MS; at <= Date.now(); at += 60_000) {
    days.add(new Date(at).toISOString().slice(0, 10));
  }
  days.add(new Date().toISOString().slice(0, 10));
  return days;
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

/** Persisted detector cursors from the workspace queue (read-only). */
function cursors(dbPath: string): Array<{ source: string; cursor_value: string }> {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return db.query("SELECT source, cursor_value FROM cursors ORDER BY source").all() as Array<{
      source: string;
      cursor_value: string;
    }>;
  } finally {
    db.close();
  }
}

/** Dedupe ledger rows the poller wrote for tracker tasks. */
function processedTaskIds(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const rows = db
      .query(
        "SELECT external_id FROM processed_events WHERE external_id LIKE 'task:%' ORDER BY external_id",
      )
      .all() as Array<{ external_id: string }>;
    return rows.map((row) => row.external_id);
  } finally {
    db.close();
  }
}

test.skipIf(!existsSync(cliPath))(
  "the worker polls Azure DevOps with a day-precision WIQL delta and runs each ready work item exactly once",
  async () => {
    const startedAt = Date.now();
    const token = crypto.randomUUID().replace(/-/g, "");
    const marker = `E2EAZPOLL${token}`;
    // One state for in-progress and post-PR: the local bare remote is not a
    // supported code host, so no PR (and no second transition) can happen.
    const tracker = new FakeAzureDevOpsTracker({ statuses: { pr: "Active" }, realClock: true });
    const { todo, inProgress } = tracker.statuses;
    const taskQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] = '${todo}'`;
    const pat = tracker.environment().AZURE_DEVOPS_PAT ?? "";

    const worker = new WorkerFixture({
      tracker: "azure-devops",
      rootPrefix: "devintern-e2e-worker-azdo-",
      // Comments and transitions are part of the contract, so keep them on.
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

    const diagnostics = (detail = ""): string =>
      redact(
        [
          detail,
          `wiql: ${JSON.stringify(tracker.wiqlRequests.slice(-20))}`,
          `runs: ${JSON.stringify(worker.runRecords())}`,
          `agent: ${JSON.stringify(worker.agentInvocations())}`,
          `cursors: ${JSON.stringify(cursors(worker.dbPath))}`,
          `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
          worker.tail(),
        ]
          .filter(Boolean)
          .join("\n"),
        [pat],
      );

    /** Wait until the fake has seen `count` more delta WIQL requests after `from`. */
    const waitForDeltas = (from: number, count: number, label: string) =>
      worker.waitFor(
        label,
        () => {
          const deltas = tracker.wiqlRequests.slice(from).filter(isDelta);
          return deltas.length >= count ? deltas : undefined;
        },
        30_000,
      );

    const implementationComments = async (key: string) =>
      (await tracker.listComments(key)).filter((comment) =>
        comment.body.includes(IMPLEMENTATION_COMMENT_MARKER),
      );

    const cleanupFailures: string[] = [];
    try {
      const body = (title: string) =>
        `# ${title}\n\nChange the greeting to Hello, world! and run bun test.\n\n${marker}\n`;
      const first = await tracker.createTicket({
        title: "Expand the greeting",
        body: body("Expand the greeting"),
      });
      // Second item starts outside the ready state; the test moves it in later.
      const second = await tracker.createTicket({
        title: "Expand the greeting again",
        body: body("Expand the greeting again"),
      });
      await tracker.setState(second.key, inProgress);
      // Decoy stays in another state for the whole test and must never be touched.
      const decoy = await tracker.createTicket({
        title: "Expand the greeting (decoy)",
        body: `# Decoy\n\nOutside the ready state.\n\n${marker}\n`,
      });
      await tracker.setState(decoy.key, tracker.statuses.done);
      const decoyChangedDate = tracker.changedDate(decoy.key);
      // Third item, also parked outside the ready state, for the dedupe phase.
      const third = await tracker.createTicket({
        title: "Expand the greeting once more",
        body: body("Expand the greeting once more"),
      });
      await tracker.setState(third.key, inProgress);

      await worker.prepare();
      // Project settings are read from the task's cwd (its worktree), so the
      // per-project states ship in the seeded repository itself.
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
      // The fixture ignores `.devintern-code/`; a tracked file still checks out.
      await git("add", "--force", ".devintern-code/settings.json");
      await git("commit", "-m", "Add Azure DevOps project states");
      await git("push", "origin", worker.baseBranch);

      worker.start();
      await worker.waitForReady();

      // 1. Pickup: the ready item runs once, end to end.
      const firstBranch = `feature/${first.key.toLowerCase()}`;
      await worker.waitFor(
        `run for work item ${first.key} to finish`,
        () => worker.runRecords(first.key).find((run) => run.status !== "in_progress"),
        90_000,
      );
      const firstRuns = worker.runRecords(first.key);
      expect(firstRuns, diagnostics()).toHaveLength(1);
      expect(firstRuns[0]?.status, diagnostics()).toBe("succeeded");
      expect(await worker.branchFile(firstBranch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await tracker.getStatus(first.key), diagnostics()).toBe(inProgress);
      expect(await implementationComments(first.key), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([{ mode: "implement" }]);

      // 2. Delta WIQL shape: a tick after the first one sent the day-precision
      // `ChangedDate` query, verbatim, to the fake.
      const afterPickup = tracker.wiqlRequests.length;
      const firstDeltas = await waitForDeltas(0, 1, "the first delta WIQL request");
      const days = plausibleDays(startedAt);
      const literal = firstDeltas[0]?.query.match(DELTA_PATTERN)?.[1];
      expect(literal, diagnostics(`unexpected delta: ${firstDeltas[0]?.query}`)).toBeDefined();
      expect(days.has(literal ?? ""), diagnostics(`delta day ${literal}`)).toBe(true);
      // The user's status-based query is what selects work.
      expect(tracker.wiqlRequests.some((request) => request.query === taskQuery)).toBe(true);

      // 3. Over-reporting is absorbed: the same-day window keeps reporting the
      // processed item as changed, each such tick re-runs the evaluate query,
      // and still nothing new runs or comments.
      const overReported = await waitForDeltas(
        afterPickup,
        OVER_REPORTED_TICKS,
        `${OVER_REPORTED_TICKS} over-reported delta ticks`,
      );
      for (const delta of overReported) {
        expect(delta.query, diagnostics()).toMatch(DELTA_PATTERN);
        expect(delta.ids, diagnostics("delta did not over-report")).toContain(Number(first.key));
      }
      const lastDeltaAt = overReported.at(-1)?.at ?? 0;
      await worker.waitFor(
        "the evaluate query after the last over-reported delta",
        () =>
          tracker.wiqlRequests.some(
            (request) => request.query === taskQuery && request.at >= lastDeltaAt,
          )
            ? true
            : undefined,
        10_000,
      );
      const evaluatesAfterPickup = tracker.wiqlRequests
        .slice(afterPickup)
        .filter((request) => request.query === taskQuery);
      expect(evaluatesAfterPickup.length, diagnostics()).toBeGreaterThanOrEqual(
        OVER_REPORTED_TICKS,
      );
      expect(worker.runRecords(first.key), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toHaveLength(1);
      expect(await implementationComments(first.key), diagnostics()).toHaveLength(1);
      // The dedupe ledger holds the picked-up `(key, updated)` stamp.
      expect(
        processedTaskIds(worker.dbPath).some((id) => id.startsWith(`task:${first.key}:`)),
        diagnostics(),
      ).toBe(true);

      // 4. Re-arm on change: moving another item into the ready state runs it once.
      await tracker.setState(second.key, todo);
      await worker.waitFor(
        `run for work item ${second.key} to finish`,
        () => worker.runRecords(second.key).find((run) => run.status !== "in_progress"),
        90_000,
      );
      const afterSecond = tracker.wiqlRequests.length;
      await waitForDeltas(afterSecond, 3, "delta ticks after the second run");
      expect(worker.runRecords(second.key), diagnostics()).toHaveLength(1);
      expect(worker.runRecords(second.key)[0]?.status, diagnostics()).toBe("succeeded");
      expect(await tracker.getStatus(second.key), diagnostics()).toBe(inProgress);
      expect(await implementationComments(second.key), diagnostics()).toHaveLength(1);
      expect(worker.runRecords(first.key), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toHaveLength(2);

      // 5. Cursor persistence: a graceful restart on the same queue DB resumes
      // from the stored cursor (first WIQL is the delta, not a backlog drain)
      // and nothing already processed runs again.
      await worker.stop();
      // For phase 6, restart with tracker writes off, so a processed item keeps
      // its ready state and `ChangedDate` (see below).
      const tomlPath = join(worker.workspaceDir, "workspace.toml");
      const toml = readFileSync(tomlPath, "utf8");
      const tasksArgsLine = 'worker_task_args = "--create-pr --skip-clarity-check"';
      expect(toml).toContain(tasksArgsLine);
      writeFileSync(
        tomlPath,
        toml.replace(
          tasksArgsLine,
          'worker_task_args = "--create-pr --skip-clarity-check --skip-comments"',
        ),
      );
      const persisted = cursors(worker.dbPath).find((row) => row.source === "azure-devops");
      expect(persisted, diagnostics("no azure-devops cursor persisted")).toBeDefined();
      const persistedMs = Number(persisted?.cursor_value);
      expect(Number.isFinite(persistedMs), diagnostics()).toBe(true);
      const expectedDay = new Date(persistedMs - 5 * 60_000).toISOString().slice(0, 10);

      const beforeRestart = tracker.wiqlRequests.length;
      worker.start();
      await worker.waitForReady();
      await waitForDeltas(beforeRestart, 3, "delta ticks after restart");
      const firstAfterRestart = tracker.wiqlRequests[beforeRestart];
      expect(firstAfterRestart?.query, diagnostics("restart did not resume the cursor")).toBe(
        `${DELTA_PREFIX}${expectedDay}'`,
      );
      expect(worker.runRecords(first.key), diagnostics()).toHaveLength(1);
      expect(worker.runRecords(second.key), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toHaveLength(2);
      expect(await implementationComments(first.key), diagnostics()).toHaveLength(1);
      expect(await implementationComments(second.key), diagnostics()).toHaveLength(1);

      // 6. Dedupe is load-bearing: with `--skip-comments` the run neither
      // transitions nor comments, so the item keeps matching the ready-state
      // query at the same `ChangedDate`. The same-day delta keeps reporting it
      // as changed, and only the `(key, updated)` dedupe stops a re-run.
      await tracker.setState(third.key, todo);
      const thirdStamp = tracker.changedDate(third.key);
      await worker.waitFor(
        `run for work item ${third.key} to finish`,
        () => worker.runRecords(third.key).find((run) => run.status !== "in_progress"),
        90_000,
      );
      const afterThird = tracker.wiqlRequests.length;
      const thirdDeltas = await waitForDeltas(
        afterThird,
        OVER_REPORTED_TICKS,
        `${OVER_REPORTED_TICKS} delta ticks after the third run`,
      );
      const thirdLastDeltaAt = thirdDeltas.at(-1)?.at ?? 0;
      await worker.waitFor(
        "the evaluate query after the third run's last delta",
        () =>
          tracker.wiqlRequests.some(
            (request) => request.query === taskQuery && request.at >= thirdLastDeltaAt,
          )
            ? true
            : undefined,
        10_000,
      );
      const thirdEvaluates = tracker.wiqlRequests
        .slice(afterThird)
        .filter((request) => request.query === taskQuery);
      expect(thirdEvaluates.length, diagnostics()).toBeGreaterThanOrEqual(OVER_REPORTED_TICKS);
      for (const evaluate of thirdEvaluates) {
        expect(evaluate.ids, diagnostics("third item left the ready query")).toContain(
          Number(third.key),
        );
      }
      for (const delta of thirdDeltas) {
        expect(delta.ids, diagnostics("delta did not over-report")).toContain(Number(third.key));
      }
      expect(tracker.changedDate(third.key), diagnostics()).toBe(thirdStamp);
      expect(await tracker.getStatus(third.key), diagnostics()).toBe(todo);
      expect(worker.runRecords(third.key), diagnostics()).toHaveLength(1);
      expect(worker.runRecords(third.key)[0]?.status, diagnostics()).toBe("succeeded");
      expect(worker.agentInvocations(), diagnostics()).toHaveLength(3);
      expect(await tracker.listComments(third.key), diagnostics()).toEqual([]);
      expect(processedTaskIds(worker.dbPath), diagnostics()).toContain(
        `task:${third.key}:${thirdStamp}`,
      );
      // A successful run with no PR (bare remote) records an actioned marker, so
      // the actioned gate skips the item before the processed-update dedupe.
      expect(worker.logs, diagnostics()).toContain(
        `skipping ${third.key} (already actioned; no change since the PR)`,
      );

      // The decoy was never touched, and the fake routed every request.
      expect(worker.runRecords(decoy.key), diagnostics()).toEqual([]);
      expect(await tracker.listComments(decoy.key)).toEqual([]);
      expect(await tracker.getStatus(decoy.key)).toBe(tracker.statuses.done);
      expect(tracker.changedDate(decoy.key)).toBe(decoyChangedDate);
      expect(await worker.remoteBranches()).not.toContain(`feature/${decoy.key.toLowerCase()}`);
      expect(tracker.unexpectedRequests, diagnostics()).toEqual([]);
    } finally {
      try {
        await worker.stop();
      } catch (error) {
        cleanupFailures.push(`worker: ${String(error)}`);
      }
      try {
        await tracker.cleanup();
      } catch (error) {
        cleanupFailures.push(`fake Azure DevOps server: ${String(error)}`);
      }
      try {
        await worker.dispose();
      } catch (error) {
        cleanupFailures.push(`workspace ${worker.root}: ${String(error)}`);
      }
      if (cleanupFailures.length > 0) {
        console.warn(`Azure DevOps worker polling cleanup failed:\n${cleanupFailures.join("\n")}`);
      }
    }
  },
  // 20s readiness + 2×90s runs + 3×30s delta waits + restart (20s) + stop
  // (25s SIGTERM + 5s SIGKILL) twice, plus prepare().
  300_000,
);
