/**
 * GitLab Pipeline/Job, MR-mergeability, and `X-Gitlab-Token` deliveries drive
 * `webhook serve` offline.
 *
 * Same fixture as `webhook-gitlab-review.test.ts`: the built CLI runs
 * `devintern webhook serve` with the review queue live, against a loopback
 * `FakeGitlabForge`, a local bare repository, and the deterministic agent.
 *
 * - A failed Pipeline Hook (or Job Hook) for a registered agent MR's current
 *   head reads the failed job and its trace from the forge and runs CI repair,
 *   which pushes a commit to the MR branch. Non-failed and stale-SHA pipeline
 *   deliveries are acknowledged without an agent run.
 * - A Merge Request Hook reporting `detailed_merge_status: conflict` runs
 *   conflict resolution, which merges the target into the MR branch and
 *   pushes without rewriting history. `need_rebase` takes the same path.
 * - In shared-token mode (`GITLAB_WEBHOOK_SECRET`), a Note Hook with the
 *   matching `X-Gitlab-Token` runs address-review; a wrong or missing token is
 *   rejected with 401 before anything is queued.
 */

import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cliPath } from "../../helpers/fixture-workspace";
import {
  AGENT_BRANCH,
  BASE_BRANCH,
  BASE_CONFLICT_GREETING,
  BASE_ONLY_FILE,
  agentInvocations,
  cleanupScenario,
  commitParents,
  deliver,
  deliverySettled,
  diagnostics,
  expectNoSecretsInOutput,
  expectUnregisteredNoteIgnored,
  isAncestor,
  jobHook,
  mergeabilityHook,
  mergesCleanly,
  noteHook,
  openScenario,
  pipelineHook,
  registerMergeRequest,
  revParse,
  showFile,
  tokenDeliverySettled,
  waitFor,
  webhookEventStatuses,
} from "../../helpers/gitlab-webhook-scenario";
import type { Scenario, ScenarioOwner } from "../../helpers/gitlab-webhook-scenario";

const cliTest = test.skipIf(!existsSync(cliPath));

const PIPELINE_ID = 3001;
const JOB_ID = 4001;
const CI_GREETING = 'export const greeting = "Hello, CI!";\n';
const MERGED_GREETING = 'export const greeting = "Hello, merged!";\n';

/** Everything a test created, torn down by `afterEach` even after a failure. */
const owned: ScenarioOwner = {};

afterEach(async () => {
  await cleanupScenario(owned);
});

function promptMarker(label: string): string {
  return `E2EPROMPTMARKER${label}${randomBytes(6).toString("hex").toUpperCase()}`;
}

/** A failed job whose name and trace each carry a unique prompt marker. */
function ciFixture(): {
  jobMarker: string;
  traceMarker: string;
  ci: { pipelineId: number; jobId: number; jobName: string; trace: string };
} {
  const jobMarker = promptMarker("JOB");
  const traceMarker = promptMarker("TRACE");
  return {
    jobMarker,
    traceMarker,
    ci: {
      pipelineId: PIPELINE_ID,
      jobId: JOB_ID,
      jobName: `unit-${jobMarker}`,
      // E2E_CI_FIX_MARKER selects the deterministic agent's CI-repair mode.
      trace: `$ bun test\nE2E_CI_FIX_MARKER greeting assertion failed ${traceMarker}\nJob failed: exit code 1\n`,
    },
  };
}

function ciRequests(scenario: Scenario): string[] {
  return scenario.forge.requests
    .map((request) => request.path)
    .filter((path) => /\/(pipelines|jobs|statuses)(\/|\?|$)/.test(path));
}

/** Assert the single CI-repair run and the commit it pushed after a settled delivery. */
function expectCiRepair(
  scenario: Scenario,
  headBefore: string,
  markers: { jobMarker: string; traceMarker: string },
): void {
  const invocations = agentInvocations(scenario.invocationsPath);
  expect(invocations, diagnostics(scenario)).toHaveLength(1);
  expect(invocations[0]?.mode).toBe("ci");
  // The failed job name and its trace reached the prompt only via the forge.
  expect(invocations[0]?.promptMarkers ?? [], diagnostics(scenario)).toContain(markers.jobMarker);
  expect(invocations[0]?.promptMarkers ?? []).toContain(markers.traceMarker);

  const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
  expect(headAfter).not.toBe(headBefore);
  expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([headBefore]);
  expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
    CI_GREETING,
  );

  const paths = ciRequests(scenario);
  expect(paths, diagnostics(scenario)).toContain(
    `/api/v4/projects/1/pipelines?sha=${headBefore}&per_page=100&page=1`,
  );
  expect(paths).toContain(
    `/api/v4/projects/1/pipelines/${PIPELINE_ID}/jobs?include_retried=false&per_page=100&page=1`,
  );
  expect(paths).toContain(`/api/v4/projects/1/jobs/${JOB_ID}/trace`);
  expect(scenario.forge.unexpected, diagnostics(scenario)).toEqual([]);
  expect(scenario.forge.authFailures).toEqual([]);
  expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");
}

