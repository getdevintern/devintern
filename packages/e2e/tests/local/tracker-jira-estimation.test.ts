import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import type { TrackerTicket } from "../../providers/tracker";
import { FakeJiraTracker } from "../../providers/fake-jira";

const STORY_POINTS_FIELD = "customfield_10016";
const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";

/** Write the explicit story-points custom field the estimation run must use. */
function writeEstimationSettings(run: FixtureWorkspace, projectKey: string): void {
  const settingsDir = join(run.cwd, ".devintern-code");
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

/** Initialize the isolated local bare remote and prepare the CLI workspace. */
async function prepareEstimationWorkspace(
  run: FixtureWorkspace,
  tracker: FakeJiraTracker,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", tracker.environment());
  writeEstimationSettings(run, tracker.projectKey());
}

/** Run `devintern <key> --estimate` through the isolated fixture. */
function runEstimate(run: FixtureWorkspace, key: string, options: { skipComments?: boolean } = {}) {
  return run.runTask({
    taskRef: key,
    skipComments: options.skipComments,
    extraArgs: ["--estimate"],
  });
}

/** Estimation comments read back through the fake, not the CLI's stdout. */
async function estimationComments(
  tracker: FakeJiraTracker,
  key: string,
): Promise<Array<{ id: string; body: string }>> {
  const comments = await tracker.listComments(key);
  return comments.filter((comment) => comment.body.includes(ESTIMATION_COMMENT_MARKER));
}

/** Read the persisted estimation artifact from the isolated output directory. */
function readEstimationResult(run: FixtureWorkspace, key: string): unknown {
  const path = join(run.env.DEVINTERN_OUTPUT_DIR, key.toLowerCase(), "estimation-result.json");
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

test.skipIf(!existsSync(cliPath))(
  "built CLI estimates story points through the offline fake Jira server",
  async () => {
    const tracker = new FakeJiraTracker();
    const run = new FixtureWorkspace();
    try {
      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
      });
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, issue.key, { skipComments: false });
      expect(result.exitCode).toBe(0);

      const records = run.runRecords({ allTasks: true });
      expect(records).toHaveLength(1);
      expect(records[0]?.origin).toBe("estimate");
      expect(records[0]?.status).toBe("succeeded");
      expect(records[0]?.task_key).toBe(issue.key);
      expect(records[0]?.pr_url).toBeNull();

      expect(tracker.getStoryPoints(issue.key)).toBe(3);
      const comments = await estimationComments(tracker, issue.key);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Story Points: 3");

      expect(readEstimationResult(run, issue.key)).toMatchObject({
        storyPoints: 3,
        confidence: "high",
        implementationConfidence: 8,
      });
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);

      // Estimation is read-only: no branch, commit, or push reached the remote.
      expect(await run.git("status", "--porcelain")).toBe("");
      expect(await run.git("branch", "--show-current")).toBe(run.base);
      expect(await run.remoteSha(`feature/${issue.key.toLowerCase()}`)).toBeUndefined();
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI skips unchanged Jira issues and updates an existing estimation",
  async () => {
    const tracker = new FakeJiraTracker();
    const run = new FixtureWorkspace();
    try {
      const issue: TrackerTicket = await tracker.createTicket({
        title: "Expand the greeting",
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
      });
      await prepareEstimationWorkspace(run, tracker);

      const first = await runEstimate(run, issue.key, { skipComments: false });
      expect(first.exitCode).toBe(0);
      const firstComments = await estimationComments(tracker, issue.key);
      expect(firstComments).toHaveLength(1);
      const estimationCommentId = firstComments[0]?.id;
      expect(tracker.getStoryPoints(issue.key)).toBe(3);
      expect(run.agentInvocations()).toHaveLength(1);

      // No issue change: the existing estimation is reused without an attempt.
      const unchanged = await runEstimate(run, issue.key, { skipComments: false });
      expect(unchanged.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(1);
      const unchangedComments = await estimationComments(tracker, issue.key);
      expect(unchangedComments.map((comment) => comment.id)).toEqual([estimationCommentId!]);
      expect(tracker.getStoryPoints(issue.key)).toBe(3);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);

      // A later tracker update re-estimates and rewrites the same comment.
      await tracker.addComment(issue.key, "Scope changed: keep the greeting export stable.\n");
      run.env.E2E_ESTIMATE_POINTS = "5";
      const updated = await runEstimate(run, issue.key, { skipComments: false });
      expect(updated.exitCode).toBe(0);

      const updatedComments = await estimationComments(tracker, issue.key);
      expect(updatedComments).toHaveLength(1);
      expect(updatedComments[0]?.id).toBe(estimationCommentId);
      // The in-place PUT must rewrite the body, not just reuse the comment id.
      expect(updatedComments[0]?.body).toContain("Story Points: 5");
      expect(updatedComments[0]?.body).not.toContain("Story Points: 3");
      expect(tracker.getStoryPoints(issue.key)).toBe(5);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "estimate",
        "estimate",
      ]);
      expect(run.runRecords({ allTasks: true }).map((record) => record.origin)).toEqual([
        "estimate",
        "estimate",
      ]);

      // The re-estimation's own field and comment writes are not a user change:
      // a third no-change sweep must skip instead of estimating forever.
      const steadyState = await runEstimate(run, issue.key, { skipComments: false });
      expect(steadyState.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(2);
      const steadyStateComments = await estimationComments(tracker, issue.key);
      expect(steadyStateComments.map((comment) => comment.id)).toEqual([estimationCommentId!]);
      expect(tracker.getStoryPoints(issue.key)).toBe(5);
      expect(run.runRecords({ allTasks: true })).toHaveLength(2);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI skips Jira issues created less than 24 hours ago",
  async () => {
    const tracker = new FakeJiraTracker();
    const run = new FixtureWorkspace();
    try {
      tracker.setNow(Date.now());
      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
      });
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, issue.key, { skipComments: false });
      expect(result.exitCode).toBe(0);
      expect(run.agentInvocations()).toEqual([]);
      expect(await tracker.listComments(issue.key)).toEqual([]);
      expect(tracker.getStoryPoints(issue.key)).toBeUndefined();
      // A skipped task never starts a run, so the queue database may not exist.
      expect(
        existsSync(run.env.WEBHOOK_QUEUE_DB) ? run.runRecords({ allTasks: true }) : [],
      ).toEqual([]);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI writes story points without a comment when --skip-comments is set",
  async () => {
    const tracker = new FakeJiraTracker();
    const run = new FixtureWorkspace();
    try {
      const issue = await tracker.createTicket({
        title: "Expand the greeting",
        body: "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n",
      });
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, issue.key);
      expect(result.exitCode).toBe(0);
      expect(tracker.getStoryPoints(issue.key)).toBe(3);
      expect(await estimationComments(tracker, issue.key)).toEqual([]);
      expect(await tracker.listComments(issue.key)).toEqual([]);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);
      expect(readEstimationResult(run, issue.key)).toMatchObject({ storyPoints: 3 });

      // No comment can serve as the re-estimation baseline, so the durable
      // state recorded by the first sweep must make a second sweep a no-op.
      const repeat = await runEstimate(run, issue.key);
      expect(repeat.exitCode).toBe(0);
      expect(tracker.getStoryPoints(issue.key)).toBe(3);
      expect(run.agentInvocations()).toHaveLength(1);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);
      expect(tracker.unexpectedRequests).toEqual([]);
    } finally {
      await tracker.cleanup();
      run.dispose();
    }
  },
  90_000,
);
