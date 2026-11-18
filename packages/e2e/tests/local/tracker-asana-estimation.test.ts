import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeAsanaTracker } from "../../providers/fake-asana";

/**
 * Asana estimation is comment-only by default: without a configured
 * `storyPointsField`/`ASANA_STORY_POINTS_FIELD`, `discoverEstimationField`
 * returns null without an API call, so the CLI writes a marked story
 * (`POST /tasks/{gid}/stories`) and later edits it (`PUT /stories/{gid}`).
 */
const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const NO_FIELD_NOTICE = "No story points field found — skipping field update";
/**
 * The shared markdown->Asana HTML converter renders the `Story Points | Confidence`
 * line as a `<pre>` block, so the stored text keeps literal `**` markers. Match
 * the points value with or without that markup.
 */
const storyPoints = (points: number): RegExp => new RegExp(`Story Points:(\\*\\*)? ${points}\\b`);
const TASK_BODY =
  "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n";

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareEstimationWorkspace(
  run: FixtureWorkspace,
  tracker: FakeAsanaTracker,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", tracker.environment());
}

/** Run `devintern <gid> --estimate` through the isolated fixture. */
function runEstimate(run: FixtureWorkspace, key: string, options: { skipComments?: boolean } = {}) {
  return run.runTask({
    taskRef: key,
    skipComments: options.skipComments,
    extraArgs: ["--estimate"],
  });
}

/** Estimation stories read back through the fake's state, not CLI stdout. */
async function estimationComments(
  tracker: FakeAsanaTracker,
  key: string,
): Promise<Array<{ id: string; body: string }>> {
  const comments = await tracker.listComments(key);
  return comments.filter((comment) => comment.body.includes(ESTIMATION_COMMENT_MARKER));
}

/** Requests that would write a task field (custom field, notes, completion). */
function taskWrites(tracker: FakeAsanaTracker): string[] {
  return tracker.requests.filter((request) => request.startsWith("PUT /api/1.0/tasks/"));
}

function storyPosts(tracker: FakeAsanaTracker, key: string): string[] {
  return tracker.requests.filter((request) =>
    request.startsWith(`POST /api/1.0/tasks/${key}/stories`),
  );
}

function storyUpdates(tracker: FakeAsanaTracker): string[] {
  return tracker.requests.filter((request) => request.startsWith("PUT /api/1.0/stories/"));
}

