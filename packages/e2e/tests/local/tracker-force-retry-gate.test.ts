import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import {
  createOfflineJira,
  prepareJiraWorkspace,
  seedJiraScenario,
  statusesFor,
} from "../../helpers/offline-jira";
import {
  assertImplementationComment,
  IMPLEMENTATION_COMMENT_MARKER,
} from "../../helpers/tracker-lifecycle";

/** Header the Jira formatter renders for an incomplete implementation comment. */
const INCOMPLETE_COMMENT_MARKER = "Implementation Incomplete";

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

      // Forced retries resume the prior attempt's branch rather than cutting a
      // fresh one: this scenario seeds no collision, so the checkout must still
      // be the exact branch the incomplete attempt recorded.
      const branch = run.recordedBranch(key);
      expect(branch).toBeDefined();
      expect(branch).toBe(incompleteBranch);
      expect(forced.stdout).toContain("Session pickup: resuming");
      expect(forced.stdout).toContain(`Resuming prior attempt's branch '${incompleteBranch}'`);
      expect(await run.git("branch", "--show-current")).toBe(incompleteBranch!);
      expect(await run.remoteSha(incompleteBranch!)).toBe(await run.git("rev-parse", "HEAD"));
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
