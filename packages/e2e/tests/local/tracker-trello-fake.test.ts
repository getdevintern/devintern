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
import { FakeTrelloTracker } from "../../providers/fake-trello";

interface TrelloSeed {
  card: TrackerTicket;
  decoy: TrackerTicket;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
}

/**
 * Seed the expected card and a decoy outside the selector.
 *
 * The lifecycle test configures the same list name for `inProgressStatus` and
 * `prStatus`: the local bare remote is not a supported code host, so the CLI
 * can push its branch but cannot complete the PR that triggers a separate
 * post-PR list move. The run still exercises the real list move (todo ->
 * actioned list).
 */
async function seedTrelloScenario(tracker: FakeTrelloTracker): Promise<TrelloSeed> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const descriptionMarker = `E2EDESCRIPTIONMARKER${token}`;
  const commentMarker = `E2ECOMMENTMARKER${token}`;
  const decoyMarker = `E2EDECOY${token}`;

  const decoy = await tracker.createTicket({
    title: "Expand the greeting (decoy)",
    body: `# Decoy\n\nThis card is outside the scenario selector and must stay untouched.\n\n${decoyMarker}\n`,
  });
  const card = await tracker.createTicket({
    title: "Expand the greeting",
    body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${descriptionMarker}\n`,
    labels: [TRACKER_UNRELATED_LABEL],
  });
  await tracker.addComment(card.key, `Please keep the change minimal.\n\n${commentMarker}\n`);
  return { card, decoy, descriptionMarker, commentMarker, decoyMarker };
}

/** Write the per-board Trello list settings the CLI applies during the run. */
function writeTrelloSettings(
  run: FixtureWorkspace,
  boardKey: string,
  statuses: Required<TrackerStatusSettings>,
): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("trello", boardKey, statuses), null, 2)}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareTrelloWorkspace(
  run: FixtureWorkspace,
  tracker: FakeTrelloTracker,
  seed: TrelloSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeTrelloSettings(run, tracker.projectKey(), statuses);
}

/** Assert the pushed branch, diff, run record, card state, and comments. */
async function assertTrelloLifecycle(
  run: FixtureWorkspace,
  tracker: FakeTrelloTracker,
  seed: TrelloSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const key = seed.card.key;
  const branch = `feature/${key.toLowerCase()}`;

  // The CLI pushed the exact branch it created to the local bare remote.
  expect(await run.git("branch", "--show-current")).toBe(branch);
  expect(await run.remoteSha(branch)).toBe(await run.git("rev-parse", "HEAD"));
  expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
  expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
    'export const greeting = "Hello, world!";',
  );

  // Exactly the selected card produced a run; the decoy did not.
  const records = run.runRecords({ allTasks: true });
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe("succeeded");
  expect(records[0]?.tracker).toBe("trello");
  expect(records[0]?.task_key).toBe(key);
  expect(records[0]?.pr_url).toBeNull();
  expect(records.some((record) => record.task_key === seed.decoy.key)).toBe(false);
  expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();
  expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);

  // Read the final list back through the fake, not CLI stdout.
  const status = await tracker.getStatus(key);
  const card = await tracker.getTicket(key);
  expect(status).toBe(statuses.prStatus);
  assertTicketState({
    ticket: card,
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

  // The decoy has no comment, list change, or branch.
  const decoyState = await tracker.getTicket(seed.decoy.key);
  expect(await tracker.getStatus(seed.decoy.key)).toBe(statuses.todoStatus);
  expect(decoyState.body).toContain(seed.decoyMarker);
  expect(decoyState.body).not.toContain(seed.descriptionMarker);
  expect(await tracker.listComments(seed.decoy.key)).toEqual([]);

  expect(tracker.unexpectedRequests).toEqual([]);
}

const statusesFor = (tracker: FakeTrelloTracker): Required<TrackerStatusSettings> => ({
  todoStatus: tracker.statuses.todo,
  inProgressStatus: tracker.statuses.inProgress,
  prStatus: tracker.statuses.pr,
});

/**
 * The offline lifecycle uses one actioned list for both the in-progress and
 * post-PR settings, because a local bare remote cannot create the PR that
 * would trigger a second list move.
 */
const createOfflineTrello = (): FakeTrelloTracker =>
  new FakeTrelloTracker({ statuses: { pr: "Doing" } });

test.skipIf(!existsSync(cliPath))(
  "built CLI implements a Trello card selected by short link against an offline fake server",
  async () => {
    const tracker = createOfflineTrello();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedTrelloScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareTrelloWorkspace(run, tracker, seed, statuses);

      const result = await run.runTask({ taskRef: seed.card.key, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertTrelloLifecycle(run, tracker, seed, statuses);

      // A second run with --skip-comments must not post another comment or
      // regress the first run's list and implementation comment.
      const before = await tracker.listComments(seed.card.key);
      const second = await run.runTask({ taskRef: seed.card.key, skipComments: true });
      expect(second.exitCode).toBe(0);
      const after = await tracker.listComments(seed.card.key);
      expect(after.map((comment) => comment.id)).toEqual(before.map((comment) => comment.id));
      expect(await tracker.getStatus(seed.card.key)).toBe(statuses.prStatus);
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
  "built CLI selects only the marked Trello card through --query against an offline fake server",
  async () => {
    const tracker = createOfflineTrello();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedTrelloScenario(tracker);
      const statuses = statusesFor(tracker);
      await prepareTrelloWorkspace(run, tracker, seed, statuses);

      const query = `is:open ${seed.descriptionMarker}`;
      const selected = await tracker.findTickets(query);
      expect(selected.map((ticket) => ticket.key)).toEqual([seed.card.key]);

      const result = await run.runTask({ query, skipComments: false });
      expect(result.exitCode).toBe(0);
      await assertTrelloLifecycle(run, tracker, seed, statuses);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);