/** Read the persisted estimation artifact from the isolated output directory. */
function readEstimationResult(run: FixtureWorkspace, key: string): unknown {
  const path = join(run.env.DEVINTERN_OUTPUT_DIR, key.toLowerCase(), "estimation-result.json");
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Estimation is read-only: no branch, commit, or push reached the remote. */
async function assertNoGitDelivery(run: FixtureWorkspace, key: string): Promise<void> {
  expect(await run.git("status", "--porcelain")).toBe("");
  expect(await run.git("branch", "--show-current")).toBe(run.base);
  expect(await run.remoteSha(`feature/${key.toLowerCase()}`)).toBeUndefined();
}

test.skipIf(!existsSync(cliPath))(
  "built CLI estimates an Asana task comment-only, then updates the same story in place",
  async () => {
    const tracker = new FakeAsanaTracker();
    const run = new FixtureWorkspace();
    try {
      const issue: TrackerTicket = await tracker.createTicket({
        title: "Expand the greeting",
        body: TASK_BODY,
      });
      await prepareEstimationWorkspace(run, tracker);

      const first = await runEstimate(run, issue.key, { skipComments: false });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain(NO_FIELD_NOTICE);

      const records = run.runRecords({ allTasks: true });
      expect(records).toHaveLength(1);
      expect(records[0]?.origin).toBe("estimate");
      expect(records[0]?.status).toBe("succeeded");
      expect(records[0]?.tracker).toBe("asana");
      expect(records[0]?.task_key).toBe(issue.key);
      expect(records[0]?.pr_url).toBeNull();

      const firstComments = await estimationComments(tracker, issue.key);
      expect(firstComments).toHaveLength(1);
      expect(firstComments[0]?.body).toMatch(storyPoints(3));
      const estimationStoryId = firstComments[0]!.id;
      expect(storyPosts(tracker, issue.key)).toHaveLength(1);
      expect(storyUpdates(tracker)).toEqual([]);
      // Comment-only: no custom field (or any other task field) was written.
      expect(taskWrites(tracker)).toEqual([]);

      expect(readEstimationResult(run, issue.key)).toMatchObject({
        storyPoints: 3,
        confidence: "high",
        implementationConfidence: 8,
      });
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);

      // Unchanged task: the durable baseline skips it without an agent run.
      const unchanged = await runEstimate(run, issue.key, { skipComments: false });
      expect(unchanged.exitCode).toBe(0);
      expect(unchanged.stdout).toContain("already estimated and not updated since");
      expect(run.agentInvocations()).toHaveLength(1);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);
      expect((await estimationComments(tracker, issue.key)).map((c) => c.id)).toEqual([
        estimationStoryId,
      ]);
      expect(storyPosts(tracker, issue.key)).toHaveLength(1);

      // A human edit bumps `modified_at` past the baseline: re-estimate and
      // rewrite the same story through `PUT /stories/{gid}`.
      tracker.editTicket(issue.key, {
        body: `${TASK_BODY}\nScope changed: keep the greeting export stable.\n`,
      });
      run.env.E2E_ESTIMATE_POINTS = "5";
      const updated = await runEstimate(run, issue.key, { skipComments: false });
      expect(updated.exitCode).toBe(0);
      expect(updated.stdout).toContain("Re-estimating");

      const updatedComments = await estimationComments(tracker, issue.key);
      expect(updatedComments).toHaveLength(1);
      expect(updatedComments[0]?.id).toBe(estimationStoryId);
      expect(updatedComments[0]?.body).toMatch(storyPoints(5));
      expect(updatedComments[0]?.body).not.toMatch(storyPoints(3));
      expect(storyPosts(tracker, issue.key)).toHaveLength(1);
      expect(storyUpdates(tracker)).toEqual([`PUT /api/1.0/stories/${estimationStoryId}`]);
      expect(taskWrites(tracker)).toEqual([]);
      expect(readEstimationResult(run, issue.key)).toMatchObject({ storyPoints: 5 });
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "estimate",
        "estimate",
      ]);
      expect(run.runRecords({ allTasks: true }).map((record) => record.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);

      // The story edit is the estimation's own write, not a user change.
      const steadyState = await runEstimate(run, issue.key, { skipComments: false });
      expect(steadyState.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(2);
      expect(await estimationComments(tracker, issue.key)).toHaveLength(1);
      expect(storyUpdates(tracker)).toHaveLength(1);

      await assertNoGitDelivery(run, issue.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI fails an Asana --estimate with --skip-comments because nothing can be written",
  async () => {
    const tracker = new FakeAsanaTracker();
    const run = new FixtureWorkspace();
    try {
      const issue = await tracker.createTicket({ title: "Expand the greeting", body: TASK_BODY });
      await prepareEstimationWorkspace(run, tracker);

      // No field and no comment: the attempt wrote nothing, which the product
      // classifies as a failed estimation (exit 1) rather than a silent success.
      const result = await runEstimate(run, issue.key);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(NO_FIELD_NOTICE);
      expect(result.stdout).toContain("Skipping estimation comment (--skip-comments)");
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Estimation wrote nothing to the tracker",
      );

      const records = run.runRecords({ allTasks: true });
      expect(records).toHaveLength(1);
      expect(records[0]?.origin).toBe("estimate");
      expect(records[0]?.status).toBe("failed");
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);
      // The local artifact is still saved even though the tracker was not written.
      expect(readEstimationResult(run, issue.key)).toMatchObject({ storyPoints: 3 });

      expect(await tracker.listComments(issue.key)).toEqual([]);
      expect(storyPosts(tracker, issue.key)).toEqual([]);
      expect(storyUpdates(tracker)).toEqual([]);
      expect(taskWrites(tracker)).toEqual([]);

      // The durable retry marker re-runs the agent on the next sweep instead of
      // treating the unwritten estimate as settled.
      const repeat = await runEstimate(run, issue.key);
      expect(repeat.exitCode).toBe(1);
      expect(run.agentInvocations()).toHaveLength(2);
      expect(run.runRecords({ allTasks: true }).map((record) => record.status)).toEqual([
        "failed",
        "failed",
      ]);
      expect(await tracker.listComments(issue.key)).toEqual([]);

      await assertNoGitDelivery(run, issue.key);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);
