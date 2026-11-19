import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomationSchedule } from "../../helpers/worker";
import {
  AZURE_DEVOPS_STORY_POINTS_FIELD,
  FakeAzureDevOpsTracker,
} from "../../providers/fake-azure-devops";

/**
 * Worker `[[estimations]]` schedule against the offline Azure DevOps fake.
 *
 * A due sweep runs `devintern --estimate --query <WIQL> --no-git` as an
 * `estimate`-origin child attributed to the estimation id. The sweep must
 * select every matching work item through the WIQL route (not one key),
 * estimate the old ones, skip a same-query item younger than 24 hours, leave a
 * decoy outside the query alone, and make no new writes on a later due sweep
 * when nothing changed. Mirrors `worker-scheduled-estimation.test.ts` (Jira).
 */

const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const ESTIMATION_ID = "groom";
/** Durable scheduler key. Estimations are namespaced so they cannot collide with automations. */
const SCHEDULE_KEY = `estimation:${ESTIMATION_ID}`;
const INTERVAL = "15m";
const INTERVAL_MS = 15 * 60 * 1000;

function scheduleRow(worker: WorkerFixture): WorkerAutomationSchedule | undefined {
  return worker.automationSchedules().find((row) => row.automation_id === SCHEDULE_KEY);
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

function diagnostics(worker: WorkerFixture, tracker: FakeAzureDevOpsTracker, detail = ""): string {
  const pat = tracker.environment().AZURE_DEVOPS_PAT ?? "";
  return redact(
    [
      detail,
      `wiql: ${JSON.stringify(tracker.wiqlRequests)}`,
      `runs: ${JSON.stringify(worker.runRecords())}`,
      `schedules: ${JSON.stringify(worker.automationSchedules())}`,
      `agent: ${JSON.stringify(worker.agentInvocations())}`,
      `unexpected: ${JSON.stringify(tracker.unexpectedRequests)}`,
      worker.tail(),
    ]
      .filter(Boolean)
      .join("\n"),
    [pat],
  );
}

/** Estimation comments as stored by the fake (raw HTML). */
function estimationComments(tracker: FakeAzureDevOpsTracker, key: string) {
  return tracker
    .rawComments(key)
    .filter((comment) => comment.text.includes(ESTIMATION_COMMENT_MARKER));
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
  "scheduled Azure DevOps estimation sweeps every WIQL match once and skips unchanged work items",
  async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const marker = `E2EAZEST${token}`;
    const decoyMarker = `E2EAZDECOY${token}`;
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS '${marker}'`;
    // Deterministic clock: seeded items are stamped 2026-01-01, well past the
    // product's 24h new-task gate, until `setNow` moves the clock to now.
    const tracker = new FakeAzureDevOpsTracker();
    const worker = new WorkerFixture({
      tracker: "azure-devops",
      rootPrefix: "devintern-e2e-worker-azdo-est-",
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
        title: "Expand the greeting",
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
        labels: [marker],
      });
      const second = await tracker.createTicket({
        title: "Document the greeting",
        body: "# Document the greeting\n\nAdd a README line describing the greeting.\n",
        labels: [marker],
      });
      // Old enough to estimate, but outside the query.
      const decoy = await tracker.createTicket({
        title: "Expand the greeting (decoy)",
        body: "# Decoy\n\nOutside the scheduled query.\n",
        labels: [decoyMarker],
      });
      tracker.setNow(Date.now());
      // Matches the query but was just created: selected, then skipped (< 24h).
      const young = await tracker.createTicket({
        title: "Expand the greeting (too new)",
        body: "# Too new\n\nThis work item matches the query but was just created.\n",
        labels: [marker],
      });
      const estimated = [first.key, second.key].sort();

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
        "the estimation scheduler to register the Azure DevOps entry",
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
      expect(tracker.wiqlRequests, diagnostics(worker, tracker)).toEqual([]);

      // Make the occurrence due without waiting out the interval.
      await worker.stop();
      const firstDue = Date.now() - INTERVAL_MS;
      worker.setScheduleNextDue(SCHEDULE_KEY, firstDue);
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        new RegExp(`\\[estimation:${ESTIMATION_ID}\\] completed`),
        60_000,
        "the first estimation sweep to finish",
      );
      const detail = diagnostics(worker, tracker);

      // The sweep selected through WIQL exactly once, with the configured query.
      expect(
        tracker.wiqlRequests.map((request) => request.query),
        detail,
      ).toEqual([query]);
      expect([...(tracker.wiqlRequests[0]?.ids ?? [])].map(String).sort(), detail).toEqual(
        [...estimated, young.key].sort(),
      );

      // One estimate-origin run per estimated work item, attributed to the schedule.
      const runs = worker.runRecords();
      expect(runs.map((run) => run.task_key).sort(), detail).toEqual(estimated);
      for (const run of runs) {
        expect(run.origin, detail).toBe("estimate");
        expect(run.automation_id, detail).toBe(ESTIMATION_ID);
        expect(run.status, detail).toBe("succeeded");
        expect(run.branch, detail).toBeNull();
        expect(run.pr_url, detail).toBeNull();
        expect(run.repo, detail).toBeNull();
      }
      expect(
        worker.logs.match(/\[estimation:groom\] starting scheduled run/g) ?? [],
        detail,
      ).toHaveLength(1);
      const cursor = scheduleRow(worker);
      expect(cursor?.last_scheduled_at, detail).toBe(firstDue);
      expect(cursor?.next_due_at ?? 0, detail).toBeGreaterThan(Date.now());

      // Each estimated item: default field written once, exactly one comment.
      const firstComments = new Map<string, ReturnType<typeof estimationComments>>();
      for (const key of estimated) {
        expect(tracker.getStoryPoints(key), detail).toBe(3);
        const comments = estimationComments(tracker, key);
        expect(comments, detail).toHaveLength(1);
        firstComments.set(key, comments);
        expect(await tracker.getStatus(key), detail).toBe(tracker.statuses.todo);
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
      for (const key of [young.key, decoy.key]) {
        expect(tracker.getStoryPoints(key), detail).toBeUndefined();
        expect(tracker.rawComments(key), detail).toEqual([]);
        expect(existsSync(join(worker.env.DEVINTERN_OUTPUT_DIR, key.toLowerCase())), detail).toBe(
          false,
        );
      }
      expect(worker.logs, detail).toContain(`Skipping ${young.key}`);
      expect(worker.logs, detail).toContain("(< 24h)");
      expect(worker.logs, detail).not.toContain("already estimated and not updated since");
      expect(worker.agentInvocations(), detail).toEqual([
        { mode: "estimate", automation: ESTIMATION_ID },
        { mode: "estimate", automation: ESTIMATION_ID },
      ]);
      await assertReadOnlyGit(worker);

      // A later due occurrence sweeps again; nothing changed, so no new writes.
      await worker.stop();
      const secondDue = Date.now() - 1_000;
      worker.setScheduleNextDue(SCHEDULE_KEY, secondDue);
      worker.start();
      await worker.waitForReady();
      await worker.waitFor(
        "the second sweep to skip both unchanged work items",
        () =>
          estimated.every((key) =>
            worker.logs.includes(`Skipping ${key} — already estimated and not updated since`),
          ) && worker.logs.includes(`[estimation:${ESTIMATION_ID}] completed`)
            ? true
            : undefined,
        60_000,
      );
      const after = diagnostics(worker, tracker);

      expect(
        tracker.wiqlRequests.map((request) => request.query),
        after,
      ).toEqual([query, query]);
      expect(worker.runRecords(), after).toHaveLength(2);
      expect(worker.agentInvocations(), after).toHaveLength(2);
      for (const key of estimated) {
        expect(tracker.getStoryPoints(key), after).toBe(3);
        expect(estimationComments(tracker, key), after).toEqual(firstComments.get(key) ?? []);
      }
      for (const key of [young.key, decoy.key]) {
        expect(tracker.getField(key, AZURE_DEVOPS_STORY_POINTS_FIELD), after).toBeUndefined();
        expect(tracker.rawComments(key), after).toEqual([]);
      }
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
          `fake Azure DevOps server: ${error instanceof Error ? error.message : String(error)}`,
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
  150_000,
);
