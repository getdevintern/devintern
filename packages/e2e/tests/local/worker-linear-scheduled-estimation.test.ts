import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomationSchedule, WorkerRunRecord } from "../../helpers/worker";
import { FakeLinearTracker } from "../../providers/fake-linear";

/**
 * Worker `[[estimations]]` schedule against the offline Linear GraphQL fake.
 *
 * A due sweep runs `devintern --estimate --query <IssueFilter> --no-git`
 * (`estimationCliArgs`) as an `estimate`-origin child attributed to the
 * estimation id. Linear writes the native `estimate` field (`IssueUpdate`)
 * and one marked comment per issue. The sweep must select every match through
 * `SearchIssues`, skip a matching issue younger than 24 hours, leave a decoy
 * outside the filter alone, make no writes on an unchanged later sweep, and
 * re-estimate only an edited issue by updating (not duplicating) its comment.
 * Mirrors the Asana and Azure DevOps scheduled-estimation tests.
 */
const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const ESTIMATION_ID = "linear-groom";
/** Durable scheduler key. Estimations are namespaced so they cannot collide with automations. */
const SCHEDULE_KEY = `estimation:${ESTIMATION_ID}`;
const INTERVAL = "15m";
const INTERVAL_MS = 15 * 60 * 1000;
const COMPLETED_LINE = `[estimation:${ESTIMATION_ID}] completed`;
const COMPLETED_PATTERN = new RegExp(COMPLETED_LINE.replace(/[[\]]/g, "\\$&"));
const STARTED_PATTERN = new RegExp(`\\[estimation:${ESTIMATION_ID}\\] starting scheduled run`, "g");
/** GraphQL operations that write to the tracker. */
const WRITE_OPERATIONS = new Set(["IssueUpdate", "CommentCreate", "CommentUpdate"]);

function scheduleRow(worker: WorkerFixture): WorkerAutomationSchedule | undefined {
  return worker.automationSchedules().find((row) => row.automation_id === SCHEDULE_KEY);
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
  const apiKey = tracker.environment().LINEAR_API_KEY ?? "";
  return redact(
    [
      detail,
      `operations: ${JSON.stringify(tracker.operations)}`,
      `searches: ${JSON.stringify(tracker.searchRequests)}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `schedules: ${JSON.stringify(worker.automationSchedules())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedOperations)}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    [apiKey],
  );
}

async function estimationComments(
  tracker: FakeLinearTracker,
  key: string,
): Promise<Array<{ id: string; body: string }>> {
  const comments = await tracker.listComments(key);
  return comments.filter((comment) => comment.body.includes(ESTIMATION_COMMENT_MARKER));
}

/** Answered write operations, in order (names only). */
function trackerWrites(tracker: FakeLinearTracker): string[] {
  return tracker.operations.filter((name) => WRITE_OPERATIONS.has(name));
}

/** The bare remote and the seed checkout stay at the single fixture commit. */
async function assertReadOnlyGit(worker: WorkerFixture): Promise<void> {
  expect(await worker.remoteBranches()).toEqual([worker.baseBranch]);
  expect(
    await checkedCommand(
      ["git", "--git-dir", worker.remote, "rev-list", "--count", worker.baseBranch],
      worker.root,
      worker.env,
    ),
  ).toBe("1");
  expect(await checkedCommand(["git", "status", "--porcelain"], worker.seed, worker.env)).toBe("");
  expect(
    await checkedCommand(["git", "rev-list", "--count", "HEAD"], worker.seed, worker.env),
  ).toBe("1");
  expect(worker.allTaskWorktrees()).toEqual([]);
}

function sortedKeys(records: WorkerRunRecord[]): string[] {
  return records.map((record) => record.task_key ?? "").sort();
}

/** Restart the worker with the estimation occurrence due at `dueAt`. */
async function restartDue(worker: WorkerFixture, dueAt: number): Promise<void> {
  await worker.stop();
  worker.setScheduleNextDue(SCHEDULE_KEY, dueAt);
  worker.start();
  await worker.waitForReady();
}

