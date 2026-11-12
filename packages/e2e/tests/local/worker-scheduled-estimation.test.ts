import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomationSchedule } from "../../helpers/worker";
import { FakeJiraTracker } from "../../providers/fake-jira";

const STORY_POINTS_FIELD = "customfield_10016";
const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const ESTIMATION_ID = "groom";
const DISABLED_ID = "idle";
/** Durable scheduler key. Estimations are namespaced so they cannot collide with automations. */
const SCHEDULE_KEY = `estimation:${ESTIMATION_ID}`;
const DISABLED_SCHEDULE_KEY = `estimation:${DISABLED_ID}`;
const INTERVAL = "15m";
const INTERVAL_MS = 15 * 60 * 1000;
/** Far enough in the past that a catch-up loop would be obvious, and still one coalesced run. */
const MISSED_WINDOWS = 10;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Write the explicit story-points field the sweep must use.
 *
 * The estimate child runs with the workspace directory as its cwd, so the
 * settings file lives there rather than in the git checkout.
 */
function writeEstimationSettings(worker: WorkerFixture, projectKey: string): void {
  const settingsDir = join(worker.workspaceDir, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(
      { jira: { projects: { [projectKey]: { storyPointsField: STORY_POINTS_FIELD } } } },
      null,
      2,
    )}\n`,
  );
}

function scheduleRow(
  worker: WorkerFixture,
  scheduleId: string,
): WorkerAutomationSchedule | undefined {
  return worker.automationSchedules().find((row) => row.automation_id === scheduleId);
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

function diagnostics(worker: WorkerFixture, tracker: FakeJiraTracker, detail = ""): string {
  const token = tracker.environment().JIRA_API_TOKEN ?? "";
  return redact(
    [
      detail,
      `searches: ${JSON.stringify(tracker.searches)}`,
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
  tracker: FakeJiraTracker,
  key: string,
): Promise<Array<{ id: string; body: string }>> {
  const comments = await tracker.listComments(key);
  return comments.filter((comment) => comment.body.includes(ESTIMATION_COMMENT_MARKER));
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

test.skipIf(!existsSync(cliPath))(
  "scheduled Jira estimation writes points once and skips the unchanged issue",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const eligibleMarker = `E2EEST${token}`;
    const decoyMarker = `E2EDECOY${token}`;
    const query = `text ~ "${eligibleMarker}"`;
    const tracker = new FakeJiraTracker();
    // The only resources this test creates are the loopback server and the
    // temp workspace. Both are disposed independently in finally.
    const worker = new WorkerFixture({
      tracker: "jira",
      env: tracker.environment(),
      estimations: [
        { id: ESTIMATION_ID, enabled: true, interval: INTERVAL, query },
        {
          id: DISABLED_ID,
          enabled: false,
          interval: INTERVAL,
          query: `text ~ "${decoyMarker}"`,
        },
      ],
    });
    let failure: unknown;
    try {
      // Eligible issue is older than the 24h gate. A same-query issue created
      // "now" must be selected and then skipped. The decoy is outside the query.
      tracker.setNow(Date.now() - 48 * HOUR_MS);
      const eligible = await tracker.createTicket({
        title: "Expand the greeting",
        body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${eligibleMarker}\n`,
      });
      tracker.setNow(Date.now());
      const young = await tracker.createTicket({
        title: "Expand the greeting (too new)",
        body: `# Too new\n\nThis issue matches the query but was just created.\n\n${eligibleMarker}\n`,
      });
      const decoy = await tracker.createTicket({
        title: "Expand the greeting (decoy)",
        body: `# Decoy\n\nOutside the enabled query.\n\n${decoyMarker}\n`,
      });

      await worker.prepare();
      writeEstimationSettings(worker, tracker.projectKey());
      // Defaults include --create-pr. The sweep must still stay read-only.
      expect(readFileSync(join(worker.workspaceDir, "workspace.toml"), "utf8")).toContain(
        "--create-pr",
      );

      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /Scheduling 1 enabled estimation\(s\)/,
        20_000,
        "the estimation scheduler to register the enabled entry",
      );
      const registered = await worker.waitFor(
        "the estimation schedule to record a future occurrence",
        () => {
          const row = scheduleRow(worker, SCHEDULE_KEY);
          return row && row.next_due_at > Date.now() ? row : undefined;
        },
      );
      expect(registered.schedule_spec, diagnostics(worker, tracker)).toBe(`interval:${INTERVAL}`);
      expect(registered.last_scheduled_at, diagnostics(worker, tracker)).toBeNull();
      expect(registered.next_due_at - Date.now(), diagnostics(worker, tracker)).toBeLessThanOrEqual(
        INTERVAL_MS + 5_000,
      );
      expect(
        scheduleRow(worker, DISABLED_SCHEDULE_KEY),
        diagnostics(worker, tracker),
      ).toBeUndefined();
      expect(worker.runRecords(), diagnostics(worker, tracker)).toEqual([]);
      expect(tracker.searches, diagnostics(worker, tracker)).toEqual([]);
      expect(worker.logs, diagnostics(worker, tracker)).not.toContain("starting scheduled run");

      // One missed interval is enough to become due. Several missed windows must
      // still coalesce to a single startup run, not a catch-up loop.
      await worker.stop();
      const missedDue = Date.now() - MISSED_WINDOWS * INTERVAL_MS;
      worker.setScheduleNextDue(SCHEDULE_KEY, missedDue);
      expect(scheduleRow(worker, SCHEDULE_KEY)?.next_due_at).toBe(missedDue);

      worker.start();
      await worker.waitForReady();
      const run = await worker.waitForAutomationRun(ESTIMATION_ID, 45_000);
      await worker.waitForOutput(
        new RegExp(`\\[estimation:${ESTIMATION_ID}\\] completed`),
        15_000,
        "the estimation sweep to finish",
      );
      const detail = diagnostics(worker, tracker);

      expect(run.origin, detail).toBe("estimate");
      expect(run.automation_id, detail).toBe(ESTIMATION_ID);
      expect(run.task_key, detail).toBe(eligible.key);
      expect(run.status, detail).toBe("succeeded");
      expect(run.branch, detail).toBeNull();
      expect(run.pr_url, detail).toBeNull();
      expect(run.repo, detail).toBeNull();
      expect(worker.runRecords(), detail).toHaveLength(1);
      expect(
        worker.logs.match(/\[estimation:groom\] starting scheduled run/g) ?? [],
        detail,
      ).toHaveLength(1);

      const cursor = scheduleRow(worker, SCHEDULE_KEY);
      expect(cursor?.last_scheduled_at, detail).toBe(missedDue);
      const remaining = (cursor?.next_due_at ?? 0) - Date.now();
      expect(remaining, detail).toBeGreaterThan(INTERVAL_MS - 120_000);
      expect(remaining, detail).toBeLessThanOrEqual(INTERVAL_MS + 5_000);

      expect(tracker.searches, detail).toEqual([query]);
      expect(tracker.getStoryPoints(eligible.key), detail).toBe(3);
      const comments = await estimationComments(tracker, eligible.key);
      expect(comments, detail).toHaveLength(1);
      expect(comments[0]?.body, detail).toContain("Story Points: 3");
      expect(tracker.getStoryPoints(young.key), detail).toBeUndefined();
      expect(await tracker.listComments(young.key), detail).toEqual([]);
      expect(tracker.getStoryPoints(decoy.key), detail).toBeUndefined();
      expect(await tracker.listComments(decoy.key), detail).toEqual([]);
      expect(worker.logs, detail).toContain(`Skipping ${young.key}`);
      expect(worker.logs, detail).toContain("(< 24h)");
      expect(worker.logs, detail).not.toContain("already estimated and not updated since");
      expect(worker.agentInvocations(), detail).toEqual([
        { mode: "estimate", automation: ESTIMATION_ID },
      ]);
      expect(scheduleRow(worker, DISABLED_SCHEDULE_KEY), detail).toBeUndefined();

      const resultPath = join(
        worker.env.DEVINTERN_OUTPUT_DIR,
        eligible.key.toLowerCase(),
        "estimation-result.json",
      );
      expect(existsSync(resultPath), detail).toBe(true);
      expect(JSON.parse(readFileSync(resultPath, "utf8")), detail).toMatchObject({
        storyPoints: 3,
      });
      expect(
        existsSync(join(worker.env.DEVINTERN_OUTPUT_DIR, young.key.toLowerCase())),
        detail,
      ).toBe(false);
      await assertReadOnlyGit(worker);

      // A later due occurrence must run the sweep again and leave the unchanged
      // issue alone: one comment, one agent call, one run record.
      await worker.stop();
      const secondDue = Date.now() - 1_000;
      worker.setScheduleNextDue(SCHEDULE_KEY, secondDue);
      worker.start();
      await worker.waitForReady();
      await worker.waitFor(
        "the second sweep to skip the unchanged issue",
        () =>
          worker.logs.includes(
            `Skipping ${eligible.key} — already estimated and not updated since`,
          ) && worker.logs.includes(`[estimation:${ESTIMATION_ID}] completed`)
            ? true
            : undefined,
        45_000,
      );
      const after = diagnostics(worker, tracker);

      expect(tracker.searches, after).toEqual([query, query]);
      expect(worker.runRecords(), after).toHaveLength(1);
      expect(worker.runRecords()[0]?.origin, after).toBe("estimate");
      expect(worker.agentInvocations(), after).toEqual([
        { mode: "estimate", automation: ESTIMATION_ID },
      ]);
      expect(await estimationComments(tracker, eligible.key), after).toHaveLength(1);
      expect(comments[0]?.id, after).toBe((await estimationComments(tracker, eligible.key))[0]?.id);
      expect(tracker.getStoryPoints(eligible.key), after).toBe(3);
      expect(tracker.getStoryPoints(young.key), after).toBeUndefined();
      expect(await tracker.listComments(young.key), after).toEqual([]);
      expect(tracker.getStoryPoints(decoy.key), after).toBeUndefined();
      expect(worker.logs, after).toContain(`Skipping ${young.key}`);
      expect(worker.logs, after).toContain("(< 24h)");
      expect(
        worker.logs.match(/\[estimation:groom\] starting scheduled run/g) ?? [],
        after,
      ).toHaveLength(1);
      const secondCursor = scheduleRow(worker, SCHEDULE_KEY);
      expect(secondCursor?.last_scheduled_at, after).toBe(secondDue);
      expect(secondCursor?.next_due_at ?? 0, after).toBeGreaterThan(Date.now());
      expect(scheduleRow(worker, DISABLED_SCHEDULE_KEY), after).toBeUndefined();
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
        residue.push(`fake Jira server: ${error instanceof Error ? error.message : String(error)}`);
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
  // The 15m interval is never waited out; a real wait would exceed this budget.
  120_000,
);
