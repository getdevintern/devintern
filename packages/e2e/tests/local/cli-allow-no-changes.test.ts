import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { prepareJiraWorkspace, seedJiraScenario, statusesFor } from "../../helpers/offline-jira";
import { checkedCommand } from "../../helpers/process";
import { FakeJiraTracker } from "../../providers/fake-jira";

/**
 * Seed a local bare Git remote so the run exercises the production git path
 * without a hosted code host.
 *
 * @param run - Fixture workspace whose isolated environment is reused
 */
async function prepareLocalRemote(run: FixtureWorkspace): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {});
}

/** Reason the delivery pipeline records when a run has nothing to commit. */
const NOT_COMMITTED = "Implementation was not committed";
/** Line `commitImplementation` prints when `--allow-no-changes` accepts the no-op. */
const NO_OP_ACCEPTED = "No changes were required; treating the run as a successful no-op";

/**
 * Assert nothing was delivered: the working tree is clean, the base branch has
 * no new commit locally or on the remote, and no feature branch was pushed.
 *
 * @param run - Fixture workspace after the CLI run
 * @param baseTip - Base branch commit captured before the run
 */
async function assertNothingDelivered(run: FixtureWorkspace, baseTip: string): Promise<void> {
  expect(await run.git("status", "--porcelain")).toBe("");
  expect(await run.git("rev-parse", "HEAD")).toBe(baseTip);
  expect(await run.git("rev-parse", run.base)).toBe(baseTip);
  expect(await run.remoteSha(run.base)).toBe(baseTip);
  expect(await run.git("ls-remote", "origin", "refs/heads/feature/*")).toBe("");
}

/**
 * Assert the output never claims a delivery step that did not happen. The
 * commit attempt itself ("Committing changes...") is printed before the
 * pipeline learns there is nothing to commit, so only success claims are
 * forbidden.
 *
 * @param stdout - CLI standard output
 */
function assertNoDeliveryClaims(stdout: string): void {
  expect(stdout).not.toContain("Successfully committed changes");
  expect(stdout).not.toContain("Delivering implementation commits");
  expect(stdout).not.toContain("Pushing branch to remote");
  expect(stdout).not.toContain("Creating pull request");
}

