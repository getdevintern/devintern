/**
 * Live GitHub.com worker CI-repair coverage (opt-in: `test:e2e:github`).
 *
 * Single-token identity: the worker opens the PR, posts its escalation
 * comment, and the test posts the synthetic failing commit statuses, all with
 * the same `E2E_GITHUB_TOKEN`. CI statuses are not authored-by-human signals,
 * so no second account is needed. Review-feedback polling is intentionally not
 * covered here because the worker ignores its own identity's review comments.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GitHubWorkerFixture, redact } from "../../helpers/github-worker";
import type { GitHubWorkerOptions } from "../../helpers/github-worker";
import { GitHub } from "../../providers/github";

const CI_SOURCE = "github:ci";
const enabled = process.env.DEVINTERN_E2E_GITHUB === "1";

async function scenario(
  options: GitHubWorkerOptions,
  check: (worker: GitHubWorkerFixture) => Promise<void>,
): Promise<void> {
  const repository = process.env.E2E_GITHUB_REPOSITORY;
  const token = process.env.E2E_GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error(
      "Missing explicit E2E GitHub configuration: run through `bun run --filter @devintern/e2e test:e2e:github`, " +
        "which resolves E2E_GITHUB_REPOSITORY and E2E_GITHUB_TOKEN (or `gh auth token`).",
    );
  }
  const worker = new GitHubWorkerFixture(new GitHub(repository, token), token, options);
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
    const statuses = worker.postedStatuses
      .map((status) => `${status.sha.slice(0, 7)}:${status.context}`)
      .join(", ");
    throw new AggregateError(
      errors.map((error) =>
        error instanceof Error ? new Error(redact(error.message, token), { cause: error }) : error,
      ),
      redact(
        `GitHub worker scenario failed: ${worker.id}; branches ${[...worker.ownedBranches].join(", ")}; ` +
          `PRs ${[...worker.ownedPulls].join(", ") || "none"}; undeletable statuses ${statuses || "none"}\n${worker.tail()}`,
        token,
      ),
    );
  }
}

/** Drain one injected task and return its PR on the unique run branch. */
async function openAgentPr(worker: GitHubWorkerFixture) {
  const task = await worker.addRunTask({
    title: "Expand the greeting",
    body: "Change the greeting to Hello, world! and run bun test.",
  });
  worker.start();
  await worker.waitForReady();
  const { task: settled, runs } = await worker.waitForSettled(task.id, 120_000);
  for (const run of runs) if (run.branch) worker.ownBranch(run.branch);
  expect(settled.status, worker.tail()).toBe("done");
  const branch = runs.find((run) => run.branch)?.branch ?? `feature/${task.task_key}`;
  const pull = await worker.waitForPull(branch);
  expect(pull.state).toBe("open");
  expect(pull.base.ref).toBe(worker.base);
  expect(worker.agentInvocations()).toEqual([{ mode: "implement" }]);
  return { branch, pull };
}

describe.skipIf(!enabled)("GitHub worker CI repair built CLI E2E", () => {
  test("repairs a failed GitHub commit status and deduplicates the CI fix", async () => {
    await scenario({ ciFailureFix: true }, async (worker) => {
      const { branch, pull } = await openAgentPr(worker);
      const context = `E2E_CI_FIX_MARKER_${crypto.randomUUID()}`;
      await worker.postFailedStatus(pull.head.sha, context);

      await worker.waitFor(
        "the worker to run the GitHub CI repair agent",
        () => (worker.ciInvocations() > 0 ? true : undefined),
        120_000,
        250,
      );
      const updatedSha = await worker.waitForBranchHead(branch, pull.head.sha, 90_000);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, CI!";\n',
      );
      await worker.waitForOutput(/CI fix pushed/, 60_000, "the CI fix push log");
      const externalId = `check:${worker.github.repository}#${pull.number}:${pull.head.sha}:status:${context}`;
      expect(worker.isProcessed(CI_SOURCE, externalId), worker.tail()).toBe(true);

      // Later poll ticks (1s cadence) must not repair the same status/sha again.
      expect(worker.ciInvocations()).toBe(1);
      await Bun.sleep(5_000);
      expect(worker.ciInvocations(), worker.tail()).toBe(1);
      expect(await worker.remoteSha(branch)).toBe(updatedSha);
      const commits = await worker.github.request<unknown[]>(`/pulls/${pull.number}/commits`);
      expect(commits).toHaveLength(2);
      expect(worker.running).toBe(true);
    });
  }, 300_000);

  test("escalates on the PR after the GitHub CI repair budget is exhausted", async () => {
    await scenario({ ciFailureFix: true }, async (worker) => {
      // Budget 2: the first failure gets a real pushed fix, the second (on the
      // new head) gets a failing fix attempt, which exhausts the budget.
      worker.env.CI_FIX_MAX_ATTEMPTS = "2";
      const failNextAgent = join(worker.root, "fail-next-agent");
      worker.env.E2E_FAIL_ONCE_FILE = failNextAgent;
      const login = await worker.github.login();
      const { branch, pull } = await openAgentPr(worker);

      const first = `E2E_CI_FIX_MARKER_${crypto.randomUUID()}`;
      await worker.postFailedStatus(pull.head.sha, first);
      const repairedSha = await worker.waitForBranchHead(branch, pull.head.sha, 150_000);
      await worker.waitForOutput(/CI fix pushed \(attempt 1\/2\)/, 60_000, "the first CI fix");
      expect(worker.ciInvocations()).toBe(1);

      // Keep failing the new head; the next fix attempt fails deterministically.
      await Bun.write(failNextAgent, "fail\n");
      const second = `E2E_CI_FIX_MARKER_${crypto.randomUUID()}`;
      await worker.postFailedStatus(repairedSha, second);
      const comment = await worker.waitForPullComment(pull.number, "could not fix", 150_000);
      expect(comment.user.login).toBe(login);
      expect(comment.body).toContain("after 2 attempt(s)");
      expect(comment.body).toContain(second);
      expect(worker.ciInvocations()).toBe(2);

      // Another failure on the escalated head must not spend more budget or
      // post a second escalation.
      const third = `E2E_CI_FIX_MARKER_${crypto.randomUUID()}`;
      await worker.postFailedStatus(repairedSha, third);
      await Bun.sleep(6_000);
      expect(worker.ciInvocations(), worker.tail()).toBe(2);
      expect(await worker.remoteSha(branch)).toBe(repairedSha);
      const escalations = (await worker.github.issueComments(pull.number)).filter((candidate) =>
        candidate.body.includes("could not fix"),
      );
      expect(escalations).toHaveLength(1);
      expect(worker.running).toBe(true);
    });
  }, 360_000);
});
