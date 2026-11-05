import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  assertImplementationComment,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";
import { buildTrackerSettings, TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import type { TrackerStatusSettings } from "../../helpers/tracker-scenario";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeJiraTracker } from "../../providers/fake-jira";

interface JiraSeed {
  issue: TrackerTicket;
  decoy: TrackerTicket;
  descriptionMarker: string;
  commentMarker: string;
  decoyMarker: string;
}

/** Header the Jira formatter renders for an incomplete implementation comment. */
const INCOMPLETE_COMMENT_MARKER = "Implementation Incomplete";

/**
 * Seed the expected issue and a decoy outside the selector.
 *
 * The offline lifecycle configures the same workflow name for
 * `inProgressStatus` and `prStatus`: the local bare remote is not a supported
 * code host, so the CLI can push its branch but cannot create the PR that
 * would trigger a separate post-PR transition.
 */
async function seedJiraScenario(tracker: FakeJiraTracker): Promise<JiraSeed> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const descriptionMarker = `E2EDESCRIPTIONMARKER${token}`;
  const commentMarker = `E2ECOMMENTMARKER${token}`;
  const decoyMarker = `E2EDECOY${token}`;

  const decoy = await tracker.createTicket({
    title: "Expand the greeting (decoy)",
    body: `# Decoy\n\nThis ticket is outside the scenario selector and must stay untouched.\n\n${decoyMarker}\n`,
  });
  const issue = await tracker.createTicket({
    title: "Expand the greeting",
    body: `# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n\n${descriptionMarker}\n`,
    labels: [TRACKER_UNRELATED_LABEL],
  });
  await tracker.addComment(issue.key, `Please keep the change minimal.\n\n${commentMarker}\n`);
  return { issue, decoy, descriptionMarker, commentMarker, decoyMarker };
}