cliTest(
  "signed GitLab Pipeline Hook failure on a registered agent MR runs CI repair",
  async () => {
    const fixture = ciFixture();
    const scenario = await openScenario(owned, { ci: fixture.ci });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const baseUrl = scenario.forge.baseUrl;

    // A running pipeline is not a failure: acknowledged without any work.
    const running = await deliver(
      scenario,
      "Pipeline Hook",
      pipelineHook(baseUrl, 1, headBefore, "running", PIPELINE_ID),
    );
    expect(running.status, diagnostics(scenario)).toBe(200);
    expect(running.body.message).toBe("GitLab event does not require processing");
    expect(deliverySettled(scenario.server.queueDbPath, running.webhookId)).toBe(true);
    expect(scenario.forge.requests).toEqual([]);

    // A failed pipeline for a SHA that is no longer the MR head is stale: the
    // MR is read, but no CI data is fetched and no agent runs.
    const staleSha = randomBytes(20).toString("hex");
    const stale = await deliver(
      scenario,
      "Pipeline Hook",
      pipelineHook(baseUrl, 1, staleSha, "failed", PIPELINE_ID),
    );
    expect(stale.status, diagnostics(scenario)).toBe(200);
    expect(stale.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the stale delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, stale.webhookId),
    );
    expect(scenario.forge.requests.length, diagnostics(scenario)).toBeGreaterThan(0);
    expect(ciRequests(scenario)).toEqual([]);
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH)).toBe(headBefore);

    // A failed pipeline on the current head runs exactly one CI repair.
    const failed = await deliver(
      scenario,
      "Pipeline Hook",
      pipelineHook(baseUrl, 1, headBefore, "failed", PIPELINE_ID),
    );
    expect(failed.status, diagnostics(scenario)).toBe(200);
    expect(failed.body.message).toBe("GitLab event processing started");
    expect(failed.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the failed-pipeline delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, failed.webhookId),
    );
    expectCiRepair(scenario, headBefore, fixture);
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "signed GitLab Job Hook failure on a registered agent MR branch runs CI repair",
  async () => {
    const fixture = ciFixture();
    const scenario = await openScenario(owned, { ci: fixture.ci });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const job = { id: JOB_ID, name: fixture.ci.jobName, pipelineId: PIPELINE_ID };

    const passed = await deliver(
      scenario,
      "Job Hook",
      jobHook(scenario.forge.baseUrl, headBefore, "success", job),
    );
    expect(passed.status, diagnostics(scenario)).toBe(200);
    expect(passed.body.message).toBe("GitLab event does not require processing");
    expect(scenario.forge.requests).toEqual([]);

    // Job Hooks carry no MR iid: the delivery matches the registered MR by branch.
    const failed = await deliver(
      scenario,
      "Job Hook",
      jobHook(scenario.forge.baseUrl, headBefore, "failed", job),
    );
    expect(failed.status, diagnostics(scenario)).toBe(200);
    expect(failed.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the failed-job delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, failed.webhookId),
    );
    expectCiRepair(scenario, headBefore, fixture);
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "signed GitLab MR conflict delivery runs conflict resolution and pushes a merge",
  async () => {
    const scenario = await openScenario(owned, { baseChange: "conflict" });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const baseTip = revParse(scenario.gitBin, scenario.remote, BASE_BRANCH);
    expect(mergesCleanly(scenario.gitBin, scenario.remote, baseTip, headBefore)).toBe(false);

    const conflict = await deliver(
      scenario,
      "Merge Request Hook",
      mergeabilityHook(scenario.forge.baseUrl, 1, headBefore, "conflict"),
    );
    expect(conflict.status, diagnostics(scenario)).toBe(200);
    expect(conflict.body.message).toBe("GitLab event processing started");
    expect(conflict.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the conflict delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, conflict.webhookId),
    );

    expect(agentInvocations(scenario.invocationsPath), diagnostics(scenario)).toEqual([
      { mode: "conflict" },
    ]);
    // `git merge origin/<target>`: a merge commit on top of the old head, so
    // the push is a fast-forward and nothing was force-pushed.
    const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    expect(headAfter).not.toBe(headBefore);
    expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([
      headBefore,
      baseTip,
    ]);
    expect(isAncestor(scenario.gitBin, scenario.remote, headBefore, headAfter)).toBe(true);
    expect(isAncestor(scenario.gitBin, scenario.remote, baseTip, headAfter)).toBe(true);
    expect(mergesCleanly(scenario.gitBin, scenario.remote, baseTip, headAfter)).toBe(true);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      MERGED_GREETING,
    );
    // The target branch is untouched.
    expect(revParse(scenario.gitBin, scenario.remote, BASE_BRANCH)).toBe(baseTip);
    expect(showFile(scenario.gitBin, scenario.remote, BASE_BRANCH, "src/greeting.ts")).toBe(
      BASE_CONFLICT_GREETING,
    );
    expect(
      scenario.forge.mutations().some((request) => request.path.split("?")[0]?.endsWith("/merge")),
    ).toBe(false);
    expect(scenario.forge.unexpected, diagnostics(scenario)).toEqual([]);
    expect(scenario.forge.authFailures).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "signed GitLab MR need_rebase delivery merges the target without an agent run",
  async () => {
    const scenario = await openScenario(owned, { baseChange: "behind" });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const baseTip = revParse(scenario.gitBin, scenario.remote, BASE_BRANCH);

    const behind = await deliver(
      scenario,
      "Merge Request Hook",
      mergeabilityHook(scenario.forge.baseUrl, 1, headBefore, "need_rebase"),
    );
    expect(behind.status, diagnostics(scenario)).toBe(200);
    expect(behind.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the need_rebase delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, behind.webhookId),
    );

    const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    // `need_rebase` takes the same resolve-conflicts path, which merges the
    // target cleanly itself: no agent run, a merge commit pushed as a
    // fast-forward, and one MR note saying so.
    expect(agentInvocations(scenario.invocationsPath), diagnostics(scenario)).toEqual([]);
    expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([
      headBefore,
      baseTip,
    ]);
    expect(mergesCleanly(scenario.gitBin, scenario.remote, baseTip, headAfter)).toBe(true);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, BASE_ONLY_FILE)).toBe(
      "Target-only change.\n",
    );
    expect(revParse(scenario.gitBin, scenario.remote, BASE_BRANCH)).toBe(baseTip);
    expect(scenario.forge.notes).toEqual([
      `🔀 Merged \`${BASE_BRANCH}\` into this branch (no conflicts).`,
    ]);
    expect(scenario.forge.mutations()).toEqual([
      { method: "POST", path: "/api/v4/projects/fixture%2Frepo/merge_requests/1/notes" },
    ]);
    expect(scenario.forge.unexpected, diagnostics(scenario)).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "X-Gitlab-Token mode: matching token runs address-review; wrong or missing token is rejected",
  async () => {
    const marker = promptMarker("TOKEN");
    const scenario = await openScenario(owned, {
      auth: "token",
      review: {
        body: `Please greet the reviewer instead of the world. E2E_REVIEW_GREETING ${marker}`,
      },
    });
    expect(scenario.signingToken).toBeUndefined();
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const payload = noteHook(scenario.forge.baseUrl, 1, "Please greet the reviewer.");

    // Wrong and missing tokens are rejected before parsing or queueing.
    const wrongToken = `e2e-wrong-token-${randomBytes(16).toString("hex")}`;
    for (const auth of [{ kind: "token", value: wrongToken } as const, { kind: "none" } as const]) {
      const rejected = await deliver(scenario, "Note Hook", payload, undefined, auth);
      expect(rejected.status, diagnostics(scenario)).toBe(401);
      expect(rejected.body.error).toBe("Invalid GitLab webhook signature");
      expect(tokenDeliverySettled(scenario.server.queueDbPath, rejected.webhookId)).toBe(false);
    }
    expect(scenario.forge.requests).toEqual([]);
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).toEqual([]);

    const accepted = await deliver(scenario, "Note Hook", payload);
    expect(accepted.status, diagnostics(scenario)).toBe(200);
    expect(accepted.body.message).toBe("GitLab event processing started");
    expect(accepted.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the token-authenticated delivery to settle", () =>
      tokenDeliverySettled(scenario.server.queueDbPath, accepted.webhookId),
    );

    const invocations = agentInvocations(scenario.invocationsPath);
    expect(invocations, diagnostics(scenario)).toHaveLength(1);
    expect(invocations[0]?.mode).toBe("review");
    expect(invocations[0]?.promptMarkers).toEqual([marker]);
    const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    expect(headAfter).not.toBe(headBefore);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      'export const greeting = "Hello, reviewer!";\n',
    );
    expect(scenario.forge.discussionReplies, diagnostics(scenario)).toHaveLength(1);
    expect(scenario.forge.unexpected).toEqual([]);
    expect(scenario.forge.authFailures).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");

    // A replay with the same Idempotency-Key is deduplicated.
    const forgeBefore = scenario.forge.requests.length;
    const replay = await deliver(scenario, "Note Hook", payload, accepted.webhookId);
    expect(replay.status).toBe(200);
    expect(replay.body.message).toBe("Duplicate delivery");
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(1);
    expect(scenario.forge.requests.length).toBe(forgeBefore);

    // A wrong token is still rejected after a valid delivery was processed.
    const late = await deliver(scenario, "Note Hook", payload, undefined, {
      kind: "token",
      value: wrongToken,
    });
    expect(late.status).toBe(401);
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(1);

    expectNoSecretsInOutput(scenario);
    const output = `${scenario.server.stdout}\n${scenario.server.stderr}`;
    expect(output.includes(wrongToken)).toBe(false);
  },
  180_000,
);