test.skipIf(!existsSync(cliPath))(
  "a no-op run without --allow-no-changes fails visibly and delivers nothing",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      const baseTip = await run.git("rev-parse", run.base);

      const result = await run.runTask({ agentMode: "no-change" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("No changes to commit");
      expect(result.stderr).toContain(NOT_COMMITTED);
      expect(result.stdout).not.toContain(NO_OP_ACCEPTED);

      // The pipeline created the feature branch locally before the agent ran,
      // but it has no commits and never reached the remote.
      expect(await run.git("branch", "--show-current")).toBe(run.head);
      await assertNothingDelivered(run, baseTip);
      assertNoDeliveryClaims(result.stdout);

      expect(run.runRecords()).toEqual([
        expect.objectContaining({ status: "failed", pr_url: null, outcome_reason: NOT_COMMITTED }),
      ]);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["no-change"]);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "--allow-no-changes --create-pr turns a no-op run into a clean success without a PR",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      const baseTip = await run.git("rev-parse", run.base);

      // `runTask` always passes `--create-pr`, so the flag is layered on a PR run.
      const result = await run.runTask({
        agentMode: "no-change",
        extraArgs: ["--allow-no-changes"],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(NO_OP_ACCEPTED);
      expect(result.stderr).not.toContain(NOT_COMMITTED);

      // HEAD sits on the empty local feature branch, which equals the base tip.
      expect(await run.git("branch", "--show-current")).toBe(run.head);
      await assertNothingDelivered(run, baseTip);
      assertNoDeliveryClaims(result.stdout);

      expect(run.runRecords()).toEqual([
        expect.objectContaining({ status: "succeeded", pr_url: null, outcome_reason: null }),
      ]);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["no-change"]);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

// With `--no-git` the commit step is skipped before `commitImplementation`
// ever reads `allowNoChanges`, so a no-op succeeds with or without the flag.
// Run both forms so the flag is never mistaken for what makes this pass.
for (const extraArgs of [["--no-git"], ["--allow-no-changes", "--no-git"]]) {
  test.skipIf(!existsSync(cliPath))(
    `${extraArgs.join(" ")}: a no-op exits 0 on the base branch with nothing delivered`,
    async () => {
      const run = new FixtureWorkspace();
      try {
        await prepareLocalRemote(run);
        const baseTip = await run.git("rev-parse", run.base);

        const result = await run.runTask({ agentMode: "no-change", extraArgs });

        expect(result.exitCode).toBe(0);
        // The no-op branch of delivery is never reached: no commit attempt,
        // no acceptance line, and no feature branch.
        expect(result.stdout).not.toContain("Committing changes");
        expect(result.stdout).not.toContain(NO_OP_ACCEPTED);
        expect(await run.git("branch", "--show-current")).toBe(run.base);
        expect(await run.git("branch", "--list", run.head)).toBe("");
        await assertNothingDelivered(run, baseTip);
        assertNoDeliveryClaims(result.stdout);

        expect(run.runRecords()).toEqual([
          expect.objectContaining({ status: "succeeded", pr_url: null, outcome_reason: null }),
        ]);
      } finally {
        run.dispose();
      }
    },
    60_000,
  );
}

test.skipIf(!existsSync(cliPath))(
  "offline Jira: a no-op run is reported as a failure without the flag and left in progress with it",
  async () => {
    // Two independent scenarios, each with its own fake server and temp root,
    // so the failure path cannot leak tracker state into the no-op path.
    const failedTracker = new FakeJiraTracker();
    const failedRun = new FixtureWorkspace();
    const noOpTracker = new FakeJiraTracker();
    const noOpRun = new FixtureWorkspace();
    try {
      // Without the flag: the CLI posts a failure comment and moves the ticket
      // back to the todo status so it can be retried.
      const failedSeed = await seedJiraScenario(failedTracker);
      const failedStatuses = statusesFor(failedTracker);
      await prepareJiraWorkspace(failedRun, failedTracker, failedSeed, failedStatuses);
      const failedBase = await failedRun.git("rev-parse", failedRun.base);

      const failed = await failedRun.runTask({
        taskRef: failedSeed.issue.key,
        skipComments: false,
        agentMode: "no-change",
      });

      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr).toContain(NOT_COMMITTED);
      await assertNothingDelivered(failedRun, failedBase);
      expect(failedRun.runRecords({ allTasks: true })).toEqual([
        expect.objectContaining({
          task_key: failedSeed.issue.key,
          tracker: "jira",
          status: "failed",
          pr_url: null,
          outcome_reason: NOT_COMMITTED,
        }),
      ]);
      expect(await failedTracker.getStatus(failedSeed.issue.key)).toBe(failedStatuses.todoStatus);
      const failedComments = await failedTracker.listComments(failedSeed.issue.key);
      expect(failedComments).toHaveLength(2);
      expect(failedComments[0]?.body).toContain(failedSeed.commentMarker);
      expect(failedComments[1]?.body).toContain("no pull request was created");
      expect(failedComments[1]?.body).toContain(`Reason: ${NOT_COMMITTED}`);
      expect(await failedTracker.listComments(failedSeed.decoy.key)).toEqual([]);
      expect(failedTracker.unexpectedRequests).toEqual([]);

      // With the flag: the run succeeds, posts no comment, and keeps the
      // in-progress status it set before the agent ran. The no-op halt
      // (`haltKind: "noop"` in packages/code/src/lib/agent/run-harness-finalize.ts)
      // stops delivery before publish, so neither the implementation comment
      // nor the post-PR transition happens.
      //
      // CURRENT BEHAVIOUR, NOT A CONTRACT: leaving the ticket In Progress with
      // no comment is what the code does today, not a confirmed product
      // decision. If no-op runs start transitioning the ticket or posting a
      // "no changes needed" comment, update the status/comment assertions
      // below rather than treating the change as a regression.
      const noOpSeed = await seedJiraScenario(noOpTracker);
      const noOpStatuses = statusesFor(noOpTracker);
      // The default fake keeps in-progress and PR statuses distinct, which is
      // what proves the no-op never claims a PR transition.
      expect(noOpStatuses.prStatus).not.toBe(noOpStatuses.inProgressStatus);
      await prepareJiraWorkspace(noOpRun, noOpTracker, noOpSeed, noOpStatuses);
      const noOpBase = await noOpRun.git("rev-parse", noOpRun.base);

      const noOp = await noOpRun.runTask({
        taskRef: noOpSeed.issue.key,
        skipComments: false,
        agentMode: "no-change",
        extraArgs: ["--allow-no-changes"],
      });

      expect(noOp.exitCode).toBe(0);
      expect(noOp.stdout).toContain(NO_OP_ACCEPTED);
      await assertNothingDelivered(noOpRun, noOpBase);
      assertNoDeliveryClaims(noOp.stdout);
      expect(noOpRun.runRecords({ allTasks: true })).toEqual([
        expect.objectContaining({
          task_key: noOpSeed.issue.key,
          tracker: "jira",
          status: "succeeded",
          pr_url: null,
          outcome_reason: null,
        }),
      ]);
      expect(await noOpTracker.getStatus(noOpSeed.issue.key)).toBe(noOpStatuses.inProgressStatus);
      const noOpComments = await noOpTracker.listComments(noOpSeed.issue.key);
      expect(noOpComments).toHaveLength(1);
      expect(noOpComments[0]?.body).toContain(noOpSeed.commentMarker);
      expect(await noOpTracker.getStatus(noOpSeed.decoy.key)).toBe(noOpStatuses.todoStatus);
      expect(await noOpTracker.listComments(noOpSeed.decoy.key)).toEqual([]);
      expect(noOpTracker.unexpectedRequests).toEqual([]);
    } finally {
      // Release both fakes even if one cleanup rejects.
      await Promise.allSettled([failedTracker.cleanup(), noOpTracker.cleanup()]);
      failedRun.dispose();
      noOpRun.dispose();
    }
  },
  120_000,
);
