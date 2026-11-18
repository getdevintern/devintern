import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedCommand } from "../../helpers/process";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { FakeLinearTracker } from "../../providers/fake-linear";
import type { FakeLinearOptions } from "../../providers/fake-linear";

const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";
const ISSUE_BODY =
  "# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n";

/**
 * Initialize the isolated local bare remote and prepare the CLI workspace.
 *
 * Linear estimation writes the native `estimate` field, so unlike Jira no
 * story-points field settings are required.
 */
async function prepareEstimationWorkspace(
  run: FixtureWorkspace,
  tracker: FakeLinearTracker,
): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", tracker.environment());
}

/** Run `devintern <key|--query> --estimate` through the isolated fixture. */
function runEstimate(
  run: FixtureWorkspace,
  selector: { taskRef: string } | { query: string },
  options: { skipComments?: boolean } = {},
) {
  return run.runTask({
    ...selector,
    skipComments: options.skipComments,
    extraArgs: ["--estimate"],
  });
}

/** Estimation comments read back through the fake, not the CLI's stdout. */
async function estimationComments(
  tracker: FakeLinearTracker,
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

/** Estimation is read-only: no branch, commit, or push reaches the remote. */
async function assertNoGitDelivery(run: FixtureWorkspace, key: string): Promise<void> {
  expect(await run.git("status", "--porcelain")).toBe("");
  expect(await run.git("branch", "--show-current")).toBe(run.base);
  const remoteBase = await run.remoteSha(run.base);
  expect(remoteBase).toBeDefined();
  expect(await run.git("rev-parse", "HEAD")).toBe(remoteBase!);
  expect(await run.remoteSha(`feature/${key.toLowerCase()}`)).toBeUndefined();
}

/** Run one scenario with an owned fake server and workspace, always cleaned up. */
async function withScenario(
  options: FakeLinearOptions,
  body: (tracker: FakeLinearTracker, run: FixtureWorkspace) => Promise<void>,
): Promise<void> {
  const tracker = new FakeLinearTracker(options);
  const run = new FixtureWorkspace();
  try {
    await body(tracker, run);
  } finally {
    await tracker.cleanup();
    run.dispose();
  }
}

test.skipIf(!existsSync(cliPath))(
  "built CLI writes the Linear estimate field and comment through the offline fake server",
  () =>
    withScenario({}, async (tracker, run) => {
      const decoy = await tracker.createTicket({ title: "Unrelated decoy", body: "# Decoy\n" });
      const issue = await tracker.createTicket({ title: "Expand the greeting", body: ISSUE_BODY });
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, { taskRef: issue.key }, { skipComments: false });
      expect(result.exitCode).toBe(0);

      const records = run.runRecords({ allTasks: true });
      expect(records).toHaveLength(1);
      expect(records[0]?.origin).toBe("estimate");
      expect(records[0]?.status).toBe("succeeded");
      expect(records[0]?.tracker).toBe("linear");
      expect(records[0]?.task_key).toBe(issue.key);
      expect(records[0]?.pr_url).toBeNull();

      expect(tracker.getEstimate(issue.key)).toBe(3);
      const comments = await estimationComments(tracker, issue.key);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("**Story Points:** 3");
      expect(readEstimationResult(run, issue.key)).toMatchObject({
        storyPoints: 3,
        confidence: "high",
        implementationConfidence: 8,
      });
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);

      // The decoy outside the selector is untouched.
      expect(tracker.getEstimate(decoy.key)).toBeUndefined();
      expect(await tracker.listComments(decoy.key)).toEqual([]);

      await assertNoGitDelivery(run, issue.key);
      expect(tracker.operations).not.toContain("CommentUpdate");
      expect(tracker.unexpectedOperations).toEqual([]);
    }),
  120_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI skips unchanged Linear issues and re-estimates through commentUpdate",
  () =>
    withScenario({}, async (tracker, run) => {
      const issue = await tracker.createTicket({ title: "Expand the greeting", body: ISSUE_BODY });
      await prepareEstimationWorkspace(run, tracker);

      const first = await runEstimate(run, { taskRef: issue.key }, { skipComments: false });
      expect(first.exitCode).toBe(0);
      const firstComments = await estimationComments(tracker, issue.key);
      expect(firstComments).toHaveLength(1);
      const estimationCommentId = firstComments[0]!.id;
      expect(tracker.getEstimate(issue.key)).toBe(3);

      // No issue change since the recorded baseline: skipped without an attempt.
      const unchanged = await runEstimate(run, { taskRef: issue.key }, { skipComments: false });
      expect(unchanged.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(1);
      expect(tracker.operations).not.toContain("CommentUpdate");
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);

      // A human edit bumps `updatedAt`; the next run rewrites the same comment.
      await tracker.editTicket(issue.key, {
        body: `${ISSUE_BODY}\nScope changed: keep the greeting export stable.\n`,
      });
      run.env.E2E_ESTIMATE_POINTS = "5";
      const updated = await runEstimate(run, { taskRef: issue.key }, { skipComments: false });
      expect(updated.exitCode).toBe(0);

      const updatedComments = await estimationComments(tracker, issue.key);
      expect(updatedComments.map((comment) => comment.id)).toEqual([estimationCommentId]);
      expect(updatedComments[0]?.body).toContain("**Story Points:** 5");
      expect(updatedComments[0]?.body).not.toContain("**Story Points:** 3");
      expect(tracker.getEstimate(issue.key)).toBe(5);
      expect(tracker.operations.filter((name) => name === "CommentUpdate")).toHaveLength(1);
      expect(tracker.operations.filter((name) => name === "CommentCreate")).toHaveLength(1);
      expect(run.runRecords({ allTasks: true }).map((record) => record.origin)).toEqual([
        "estimate",
        "estimate",
      ]);

      // The re-estimation's own field and comment writes are not a user change.
      const steadyState = await runEstimate(run, { taskRef: issue.key }, { skipComments: false });
      expect(steadyState.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(2);
      expect((await estimationComments(tracker, issue.key)).map((c) => c.id)).toEqual([
        estimationCommentId,
      ]);
      expect(tracker.getEstimate(issue.key)).toBe(5);

      await assertNoGitDelivery(run, issue.key);
      expect(tracker.unexpectedOperations).toEqual([]);
    }),
  150_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI skips Linear issues created less than 24 hours ago",
  // The wall clock stamps `createdAt` with the real current time.
  () =>
    withScenario({ clock: "wall" }, async (tracker, run) => {
      const issue = await tracker.createTicket({ title: "Expand the greeting", body: ISSUE_BODY });
      await prepareEstimationWorkspace(run, tracker);

      const result = await runEstimate(run, { taskRef: issue.key }, { skipComments: false });
      expect(result.exitCode).toBe(0);
      expect(run.agentInvocations()).toEqual([]);
      expect(await tracker.listComments(issue.key)).toEqual([]);
      expect(tracker.getEstimate(issue.key)).toBeUndefined();
      expect(tracker.operations).not.toContain("IssueUpdate");
      // A skipped task never starts a run, so the queue database may not exist.
      expect(
        existsSync(run.env.WEBHOOK_QUEUE_DB) ? run.runRecords({ allTasks: true }) : [],
      ).toEqual([]);
      expect(tracker.unexpectedOperations).toEqual([]);
    }),
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "built CLI writes the Linear estimate without a comment for a --query selection with --skip-comments",
  () =>
    withScenario({}, async (tracker, run) => {
      const marker = `E2EESTIMATE${crypto.randomUUID().replace(/-/g, "")}`;
      const decoy = await tracker.createTicket({ title: "Expand the greeting", body: ISSUE_BODY });
      const issue = await tracker.createTicket({
        title: `Expand the greeting ${marker}`,
        body: ISSUE_BODY,
      });
      await prepareEstimationWorkspace(run, tracker);

      const query = `{"title":{"containsIgnoreCase":"${marker}"}}`;
      const result = await runEstimate(run, { query });
      expect(result.exitCode).toBe(0);
      expect(tracker.getEstimate(issue.key)).toBe(3);
      expect(await tracker.listComments(issue.key)).toEqual([]);
      expect(tracker.operations).not.toContain("CommentCreate");
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["estimate"]);
      expect(readEstimationResult(run, issue.key)).toMatchObject({ storyPoints: 3 });
      expect(tracker.getEstimate(decoy.key)).toBeUndefined();

      // No comment can serve as the baseline; durable state makes a repeat a no-op.
      const repeat = await runEstimate(run, { query });
      expect(repeat.exitCode).toBe(0);
      expect(run.agentInvocations()).toHaveLength(1);
      expect(run.runRecords({ allTasks: true })).toHaveLength(1);
      expect(tracker.getEstimate(issue.key)).toBe(3);
      expect(await tracker.listComments(issue.key)).toEqual([]);

      await assertNoGitDelivery(run, issue.key);
      expect(tracker.unexpectedOperations).toEqual([]);
    }),
  120_000,
);
