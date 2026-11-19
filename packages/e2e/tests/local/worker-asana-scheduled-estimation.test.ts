import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomationSchedule, WorkerRunRecord } from "../../helpers/worker";
import { FakeAsanaTracker } from "../../providers/fake-asana";

/**
 * A worker `[[estimations]]` entry whose tracker is Asana runs its due sweep as
 * `devintern --estimate --query <query> --no-git` (`estimationCliArgs`). The
 * query goes through Asana's search path: one `GET /projects/{gid}/tasks`
 * listing filtered client-side by section and name text. Without a configured
 * story-points field the estimate is comment-only (one marked story per task).
 */
const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const ESTIMATION_ID = "asana-groom";
/** Durable scheduler key. Estimations are namespaced so they cannot collide with automations. */
const SCHEDULE_KEY = `estimation:${ESTIMATION_ID}`;
const INTERVAL = "15m";
const INTERVAL_MS = 15 * 60 * 1000;
const COMPLETED_LINE = `[estimation:${ESTIMATION_ID}] completed`;
const STARTED_PATTERN = new RegExp(`\\[estimation:${ESTIMATION_ID}\\] starting scheduled run`, "g");
/** The markdown->Asana HTML converter keeps literal `**` around the points label. */
const storyPoints = (points: number): RegExp => new RegExp(`Story Points:(\\*\\*)? ${points}\\b`);

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

