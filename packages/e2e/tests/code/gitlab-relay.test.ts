import { describe, expect, test } from "bun:test";
import { GitLabWorkerFixture } from "../../helpers/gitlab-worker";
import type { GitLabWorkerOptions } from "../../helpers/gitlab-worker";
import { resolveGitLabConfig } from "../../helpers/gitlab-config";
import { resolveRelayE2EConfig } from "../../helpers/relay-config";
import { GitLab } from "../../providers/gitlab";

async function scenario(
  options: GitLabWorkerOptions,
  check: (worker: GitLabWorkerFixture) => Promise<void>,
): Promise<void> {
  const gitlabConfig = resolveGitLabConfig();
  const relayConfig = resolveRelayE2EConfig();
  const worker = new GitLabWorkerFixture(
    new GitLab(gitlabConfig.baseUrl, gitlabConfig.token),
    gitlabConfig.token,
    { pollIntervalSeconds: 3_600, ...options, relayUrl: relayConfig.relayUrl },
  );
  const errors: unknown[] = [];
  try {
    await worker.setup();
    worker.installRelaySession(relayConfig.sessionPath);
    await worker.connectRelay();
    worker.env.WORKER_RELAY_URL = relayConfig.relayUrl;
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
      `GitLab relay scenario failed: ${worker.id}; project ${worker.project?.id ?? "not created"}\n${worker.tail()}`,
    );
  }
}

describe.skipIf(process.env.DEVINTERN_E2E_GITLAB_RELAY !== "1")(
  "GitLab hosted relay worker E2E",
  () => {
    test("delivers review feedback through the relay while polling is disabled", async () => {
      await scenario({}, async (worker) => {
        const task = await worker.addTask({
          title: "Expand the greeting",
          body: "Change the greeting to Hello, world! and run bun test.",
        });
        worker.start();
        await worker.waitForReady();
        await worker.waitForOutput(/Relay connected:/, 30_000);
        const { task: settled } = await worker.waitForSettled(task.id);
        expect(settled.status, worker.tail()).toBe("done");

        const branch = `feature/${task.task_key}`;
        const mr = await worker.waitForMergeRequest(branch);
        const discussion = await worker.postDiscussion(
          mr.iid,
          'Change the greeting to "Hello, reviewer!" and run the tests. E2E_REVIEW_GREETING',
        );

        await worker.waitFor(
          "relay-delivered review feedback to run the agent",
          () =>
            worker.agentInvocations().some((invocation) => invocation.mode === "review")
              ? true
              : undefined,
          90_000,
        );
        await worker.waitForBranchHead(branch, mr.sha);
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
        expect(worker.running).toBe(true);
      });
    }, 180_000);

    test("unwatches a merge request closed through the relay", async () => {
      await scenario({}, async (worker) => {
        const task = await worker.addTask({
          title: "Expand the greeting",
          body: "Change the greeting to Hello, world! and run bun test.",
        });
        worker.start();
        await worker.waitForReady();
        await worker.waitForOutput(/Relay connected:/, 30_000);
        const { task: settled } = await worker.waitForSettled(task.id);
        expect(settled.status, worker.tail()).toBe("done");

        const mr = await worker.waitForMergeRequest(`feature/${task.task_key}`);
        expect(worker.openAgentChangeRequests()).toHaveLength(1);
        await worker.gitlab.request(
          `/projects/${worker.projectId()}/merge_requests/${mr.iid}`,
          "PUT",
          {
            state_event: "close",
          },
        );
        await worker.waitFor(
          "the relayed MR close to remove the watch",
          () => (worker.openAgentChangeRequests().length === 0 ? true : undefined),
          60_000,
        );
      });
    }, 180_000);

    test("disconnect removes the managed hook and stops relay delivery", async () => {
      await scenario({}, async (worker) => {
        const task = await worker.addTask({
          title: "Expand the greeting",
          body: "Change the greeting to Hello, world! and run bun test.",
        });
        worker.start();
        await worker.waitForReady();
        await worker.waitForOutput(/Relay connected:/, 30_000);
        const { task: settled } = await worker.waitForSettled(task.id);
        expect(settled.status, worker.tail()).toBe("done");

        const mr = await worker.waitForMergeRequest(`feature/${task.task_key}`);
        await worker.disconnectRelay();
        expect(await worker.projectHooks()).toHaveLength(0);

        await worker.postDiscussion(
          mr.iid,
          'Change the greeting to "Hello, reviewer!" and run the tests. E2E_REVIEW_GREETING',
        );
        await Bun.sleep(8_000);
        expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);
        expect(worker.running).toBe(true);
      });
    }, 180_000);
  },
);