/** Write the per-project Jira statuses the CLI applies during the run. */
function writeJiraSettings(
  run: FixtureWorkspace,
  projectKey: string,
  statuses: Required<TrackerStatusSettings>,
): void {
  const settingsDir = join(run.cwd, ".devintern-code");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify(buildTrackerSettings("jira", projectKey, statuses), null, 2)}\n`,
  );
}

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareJiraWorkspace(
  run: FixtureWorkspace,
  tracker: FakeJiraTracker,
  seed: JiraSeed,
  statuses: Required<TrackerStatusSettings>,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {
    ...tracker.environment(),
    E2E_EXPECT_DESCRIPTION_MARKER: seed.descriptionMarker,
    E2E_EXPECT_COMMENT_MARKER: seed.commentMarker,
  });
  writeJiraSettings(run, tracker.projectKey(), statuses);
}

const statusesFor = (tracker: FakeJiraTracker): Required<TrackerStatusSettings> => ({
  todoStatus: tracker.statuses.todo,
  inProgressStatus: tracker.statuses.inProgress,
  prStatus: tracker.statuses.pr,
});

/**
 * The offline lifecycle uses one actioned workflow status for both the
 * in-progress and post-PR settings, because a local bare remote cannot create
 * the PR that would trigger a second transition.
 */
const createOfflineJira = (): FakeJiraTracker =>
  new FakeJiraTracker({ statuses: { pr: "In Progress" } });

/** Comments that carry the incomplete-implementation header. */
function incompleteComments(comments: Array<{ body: string }>): Array<{ body: string }> {
  return comments.filter((comment) => comment.body.includes(INCOMPLETE_COMMENT_MARKER));
}

/** Comments that carry the implementation-success header. */
function implementationComments(comments: Array<{ body: string }>): Array<{ body: string }> {
  return comments.filter((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER));
}

test.skipIf(!existsSync(cliPath))(
  "built CLI skips an unchanged incomplete Jira task until --force unlocks a retry",
  async () => {
    const tracker = createOfflineJira();
    const run = new FixtureWorkspace();
    try {
      const seed = await seedJiraScenario(tracker);
      const key = seed.issue.key;
      const statuses = statusesFor(tracker);
      await prepareJiraWorkspace(run, tracker, seed, statuses);

      // 1. Incomplete attempt: escalated run, failure comment, ticket back in
      //    To Do, and no delivered branch.
      const incomplete = await run.runTask({
        taskRef: key,
        skipComments: false,
        agentMode: "incomplete",
      });
      expect(incomplete.exitCode).toBe(0);

      const afterIncomplete = run.runRecords({ allTasks: true });
      expect(afterIncomplete).toHaveLength(1);
      expect(afterIncomplete[0]).toMatchObject({
        task_key: key,
        tracker: "jira",
        status: "escalated",
        pr_url: null,
      });
      expect(afterIncomplete[0]?.status).not.toBe("succeeded");
      expect(await tracker.getStatus(key)).toBe(statuses.todoStatus);

      const commentsAfterIncomplete = await tracker.listComments(key);
      expect(incompleteComments(commentsAfterIncomplete)).toHaveLength(1);
      expect(incompleteComments(commentsAfterIncomplete)[0]?.body).toContain(
        "Implementation was unsuccessful",
      );
      expect(implementationComments(commentsAfterIncomplete)).toHaveLength(0);

      const incompleteBranch = run.recordedBranch(key);
      expect(incompleteBranch).toBeDefined();
      expect(await run.remoteSha(incompleteBranch!)).toBeUndefined();
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["incomplete"]);

      const bodyAfterIncomplete = (await tracker.getTicket(key)).body;
      const incompleteBranchSha = await run.git("rev-parse", incompleteBranch!);
      expect(await run.git("branch", "--show-current")).toBe(incompleteBranch!);

      // 2. Unchanged ticket without --force: documented skip, no agent, no run,
      //    and no tracker or branch mutation.
      const skipped = await run.runTask({
        taskRef: key,
        skipComments: false,
        agentMode: "implement",
      });
      expect(skipped.exitCode).toBe(0);
      expect(skipped.stdout).toContain(`Skipping ${key}`);
      expect(skipped.stdout).toContain("--force");

      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["incomplete"]);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);
      expect(await tracker.getStatus(key)).toBe(statuses.todoStatus);
      expect((await tracker.getTicket(key)).body).toBe(bodyAfterIncomplete);
      expect(await tracker.listComments(key)).toEqual(commentsAfterIncomplete);
      // The CLI's pre-task pull may move the local checkout to the target
      // branch, but the incomplete attempt's branch ref is untouched and never
      // published.
      expect(await run.git("rev-parse", incompleteBranch!)).toBe(incompleteBranchSha);
      expect(await run.remoteSha(incompleteBranch!)).toBeUndefined();

      // 3. Same unchanged ticket with --force: the agent reruns, the branch is
      //    published with the expected diff, and the ticket reaches the
      //    post-implementation status.
      const forced = await run.runTask({
        taskRef: key,
        skipComments: false,
        agentMode: "implement",
        force: true,
      });
      expect(forced.exitCode).toBe(0);

      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "incomplete",
        "implement",
      ]);
      const afterForce = run.runRecords({ allTasks: true });
      expect(afterForce).toHaveLength(2);
      expect(afterForce[1]).toMatchObject({
        task_key: key,
        tracker: "jira",
        status: "succeeded",
        pr_url: null,
      });

      // The pipeline records the branch it actually created or resumed; never
      // assume the unsuffixed name when a prior attempt may own it.
      const branch = run.recordedBranch(key);
      expect(branch).toBeDefined();
      expect(await run.git("branch", "--show-current")).toBe(branch!);
      expect(await run.remoteSha(branch!)).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
      expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );

      expect(await tracker.getStatus(key)).toBe(statuses.prStatus);
      const commentsAfterForce = await tracker.listComments(key);
      assertImplementationComment(commentsAfterForce);
      expect(implementationComments(commentsAfterForce)).toHaveLength(1);
      expect(incompleteComments(commentsAfterForce)).toHaveLength(1);
      expect(commentsAfterForce.map((comment) => comment.id)).toEqual(
        expect.arrayContaining(commentsAfterIncomplete.map((comment) => comment.id)),
      );

      // The decoy never ran: no record, comment, transition, or branch.
      expect(afterForce.some((record) => record.task_key === seed.decoy.key)).toBe(false);
      expect(await tracker.getStatus(seed.decoy.key)).toBe(statuses.todoStatus);
      const decoyTicket = await tracker.getTicket(seed.decoy.key);
      expect(decoyTicket.body).toContain(seed.decoyMarker);
      expect(decoyTicket.body).not.toContain(seed.descriptionMarker);
      expect(await tracker.listComments(seed.decoy.key)).toEqual([]);
      expect(await run.remoteSha(`feature/${seed.decoy.key.toLowerCase()}`)).toBeUndefined();

      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  240_000,
);
