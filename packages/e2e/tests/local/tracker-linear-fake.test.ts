import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  assertImplementationComment,
  assertTicketState,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings, TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeLinearTracker } from "../../providers/fake-linear";

interface LinearSeed {
  issue: TrackerTicket;
  decoy: TrackerTicket;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
}

/**
 * Seed the expected issue and a decoy outside the selector.
 *
 * The unique description marker is also embedded in the title because the
 * `--query` scenario uses Linear's title filter. The lifecycle test configures
 * the same workflow state for `inProgressStatus` and `prStatus`: the local bare
 * remote is not a supported code host, so the CLI can push its branch but
 * cannot complete the PR that would trigger a separate post-PR transition. The
 * run still exercises the real workflow-state lookup and update operations.
 */
async function seedLinearScenario(tracker: FakeLinearTracker): Promise<LinearSeed> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const descriptionMarker = `E2EDESCRIPTIONMARKER${token}`;
  const commentMarker = `E2ECOMMENTMARKER${token}`;
  const decoyMarker = `E2EDECOY${token}`;

  const decoy = await tracker.createTicket({
    title: "Expand the greeting (decoy)",
    body: `# Decoy\n\nThis issue is outside the scenario selector and must stay untouched.\n\n${decoyMarker}\n`,
  });
  const issue = await tracker.createTicket({
    title: `Expand the greeting ${descriptionMarker}`,
    body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${descriptionMarker}\n`,
    labels: [TRACKER_UNRELATED_LABEL],
  });
  await tracker.addComment(issue.key, `Please keep the change minimal.\n\n${commentMarker}\n`);
  return { issue, decoy, descriptionMarker, commentMarker, decoyMarker };
}

/**
 * Status settings for the offline lifecycle. `prStatus` intentionally equals
 * `inProgressStatus` because no PR is created against the local bare remote.
 */
function statusesFor(tracker: FakeLinearTracker): Required<TrackerStatusSettings> {
  return {
    todoStatus: tracker.statuses.todo,
    inProgressStatus: tracker.statuses.inProgress,
    prStatus: tracker.statuses.inProgress,
  };
}

/** Write the per-team Linear statuses the CLI applies during the run. */
function writeLinearSettings(
  run: FixtureWorkspace,
  teamKey: string,
  statuses: Required<TrackerStatusSettings>,
): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("linear", teamKey, statuses), null, 2)}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareLinearWorkspace(
  run: FixtureWorkspace,
  tracker: FakeLinearTracker,
  seed: LinearSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeLinearSettings(run, tracker.projectKey(), statuses);
}

/** Assert the pushed branch, diff, run record, tracker state, and comments. */
async function assertLinearLifecycle(
  run: FixtureWorkspace,
  tracker: FakeLinearTracker,
  seed: LinearSeed,
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
  expect(records[0]?.tracker).toBe("linear");
  expect(records[0]?.task_key).toBe(key);
  expect(records[0]?.pr_url).toBeNull();
  expect(records.some((record) => record.task_key === seed.decoy.key)).toBe(false);
  expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();
  expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);

  // Read the final workflow state back through the fake, not CLI stdout.
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

  // The decoy has no comment, state change, or branch.
  const decoyState = await tracker.getTicket(seed.decoy.key);
  expect(await tracker.getStatus(seed.decoy.key)).toBe(statuses.todoStatus);
  expect(decoyState.body).toContain(seed.decoyMarker);
  expect(decoyState.body).not.toContain(seed.descriptionMarker);
  expect(decoyState.labels).toEqual([]);
  expect(await tracker.listComments(seed.decoy.key)).toEqual([]);

  expect(tracker.unexpectedOperations).toEqual([]);
}

test.skipIf(!existsSync(cliPath))(
  "built CLI implements a Linear issue selected by key against an offline fake server",
  async () => {
    const tracker = new FakeLinearTracker();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedLinearScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareLinearWorkspace(run, tracker, seed, statuses);

      const result = await run.runTask({ taskRef: seed.issue.key, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertLinearLifecycle(run, tracker, seed, statuses);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI selects only the marked Linear issue through --query against an offline fake server",
  async () => {
    const tracker = new FakeLinearTracker();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedLinearScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareLinearWorkspace(run, tracker, seed, statuses);

      const filter = `{"title":{"containsIgnoreCase":"${seed.descriptionMarker}"}}`;
      const selected = await tracker.findTickets(filter);
      expect(selected.map((ticket) => ticket.key)).toEqual([seed.issue.key]);

      const result = await run.runTask({ query: filter, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertLinearLifecycle(run, tracker, seed, statuses);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);
