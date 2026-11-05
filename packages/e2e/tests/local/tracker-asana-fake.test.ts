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
import {
  buildTrackerSettings,
  collectTrackerCleanupFailures,
  TRACKER_UNRELATED_LABEL,
} from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import { throwCleanupFailures } from "../../helpers/cleanup";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeAsanaTracker } from "../../providers/fake-asana";

interface AsanaSeed {
  issue: TrackerTicket;
  decoy: TrackerTicket;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
  commentId: string;
}

/**
 * Seed the expected task and a decoy outside the selector.
 *
 * The lifecycle test configures the same section for `inProgressStatus` and
 * `prStatus`: the local bare remote is not a supported code host, so the CLI
 * can push its branch but cannot complete the PR that would trigger a separate
 * post-PR transition. The run still exercises the real section move
 * (todo -> actioned section).
 */
async function seedAsanaScenario(tracker: FakeAsanaTracker): Promise<AsanaSeed> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const descriptionMarker = `E2EDESCRIPTIONMARKER${token}`;
  const commentMarker = `E2ECOMMENTMARKER${token}`;
  const decoyMarker = `E2EDECOY${token}`;

  const decoy = await tracker.createTicket({
    title: "Backlog grooming (decoy)",
    body: `# Decoy\n\nThis task is outside the scenario selector and must stay untouched.\n\n${decoyMarker}\n`,
  });
  const issue = await tracker.createTicket({
    title: "Expand the greeting",
    body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${descriptionMarker}\n`,
    labels: [TRACKER_UNRELATED_LABEL],
  });
  const commentId = await tracker.addComment(
    issue.key,
    `Please keep the change minimal.\n\n${commentMarker}\n`,
  );
  return { issue, decoy, descriptionMarker, commentMarker, decoyMarker, commentId };
}

/** Write the per-project Asana section names the CLI applies during the run. */
function writeAsanaSettings(
  run: FixtureWorkspace,
  projectGid: string,
  statuses: Required<TrackerStatusSettings>,
): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("asana", projectGid, statuses), null, 2)}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareAsanaWorkspace(
  run: FixtureWorkspace,
  tracker: FakeAsanaTracker,
  seed: AsanaSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeAsanaSettings(run, tracker.projectKey(), statuses);
}

/** Assert the pushed branch, diff, run record, tracker state, and comments. */
async function assertAsanaLifecycle(
  run: FixtureWorkspace,
  tracker: FakeAsanaTracker,
  seed: AsanaSeed,
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

  // Exactly the selected task produced a run; the decoy did not.
  const records = run.runRecords({ allTasks: true });
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("succeeded");
  expect(records[0]?.tracker).toBe("asana");
  expect(records[0]?.task_key).toBe(key);
  expect(records[0]?.pr_url).toBeNull();
  expect(records.some((record) => record.task_key === seed.decoy.key)).toBe(false);
  expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();
  expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);

  // Read the final section back through the fake, not CLI stdout.
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

  // The decoy has no comment, section change, or branch.
  const decoyState = await tracker.getTicket(seed.decoy.key);
  expect(await tracker.getStatus(seed.decoy.key)).toBe(statuses.todoStatus);
  expect(decoyState.body).toContain(seed.decoyMarker);
  expect(decoyState.body).not.toContain(seed.descriptionMarker);
  expect(await tracker.listComments(seed.decoy.key)).toEqual([]);

  expect(tracker.unexpectedRequests).toEqual([]);
}

/**
 * Delete the seeded story and close the scenario-owned tasks, then stop the
 * fake server and remove the fixture root even after an assertion failure.
 */
async function cleanupAsanaScenario(
  tracker: FakeAsanaTracker,
  seed: AsanaSeed | undefined,
  run: FixtureWorkspace,
): Promise<void> {
  try {
    const failures = await collectTrackerCleanupFailures(tracker, {
      ticketKeys: seed ? [seed.issue.key, seed.decoy.key] : [],
      commentIds: seed ? [seed.commentId] : [],
    });
    throwCleanupFailures("Asana fake cleanup failed", failures);
  } finally {
    await tracker.cleanup();
    run.dispose();
  }
}

const statusesFor = (tracker: FakeAsanaTracker): Required<TrackerStatusSettings> => ({
  todoStatus: tracker.statuses.todo,
  inProgressStatus: tracker.statuses.inProgress,
  prStatus: tracker.statuses.pr,
});

/**
 * The offline lifecycle uses one actioned section for both the in-progress and
 * post-PR settings, because a local bare remote cannot create the PR that
 * would trigger a second section move.
 */
const createOfflineAsana = (): FakeAsanaTracker =>
  new FakeAsanaTracker({ statuses: { pr: "In Progress" } });

test.skipIf(!existsSync(cliPath))(
  "built CLI implements an Asana task selected by key against an offline fake server",
  async () => {
    const tracker = createOfflineAsana();
    const run = new FixtureWorkspace();
    let seed: AsanaSeed | undefined;
    try {
      seed = await seedAsanaScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareAsanaWorkspace(run, tracker, seed, statuses);

      const result = await run.runTask({ taskRef: seed.issue.key, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertAsanaLifecycle(run, tracker, seed, statuses);
    } finally {
      await cleanupAsanaScenario(tracker, seed, run);
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI selects only the marked Asana task through --query against an offline fake server",
  async () => {
    const tracker = createOfflineAsana();
    const run = new FixtureWorkspace();
    let seed: AsanaSeed | undefined;
    try {
      seed = await seedAsanaScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareAsanaWorkspace(run, tracker, seed, statuses);

      const query = `project:${tracker.projectKey()} section:"${statuses.todoStatus}" Expand the greeting`;
      const selected = await tracker.findTickets(query);
      expect(selected.map((ticket) => ticket.key)).toEqual([seed.issue.key]);

      const result = await run.runTask({ query, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertAsanaLifecycle(run, tracker, seed, statuses);
    } finally {
      await cleanupAsanaScenario(tracker, seed, run);
    }
  },
  90_000,
);
