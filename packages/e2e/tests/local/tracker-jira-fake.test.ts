import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  createOfflineJira,
  prepareJiraWorkspace,
  seedJiraScenario,
  statusesFor,
} from "../../helpers/offline-jira";
import type { JiraSeed } from "../../helpers/offline-jira";
import {
  assertImplementationComment,
  assertTicketState,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";
import { TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import { FakeJiraTracker } from "../../providers/fake-jira";

/** Assert the pushed branch, diff, run record, tracker state, and comments. */
async function assertJiraLifecycle(
  run: FixtureWorkspace,
  tracker: FakeJiraTracker,
  seed: JiraSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const key = seed.issue.key;
  const branch = `feature/${key.toLowerCase()}`;

  // The CLI pushed the exact branch it created to the local bare remote.
  expect(await run.git("branch", "--show-current")).toBe(branch);
  expect(await run.remoteSha(branch)).toBe(await run.git("rev-parse", "HEAD"));
  expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
  expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
    'export const greeting = "Hello, world!";',
  );

  // Exactly the selected ticket produced a run; the decoy did not.
  const records = run.runRecords({ allTasks: true });
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("succeeded");
  expect(records[0]?.tracker).toBe("jira");
  expect(records[0]?.task_key).toBe(key);
  expect(records[0]?.pr_url).toBeNull();
  expect(records.some((record) => record.task_key === seed.decoy.key)).toBe(false);
  expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();
  expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);

  // Read the final workflow status back through the fake, not CLI stdout.
  const status = await tracker.getStatus(key);
  const ticket = await tracker.getTicket(key);
  expect(status).toBe(statuses.prStatus);
  assertTicketState({
    ticket,
    openState: tracker.openState,
    descriptionMarker: seed.descriptionMarker,
    statuses,
    seedLabels: [TRACKER_UNRELATED_LABEL],
    statusKind: "state",
    status,
  });

  // The implementation comment and the seeded prompt comment are durable.
  const comments = await tracker.listComments(key);
  assertImplementationComment(comments);
  expect(
    comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER)),
  ).toHaveLength(1);
  expect(comments.some((comment) => comment.body.includes(seed.commentMarker))).toBe(true);

  // The decoy has no comment, status change, or branch.
  const decoyState = await tracker.getTicket(seed.decoy.key);
  expect(await tracker.getStatus(seed.decoy.key)).toBe(statuses.todoStatus);
  expect(decoyState.body).toContain(seed.decoyMarker);
  expect(decoyState.body).not.toContain(seed.descriptionMarker);
  expect(await tracker.listComments(seed.decoy.key)).toEqual([]);

  expect(tracker.unexpectedRequests).toEqual([]);
}

test.skipIf(!existsSync(cliPath))(
  "built CLI implements a Jira issue selected by key against an offline fake server",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);

      const result = await run.runTask({ taskRef: seed.issue.key, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertJiraLifecycle(run, tracker, seed, statuses);

      // A second run with --skip-comments must not post another comment or
      // regress the first run's status and implementation comment.
      const before = await tracker.listComments(seed.issue.key);
      const second = await run.runTask({
        taskRef: seed.issue.key,
        skipComments: true,
      });
      expect(second.exitCode).toBe(0);
      const after = await tracker.listComments(seed.issue.key);
      expect(after.map((comment) => comment.id)).toEqual(before.map((comment) => comment.id));
      expect(await tracker.getStatus(seed.issue.key)).toBe(statuses.prStatus);
      assertImplementationComment(after);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI selects only the marked Jira issue through --query against an offline fake server",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);

      const jql = `text ~ "${seed.descriptionMarker}"`;
      const selected = await tracker.findTickets(jql);
      expect(selected.map((ticket) => ticket.key)).toEqual([seed.issue.key]);

      const result = await run.runTask({ query: jql, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertJiraLifecycle(run, tracker, seed, statuses);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);
