import { describe, expect, test } from "bun:test";
import { GitLabWorkerFixture } from "../../helpers/gitlab-worker";
import type { GitLabWorkerOptions } from "../../helpers/gitlab-worker";
import { resolveGitLabConfig } from "../../helpers/gitlab-config";
import { GitLab } from "../../providers/gitlab";

async function scenario(
  options: GitLabWorkerOptions,
  check: (worker: GitLabWorkerFixture) => Promise<void>,
): Promise<void> {
  const config = resolveGitLabConfig();
  const worker = new GitLabWorkerFixture(
    new GitLab(config.baseUrl, config.token),
    config.token,
    options,
  );
  const errors: unknown[] = [];
  try {
    await worker.setup();
    await check(worker);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await worker.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      `GitLab worker scenario failed: ${worker.id}; project ${worker.project?.id ?? "not created"}\n${worker.tail()}`,
    );
  }
}

describe.skipIf(process.env.DEVINTERN_E2E_GITLAB !== "1")("GitLab worker built CLI E2E", () => {
  test("drains an injected task, opens a labelled merge request and cleans up its worktree", async () => {
    await scenario({ prLabels: ["devintern-e2e"] }, async (worker) => {
      const marker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
      worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
      const task = await worker.addTask({
        title: "Expand the greeting",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });

      worker.start();
      await worker.waitForReady();
      const { task: settled, runs } = await worker.waitForSettled(task.id);
      const diagnostics = () => `${worker.tail()}\nrun records: ${JSON.stringify(runs)}`;

      expect(settled.status, diagnostics()).toBe("done");
      expect(runs, diagnostics()).toHaveLength(1);
      expect(runs[0]?.status, diagnostics()).toBe("succeeded");
      expect(runs[0]?.branch, diagnostics()).toBe(`feature/${task.task_key}`);
      expect(runs[0]?.pr_url, diagnostics()).toContain("/merge_requests/");
      expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);

      const branch = `feature/${task.task_key}`;
      const mr = await worker.waitForMergeRequest(branch);
      expect(mr.state).toBe("opened");
      expect(mr.source_branch).toBe(branch);
      expect(mr.target_branch).toBe(worker.baseBranch);
      expect(mr.title).toBe(`[${task.task_key}] Expand the greeting`);
      expect(mr.description).toContain("Hello, world!");
      expect(mr.labels).toContain("devintern-e2e");
      expect(await worker.remoteSha(branch)).toBe(mr.sha);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";\n',
      );

      const diffs = await worker.gitlab.request<Array<{ new_path: string; diff: string }>>(
        `/projects/${worker.projectId()}/merge_requests/${mr.iid}/diffs`,
      );
      expect(diffs.map((file) => file.new_path)).toEqual(["src/greeting.ts"]);
      expect(diffs[0]?.diff).toContain('+export const greeting = "Hello, world!";');
      const commits = await worker.gitlab.request<unknown[]>(
        `/projects/${worker.projectId()}/merge_requests/${mr.iid}/commits`,
      );
      expect(commits).toHaveLength(1);

      await worker.waitFor("the successful run's worktree to be removed", () =>
        worker.taskWorktrees().length === 0 ? true : undefined,
      );
      expect(worker.running, diagnostics()).toBe(true);
    });
  }, 180_000);

  test("polls GitLab Issues through the worker query and opens a merge request once", async () => {
    await scenario(
      { tracker: "gitlab", taskQuery: "label:intern", skipComments: false },
      async (worker) => {
        const marker = `E2E_DESCRIPTION_MARKER_${crypto.randomUUID()}`;
        const projectPath = worker.project!.path_with_namespace;
        const statuses = {
          todoStatus: "To Do",
          inProgressStatus: "In Progress",
          prStatus: "In Review",
        };
        await worker.writeBaseFile(
          ".devintern-code/settings.json",
          JSON.stringify({ gitlab: { projects: { [projectPath]: statuses } } }, null, 2) + "\n",
        );
        for (const label of ["intern", ...Object.values(statuses)]) {
          await worker.ensureLabel(label);
        }
        const issue = await worker.createIssue({
          title: "Expand the greeting",
          description: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
          labels: ["intern"],
        });
        worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
        worker.env.GITLAB_TOKEN = worker.token;
        worker.env.GITLAB_PROJECT = projectPath;
        worker.env.GITLAB_BASE_URL = worker.gitlab.baseUrl;
        worker.env.GITLAB_STATUS_LABELS = Object.values(statuses).join(",");

        worker.start();
        await worker.waitForReady();
        const branch = `feature/${issue.iid}`;
        const mr = await worker.waitForMergeRequest(branch);
        const runs = await worker.waitFor(
          "the GitLab tracker run to be recorded",
          () => {
            const records = worker.runRecords(String(issue.iid));
            return records.length > 0 ? records : undefined;
          },
          90_000,
        );

        expect(runs).toHaveLength(1);
        expect(runs[0]?.status).toBe("succeeded");
        expect(runs[0]?.pr_url).toBe(mr.web_url);
        expect(mr.title).toBe(`[${issue.iid}] Expand the greeting`);
        expect(mr.source_branch).toBe(branch);
        expect(mr.target_branch).toBe(worker.baseBranch);
        expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
          'export const greeting = "Hello, world!";\n',
        );
        expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);
        const issueAfter = await worker.waitForIssueLabels(
          issue.iid,
          (labels) =>
            labels.includes(statuses.prStatus) &&
            !labels.includes(statuses.todoStatus) &&
            !labels.includes(statuses.inProgressStatus),
        );
        expect(issueAfter.labels).toContain("intern");

        // The actioned marker must keep the still-matching issue out of later
        // polling cycles; a second run would re-open the same work.
        await Bun.sleep(2_500);
        expect(worker.runRecords(String(issue.iid))).toHaveLength(1);
        expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);
        expect(worker.running).toBe(true);
      },
    );
  }, 180_000);

  test("repairs a failed GitLab commit status and deduplicates the CI fix", async () => {
    await scenario({ ciFailureFix: true }, async (worker) => {
      const task = await worker.addTask({
        title: "Expand the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();
      const { task: settled } = await worker.waitForSettled(task.id);
      expect(settled.status, worker.tail()).toBe("done");

      const branch = `feature/${task.task_key}`;
      const mr = await worker.waitForMergeRequest(branch);
      const marker = `E2E_CI_FIX_MARKER_${crypto.randomUUID()}`;
      await worker.createFailedCommitStatus(mr.sha, marker);

      await worker.waitFor(
        "the worker to run the CI repair agent",
        () =>
          worker.agentInvocations().some((invocation) => invocation.mode === "ci")
            ? true
            : undefined,
        90_000,
      );
      const updatedSha = await worker.waitForBranchHead(branch, mr.sha, 60_000);
      expect(updatedSha).not.toBe(mr.sha);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, CI!";\n',
      );
      await worker.waitForOutput(/CI fix pushed/, 30_000);

      const ciFixCount = worker
        .agentInvocations()
        .filter((invocation) => invocation.mode === "ci").length;
      expect(ciFixCount).toBeGreaterThanOrEqual(1);
      await Bun.sleep(2_500);
      expect(
        worker.agentInvocations().filter((invocation) => invocation.mode === "ci").length,
        worker.tail(),
      ).toBe(ciFixCount);
      expect(
        await worker.gitlab.request<unknown[]>(
          `/projects/${worker.projectId()}/merge_requests/${mr.iid}/commits`,
        ),
      ).toHaveLength(2);
      expect(worker.running).toBe(true);
    });
  }, 180_000);

  test("escalates to the MR after the GitLab CI repair budget is exhausted", async () => {
    await scenario({ ciFailureFix: true }, async (worker) => {
      worker.env.CI_FIX_MAX_ATTEMPTS = "1";
      worker.env.E2E_FAIL_CI = "1";
      const task = await worker.addTask({
        title: "Expand the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();
      const { task: settled } = await worker.waitForSettled(task.id);
      expect(settled.status, worker.tail()).toBe("done");

      const branch = `feature/${task.task_key}`;
      const mr = await worker.waitForMergeRequest(branch);
      const marker = `E2E_CI_FIX_MARKER_${crypto.randomUUID()}`;
      await worker.createFailedCommitStatus(mr.sha, marker);
      await worker.waitFor(
        "the failed CI repair attempt",
        () =>
          worker.agentInvocations().some((invocation) => invocation.mode === "ci")
            ? true
            : undefined,
        90_000,
      );
      const note = await worker.waitForMergeRequestNote(mr.iid, "could not fix");
      expect(note.body).toContain(marker);

      await Bun.sleep(2_500);
      expect(
        worker.agentInvocations().filter((invocation) => invocation.mode === "ci").length,
        worker.tail(),
      ).toBe(1);
      expect(await worker.remoteSha(branch)).toBe(mr.sha);
      expect(worker.running).toBe(true);
    });
  }, 180_000);

  test("merges an advanced GitLab base into its MR when conflict resolution is automatic", async () => {
    await scenario({ conflictResolution: "auto" }, async (worker) => {
      const task = await worker.addTask({
        title: "Expand the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();
      const { task: settled } = await worker.waitForSettled(task.id);
      expect(settled.status, worker.tail()).toBe("done");

      const branch = `feature/${task.task_key}`;
      const mr = await worker.waitForMergeRequest(branch);
      const advancedBase = await worker.advanceBase('export const greeting = "Hello, base!";\n');

      await worker.waitFor(
        "the worker to resolve the GitLab merge conflict",
        () =>
          worker.agentInvocations().some((invocation) => invocation.mode === "conflict")
            ? true
            : undefined,
        90_000,
      );
      const updatedSha = await worker.waitForBranchHead(branch, mr.sha);
      expect(updatedSha).not.toBe(mr.sha);
      expect(await worker.remoteSha(worker.baseBranch)).toBe(advancedBase);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, merged!";\n',
      );
      const commits = await worker.gitlab.request<Array<{ parent_ids: string[] }>>(
        `/projects/${worker.projectId()}/merge_requests/${mr.iid}/commits`,
      );
      expect(commits.length).toBeGreaterThanOrEqual(2);
      expect(commits.some((commit) => commit.parent_ids.length === 2)).toBe(true);

      const conflictCount = worker
        .agentInvocations()
        .filter((invocation) => invocation.mode === "conflict").length;
      expect(conflictCount).toBeGreaterThanOrEqual(1);
      await Bun.sleep(2_500);
      expect(
        worker.agentInvocations().filter((invocation) => invocation.mode === "conflict").length,
        worker.tail(),
      ).toBe(conflictCount);
      expect(worker.running).toBe(true);
    });
  }, 180_000);

  test("polls its own merge request, addresses new review feedback and deduplicates the poll", async () => {
    await scenario({}, async (worker) => {
      const task = await worker.addTask({
        title: "Expand the greeting",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      worker.start();
      await worker.waitForReady();
      const { task: settled, runs } = await worker.waitForSettled(task.id);
      expect(settled.status, worker.tail()).toBe("done");
      expect(runs[0]?.status).toBe("succeeded");

      const branch = `feature/${task.task_key}`;
      const mr = await worker.waitForMergeRequest(branch);
      const discussion = await worker.postDiscussion(
        mr.iid,
        'Change the greeting to "Hello, reviewer!" and run the tests. E2E_REVIEW_GREETING',
      );
      expect(discussion.notes[0]?.author.id).not.toBe(worker.botUserId);

      await worker.waitFor(
        "the worker to run the review agent",
        () =>
          worker.agentInvocations().some((invocation) => invocation.mode === "review")
            ? true
            : undefined,
        90_000,
      );
      const updatedSha = await worker.waitForBranchHead(branch, mr.sha);
      expect(updatedSha).not.toBe(mr.sha);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, reviewer!";\n',
      );

      const after = await worker.getDiscussion(mr.iid, discussion.id);
      expect(
        after.notes.some(
          (note) =>
            note.author.id === worker.botUserId && note.body.includes("Addressed this feedback"),
        ),
      ).toBe(true);
      const modesAfterSuccess = worker.agentInvocations().map((invocation) => invocation.mode);
      expect(modesAfterSuccess[0], worker.tail()).toBe("implement");
      expect(modesAfterSuccess.filter((mode) => mode === "review").length).toBeGreaterThanOrEqual(
        1,
      );
      // The poller must mark the discussion processed: after the successful
      // review settles, later ticks may not spawn another agent or commit.
      const reviewCount = modesAfterSuccess.filter((mode) => mode === "review").length;
      await Bun.sleep(2_500);
      expect(
        worker
          .agentInvocations()
          .map((invocation) => invocation.mode)
          .filter((mode) => mode === "review").length,
        worker.tail(),
      ).toBe(reviewCount);
      expect(
        await worker.gitlab.request<unknown[]>(
          `/projects/${worker.projectId()}/merge_requests/${mr.iid}/commits`,
        ),
      ).toHaveLength(2);
      expect(await worker.gitlab.mergeRequests(worker.projectId(), branch)).toHaveLength(1);
      expect(worker.running).toBe(true);
    });
  }, 180_000);
});