test.skipIf(!existsSync(cliPath))(
  "scheduled Linear estimation sweeps every matching issue once, skips unchanged ones, and re-estimates edits",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const selector = `E2ELINEST${token}`;
    const query = JSON.stringify({ title: { containsIgnoreCase: selector } });
    // Fixed clock: seeded issues are stamped 2026-01-01, well past the 24h
    // new-issue gate, until `setNow` moves the clock to now.
    const tracker = new FakeLinearTracker();
    // The only resources this test creates are the loopback server and the
    // temp workspace. Both are disposed independently in finally.
    const worker = new WorkerFixture({
      tracker: "linear",
      rootPrefix: "devintern-e2e-worker-linear-est-",
      // Loopback fetches must never route through an ambient proxy.
      env: {
        ...tracker.environment(),
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
      estimations: [{ id: ESTIMATION_ID, enabled: true, interval: INTERVAL, query }],
    });
    let failure: unknown;
    try {
      const first = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
      });
      const second = await tracker.createTicket({
        title: `Document the greeting ${selector}`,
        body: "# Document the greeting\n\nAdd a README line for the greeting.\n",
      });
      // Old enough, but the selector is only in the description: the title filter skips it.
      const decoy = await tracker.createTicket({
        title: "Backlog grooming (decoy)",
        body: `# Decoy\n\nMentions ${selector} only in the description.\n`,
      });
      // Matches the filter but was created "now": selected, then skipped (< 24h).
      tracker.setNow(Date.now());
      const young = await tracker.createTicket({
        title: `Greeting follow-up (too new) ${selector}`,
        body: "# Too new\n\nThis issue matches the filter but was just created.\n",
      });
      const decoyStamp = tracker.updatedAt(decoy.key);
      const youngStamp = tracker.updatedAt(young.key);
      const eligible = [first.key, second.key].sort();
      const matching = [...eligible, young.key].sort();

      await worker.prepare();
      // Defaults include --create-pr. The sweep must still stay read-only.
      expect(readFileSync(join(worker.workspaceDir, "workspace.toml"), "utf8")).toContain(
        "--create-pr",
      );

      // First start only registers the schedule for a future occurrence.
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /Scheduling 1 enabled estimation\(s\)/,
        20_000,
        "the estimation scheduler to register the Linear entry",
      );
      const registered = await worker.waitFor(
        "the estimation schedule to record a future occurrence",
        () => {
          const row = scheduleRow(worker);
          return row && row.next_due_at > Date.now() ? row : undefined;
        },
      );
      expect(registered.schedule_spec, diagnostics(worker, tracker)).toBe(`interval:${INTERVAL}`);
      expect(registered.last_scheduled_at, diagnostics(worker, tracker)).toBeNull();
      expect(worker.runRecords(), diagnostics(worker, tracker)).toEqual([]);
      expect(tracker.searchRequests, diagnostics(worker, tracker)).toEqual([]);
      expect(trackerWrites(tracker), diagnostics(worker, tracker)).toEqual([]);

      // Sweep 1: make the occurrence due without waiting out the interval.
      const firstDue = Date.now() - INTERVAL_MS;
      await restartDue(worker, firstDue);
      await worker.waitForAutomationRun(ESTIMATION_ID, 45_000);
      await worker.waitForOutput(COMPLETED_PATTERN, 45_000, "the first Linear estimation sweep");
      const detail = diagnostics(worker, tracker);

      // One sweep, one SearchIssues with the configured filter, one run per eligible issue.
      expect(worker.logs.match(STARTED_PATTERN) ?? [], detail).toHaveLength(1);
      expect(
        tracker.searchRequests.map((request) => request.filter),
        detail,
      ).toEqual([JSON.parse(query)]);
      expect([...(tracker.searchRequests[0]?.matched ?? [])].sort(), detail).toEqual(matching);
      const runs = worker.runRecords();
      expect(sortedKeys(runs), detail).toEqual(eligible);
      for (const run of runs) {
        expect(run.origin, detail).toBe("estimate");
        expect(run.automation_id, detail).toBe(ESTIMATION_ID);
        expect(run.status, detail).toBe("succeeded");
        expect(run.branch, detail).toBeNull();
        expect(run.pr_url, detail).toBeNull();
        expect(run.repo, detail).toBeNull();
      }
      expect(worker.agentInvocations(), detail).toEqual([
        { mode: "estimate", automation: ESTIMATION_ID },
        { mode: "estimate", automation: ESTIMATION_ID },
      ]);
      const cursor = scheduleRow(worker);
      expect(cursor?.last_scheduled_at, detail).toBe(firstDue);
      expect(cursor?.next_due_at ?? 0, detail).toBeGreaterThan(Date.now());

      // Native estimate written once and exactly one marked comment per eligible issue.
      const commentIds: Record<string, string> = {};
      for (const key of eligible) {
        expect(tracker.getEstimate(key), detail).toBe(3);
        const comments = await estimationComments(tracker, key);
        expect(comments, detail).toHaveLength(1);
        expect(comments[0]?.body, detail).toContain("**Story Points:** 3");
        commentIds[key] = comments[0]!.id;
        const resultPath = join(
          worker.env.DEVINTERN_OUTPUT_DIR,
          key.toLowerCase(),
          "estimation-result.json",
        );
        expect(existsSync(resultPath), detail).toBe(true);
        expect(JSON.parse(readFileSync(resultPath, "utf8")), detail).toMatchObject({
          storyPoints: 3,
        });
      }
      expect(trackerWrites(tracker).sort(), detail).toEqual(
        ["CommentCreate", "CommentCreate", "IssueUpdate", "IssueUpdate"].sort(),
      );

      // The decoy is never selected; the young issue is selected and skipped.
      for (const [key, stamp] of [
        [decoy.key, decoyStamp],
        [young.key, youngStamp],
      ] as const) {
        expect(tracker.getEstimate(key), detail).toBeUndefined();
        expect(await tracker.listComments(key), detail).toEqual([]);
        expect(tracker.updatedAt(key), detail).toBe(stamp);
        expect(existsSync(join(worker.env.DEVINTERN_OUTPUT_DIR, key.toLowerCase())), detail).toBe(
          false,
        );
      }
      expect(worker.logs, detail).not.toContain(decoy.key);
      expect(worker.logs, detail).toMatch(new RegExp(`Skipping ${young.key} .*\\(< 24h\\)`));
      expect(worker.logs, detail).not.toContain("already estimated and not updated since");
      await assertReadOnlyGit(worker);

      // Sweep 2: nothing changed. Re-queries Linear, but no agent, run, or write.
      const writesAfterFirst = trackerWrites(tracker).length;
      const secondDue = Date.now() - 1_000;
      await restartDue(worker, secondDue);
      await worker.waitFor(
        "the second sweep to skip both unchanged Linear issues",
        () =>
          eligible.every((key) =>
            worker.logs.includes(`Skipping ${key} — already estimated and not updated since`),
          ) && worker.logs.includes(COMPLETED_LINE)
            ? true
            : undefined,
        45_000,
      );
      const unchanged = diagnostics(worker, tracker);
      expect(worker.logs.match(STARTED_PATTERN) ?? [], unchanged).toHaveLength(1);
      expect(tracker.searchRequests, unchanged).toHaveLength(2);
      expect(sortedKeys(worker.runRecords()), unchanged).toEqual(eligible);
      expect(worker.agentInvocations(), unchanged).toHaveLength(2);
      expect(trackerWrites(tracker), unchanged).toHaveLength(writesAfterFirst);
      for (const key of eligible) {
        expect(tracker.getEstimate(key), unchanged).toBe(3);
        expect(
          (await estimationComments(tracker, key)).map((comment) => comment.id),
          unchanged,
        ).toEqual([commentIds[key]]);
      }
      expect(worker.logs, unchanged).toMatch(new RegExp(`Skipping ${young.key} .*\\(< 24h\\)`));
      const secondCursor = scheduleRow(worker);
      expect(secondCursor?.last_scheduled_at, unchanged).toBe(secondDue);
      expect(secondCursor?.next_due_at ?? 0, unchanged).toBeGreaterThan(Date.now());

      // Sweep 3: a human edits one issue; only that issue is re-estimated and
      // its existing comment is rewritten in place.
      const [edited, untouched] = eligible as [string, string];
      await tracker.editTicket(edited, {
        body: "# Expand the greeting\n\nScope changed: also keep the greeting export stable.\n",
      });
      worker.env.E2E_ESTIMATE_POINTS = "5";
      const writesBeforeEdit = trackerWrites(tracker).length;
      const thirdDue = Date.now() - 1_000;
      await restartDue(worker, thirdDue);
      await worker.waitForOutput(COMPLETED_PATTERN, 45_000, "the post-edit Linear sweep");
      const reestimated = diagnostics(worker, tracker);
      expect(worker.logs.match(STARTED_PATTERN) ?? [], reestimated).toHaveLength(1);
      expect(tracker.searchRequests, reestimated).toHaveLength(3);
      expect(worker.logs, reestimated).toContain(
        `Skipping ${untouched} — already estimated and not updated since`,
      );
      expect(sortedKeys(worker.runRecords()), reestimated).toEqual([...eligible, edited].sort());
      expect(worker.agentInvocations(), reestimated).toHaveLength(3);
      expect(trackerWrites(tracker).slice(writesBeforeEdit).sort(), reestimated).toEqual([
        "CommentUpdate",
        "IssueUpdate",
      ]);
      expect(tracker.getEstimate(edited), reestimated).toBe(5);
      const editedComments = await estimationComments(tracker, edited);
      expect(
        editedComments.map((comment) => comment.id),
        reestimated,
      ).toEqual([commentIds[edited]]);
      expect(editedComments[0]?.body, reestimated).toContain("**Story Points:** 5");
      expect(tracker.getEstimate(untouched), reestimated).toBe(3);
      const untouchedComments = await estimationComments(tracker, untouched);
      expect(
        untouchedComments.map((comment) => comment.id),
        reestimated,
      ).toEqual([commentIds[untouched]]);
      expect(untouchedComments[0]?.body, reestimated).toContain("**Story Points:** 3");
      for (const key of [decoy.key, young.key]) {
        expect(tracker.getEstimate(key), reestimated).toBeUndefined();
        expect(await tracker.listComments(key), reestimated).toEqual([]);
      }
      expect(scheduleRow(worker)?.last_scheduled_at, reestimated).toBe(thirdDue);
      expect(tracker.unexpectedOperations, reestimated).toEqual([]);
      await assertReadOnlyGit(worker);
      expect(worker.running, reestimated).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const residue: string[] = [];
      try {
        await tracker.cleanup();
      } catch (error) {
        residue.push(
          `fake Linear server: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await worker.dispose();
      } catch (error) {
        residue.push(`worker fixture: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (residue.length > 0) {
        const residueError = new Error(`Cleanup left residue:\n${residue.join("\n")}`);
        if (failure) {
          console.error(residueError.message);
        } else {
          failure = residueError;
        }
      }
    }
    if (failure) throw failure;
  },
  // Four bounded worker starts (register, first due sweep, unchanged sweep, post-edit sweep).
  150_000,
);