function diagnostics(worker: WorkerFixture, tracker: FakeAsanaTracker, detail = ""): string {
  const token = tracker.environment().ASANA_API_TOKEN ?? "";
  return redact(
    [
      detail,
      `listings: ${JSON.stringify(tracker.projectTaskListings)}`,
      `requests: ${JSON.stringify(tracker.requests)}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `schedules: ${JSON.stringify(worker.automationSchedules())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    [token],
  );
}

async function estimationComments(
  tracker: FakeAsanaTracker,
  key: string,
): Promise<Array<{ id: string; body: string }>> {
  const comments = await tracker.listComments(key);
  return comments.filter((comment) => comment.body.includes(ESTIMATION_COMMENT_MARKER));
}

/** Requests that write to the tracker (task fields, stories, section moves), without query strings. */
function trackerWrites(tracker: FakeAsanaTracker): string[] {
  return tracker.requests
    .filter((request) => !request.startsWith("GET "))
    .map((request) => request.split("?")[0] ?? request);
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

test.skipIf(!existsSync(cliPath))(
  "scheduled Asana estimation sweeps every matching task once and skips unchanged tasks",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const selector = `E2EASANAEST${token}`;
    const query = `section:"To Do" ${selector}`;
    const tracker = new FakeAsanaTracker();
    // The only resources this test creates are the loopback server and the
    // temp workspace. Both are disposed independently in finally.
    const worker = new WorkerFixture({
      tracker: "asana",
      env: tracker.environment(),
      estimations: [{ id: ESTIMATION_ID, enabled: true, interval: INTERVAL, query }],
    });
    let failure: unknown;
    try {
      // The fake clock starts on 2026-01-01, so tasks created before setNow are
      // well past the 24h gate. Asana's text filter matches the task name.
      const first = await tracker.createTicket({
        title: `Expand the greeting ${selector}`,
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
      });
      const second = await tracker.createTicket({
        title: `Document the greeting ${selector}`,
        body: "# Document the greeting\n\nAdd a README line for the greeting.\n",
      });
      // Same section, no selector in the name: outside the query.
      const decoy = await tracker.createTicket({
        title: "Backlog grooming (decoy)",
        body: `# Decoy\n\nMentions ${selector} only in the notes, so the name filter skips it.\n`,
      });
      // Matches the query but was created "now": selected, then skipped (< 24h).
      tracker.setNow(Date.now());
      const young = await tracker.createTicket({
        title: `Greeting follow-up (too new) ${selector}`,
        body: "# Too new\n\nThis task matches the query but was just created.\n",
      });
      const decoyStamp = tracker.modifiedAt(decoy.key);
      const youngStamp = tracker.modifiedAt(young.key);
      const eligible = [first.key, second.key].sort();

      await worker.prepare();
      // Defaults include --create-pr. The sweep must still stay read-only.
      expect(readFileSync(join(worker.workspaceDir, "workspace.toml"), "utf8")).toContain(
        "--create-pr",
      );

      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /Scheduling 1 enabled estimation\(s\)/,
        20_000,
        "the estimation scheduler to register the Asana entry",
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
      expect(tracker.projectTaskListings, diagnostics(worker, tracker)).toEqual([]);
      expect(trackerWrites(tracker), diagnostics(worker, tracker)).toEqual([]);

      // Make the occurrence due without waiting out the 15m interval.
      await worker.stop();
      const firstDue = Date.now() - INTERVAL_MS;
      worker.setScheduleNextDue(SCHEDULE_KEY, firstDue);
      worker.start();
      await worker.waitForReady();
      await worker.waitForAutomationRun(ESTIMATION_ID, 45_000);
      await worker.waitForOutput(
        new RegExp(COMPLETED_LINE.replace(/[[\]]/g, "\\$&")),
        45_000,
        "the first Asana estimation sweep to finish",
      );
      const detail = diagnostics(worker, tracker);

      // One sweep, one Asana query listing, and one estimate run per selected task.
      expect(worker.logs.match(STARTED_PATTERN) ?? [], detail).toHaveLength(1);
      expect(tracker.projectTaskListings, detail).toEqual([tracker.projectKey()]);
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

      // Comment-only: exactly one marked story per eligible task, no task writes.
      const storyIds: Record<string, string> = {};
      for (const key of eligible) {
        const comments = await estimationComments(tracker, key);
        expect(comments, detail).toHaveLength(1);
        expect(comments[0]?.body, detail).toMatch(storyPoints(3));
        storyIds[key] = comments[0]!.id;
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
        eligible.map((key) => `POST /api/1.0/tasks/${key}/stories`).sort(),
      );
      expect(worker.logs, detail).toContain("No story points field found");

      // Decoy is never selected; the young task is selected and skipped.
      expect(await tracker.listComments(decoy.key), detail).toEqual([]);
      expect(tracker.modifiedAt(decoy.key), detail).toBe(decoyStamp);
      expect(worker.logs, detail).not.toContain(decoy.key);
      expect(await tracker.listComments(young.key), detail).toEqual([]);
      expect(tracker.modifiedAt(young.key), detail).toBe(youngStamp);
      expect(worker.logs, detail).toMatch(new RegExp(`Skipping ${young.key} .*\\(< 24h\\)`));
      expect(
        existsSync(join(worker.env.DEVINTERN_OUTPUT_DIR, young.key.toLowerCase())),
        detail,
      ).toBe(false);
      expect(worker.logs, detail).not.toContain("already estimated and not updated since");
      await assertReadOnlyGit(worker);

      // A later due occurrence re-queries Asana and leaves both unchanged tasks
      // alone: no agent call, no run record, no story post or edit.
      await worker.stop();
      const writesBefore = trackerWrites(tracker).length;
      const secondDue = Date.now() - 1_000;
      worker.setScheduleNextDue(SCHEDULE_KEY, secondDue);
      worker.start();
      await worker.waitForReady();
      await worker.waitFor(
        "the second sweep to skip both unchanged Asana tasks",
        () =>
          eligible.every((key) =>
            worker.logs.includes(`Skipping ${key} — already estimated and not updated since`),
          ) && worker.logs.includes(COMPLETED_LINE)
            ? true
            : undefined,
        45_000,
      );
      const after = diagnostics(worker, tracker);

      expect(worker.logs.match(STARTED_PATTERN) ?? [], after).toHaveLength(1);
      expect(tracker.projectTaskListings, after).toEqual([
        tracker.projectKey(),
        tracker.projectKey(),
      ]);
      expect(sortedKeys(worker.runRecords()), after).toEqual(eligible);
      expect(worker.agentInvocations(), after).toHaveLength(2);
      expect(trackerWrites(tracker), after).toHaveLength(writesBefore);
      for (const key of eligible) {
        const comments = await estimationComments(tracker, key);
        expect(
          comments.map((comment) => comment.id),
          after,
        ).toEqual([storyIds[key]]);
      }
      expect(await tracker.listComments(decoy.key), after).toEqual([]);
      expect(await tracker.listComments(young.key), after).toEqual([]);
      expect(worker.logs, after).toMatch(new RegExp(`Skipping ${young.key} .*\\(< 24h\\)`));
      const secondCursor = scheduleRow(worker);
      expect(secondCursor?.last_scheduled_at, after).toBe(secondDue);
      expect(secondCursor?.next_due_at ?? 0, after).toBeGreaterThan(Date.now());
      expect(tracker.unexpectedRequests, after).toEqual([]);
      await assertReadOnlyGit(worker);
      expect(worker.running, after).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const residue: string[] = [];
      try {
        await tracker.cleanup();
      } catch (error) {
        residue.push(
          `fake Asana server: ${error instanceof Error ? error.message : String(error)}`,
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
  // Three bounded worker starts (register, first due sweep, unchanged sweep).
  120_000,
);
