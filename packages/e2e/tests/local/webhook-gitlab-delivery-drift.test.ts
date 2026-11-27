/**
 * GitLab delivery shapes that vary between GitLab versions and setups, driven
 * through `webhook serve` offline.
 *
 * Same fixture as `webhook-gitlab-ci-sync.test.ts`: the built CLI runs
 * `devintern webhook serve` with the review queue live, against a loopback
 * `FakeGitlabForge`, a local bare repository, and the deterministic agent.
 *
 * - Both `GITLAB_WEBHOOK_SECRET` and `GITLAB_WEBHOOK_SIGNING_TOKEN`
 *   configured: a signed delivery and a token-only delivery are accepted, but
 *   a forged `webhook-signature` is rejected even with the correct
 *   `X-Gitlab-Token` (no downgrade to token auth), and so is a delivery with
 *   neither header.
 * - A legacy Merge Request Hook carrying only `merge_status` (no
 *   `detailed_merge_status`), as older GitLab Self-Managed versions send:
 *   `cannot_be_merged` runs conflict resolution and `can_be_merged` runs
 *   nothing.
 * - Conflict and failed Job/Pipeline deliveries naming a head SHA the MR has
 *   since moved past are acknowledged and settle without an agent run or a
 *   push; the same delivery for the current head does run.
 */

import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cliPath } from "../../helpers/fixture-workspace";
import {
  AGENT_BRANCH,
  BASE_BRANCH,
  BASE_CONFLICT_GREETING,
  UNREGISTERED_IID,
  advanceAgentBranch,
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

const PIPELINE_ID = 3101;
const JOB_ID = 4101;
const MERGED_GREETING = 'export const greeting = "Hello, merged!";\n';
const CI_GREETING = 'export const greeting = "Hello, CI!";\n';

/** Everything a test created, torn down by `afterEach` even after a failure. */
const owned: ScenarioOwner = {};

afterEach(async () => {
  await cleanupScenario(owned);
});

function promptMarker(label: string): string {
  return `E2EPROMPTMARKER${label}${randomBytes(6).toString("hex").toUpperCase()}`;
}

function ciRequests(scenario: Scenario): string[] {
  return scenario.forge.requests
    .map((request) => request.path)
    .filter((path) => /\/(pipelines|jobs|statuses)(\/|\?|$)/.test(path));
}

/** Nothing ran and nothing was pushed or written since `head` was the MR head. */
function expectNoWork(scenario: Scenario, head: string): void {
  expect(agentInvocations(scenario.invocationsPath), diagnostics(scenario)).toEqual([]);
  expect(revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH)).toBe(head);
  expect(scenario.forge.mutations()).toEqual([]);
  expect(scenario.forge.unexpected, diagnostics(scenario)).toEqual([]);
  expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");
}

/**
 * One conflict-resolution run merged the target into `headBefore` with a
 * fast-forward push (same outcome the `detailed_merge_status: conflict` test
 * asserts).
 */
function expectConflictResolved(scenario: Scenario, headBefore: string, baseTip: string): void {
  expect(agentInvocations(scenario.invocationsPath), diagnostics(scenario)).toEqual([
    { mode: "conflict" },
  ]);
  const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
  expect(headAfter).not.toBe(headBefore);
  expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([headBefore, baseTip]);
  expect(isAncestor(scenario.gitBin, scenario.remote, headBefore, headAfter)).toBe(true);
  expect(mergesCleanly(scenario.gitBin, scenario.remote, baseTip, headAfter)).toBe(true);
  expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
    MERGED_GREETING,
  );
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
}

cliTest(
  "both GitLab secrets configured: signed and token-only deliveries pass; a forged signature never downgrades to the token",
  async () => {
    const marker = promptMarker("BOTH");
    const scenario = await openScenario(owned, {
      auth: "both",
      review: {
        body: `Please greet the reviewer instead of the world. E2E_REVIEW_GREETING ${marker}`,
      },
    });
    expect(scenario.signingToken).toBeDefined();
    expect(scenario.sharedToken).toBeDefined();
    const sharedToken = scenario.sharedToken ?? "";
    // Signed: the default delivery in this mode. Also creates `agent_prs`.
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const payload = noteHook(scenario.forge.baseUrl, 1, "Please greet the reviewer.");

    // No downgrade: a forged signature fails even next to the correct
    // X-Gitlab-Token. A delivery with neither header fails too.
    const rejectedAuth = [
      { kind: "forgedSignature", token: sharedToken } as const,
      { kind: "forgedSignature" } as const,
      { kind: "none" } as const,
    ];
    for (const auth of rejectedAuth) {
      const rejected = await deliver(scenario, "Note Hook", payload, undefined, auth);
      expect(rejected.status, `${auth.kind}\n${diagnostics(scenario)}`).toBe(401);
      expect(rejected.body.error).toBe("Invalid GitLab webhook signature");
      expect(deliverySettled(scenario.server.queueDbPath, rejected.webhookId)).toBe(false);
      expect(tokenDeliverySettled(scenario.server.queueDbPath, rejected.webhookId)).toBe(false);
    }
    expect(scenario.forge.requests).toEqual([]);
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).toEqual([]);

    // Token-only (no signature headers) with the right X-Gitlab-Token is
    // accepted and settled under its Idempotency-Key.
    const tokenOnly = await deliver(
      scenario,
      "Note Hook",
      noteHook(scenario.forge.baseUrl, UNREGISTERED_IID, "Token-only delivery."),
      undefined,
      { kind: "token", value: sharedToken },
    );
    expect(tokenOnly.status, diagnostics(scenario)).toBe(200);
    expect(tokenOnly.body.message).toBe("No registered GitLab MR matched");
    expect(tokenDeliverySettled(scenario.server.queueDbPath, tokenOnly.webhookId)).toBe(true);
    expect(scenario.forge.requests).toEqual([]);

    // A correctly signed note on the registered MR runs address-review.
    const signed = await deliver(scenario, "Note Hook", payload);
    expect(signed.status, diagnostics(scenario)).toBe(200);
    expect(signed.body.message).toBe("GitLab event processing started");
    expect(signed.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the signed delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, signed.webhookId),
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

    // The downgrade attempt is still refused after a valid delivery ran.
    const queueRows = webhookEventStatuses(scenario.server.queueDbPath).length;
    const late = await deliver(scenario, "Note Hook", payload, undefined, {
      kind: "forgedSignature",
      token: sharedToken,
    });
    expect(late.status).toBe(401);
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(1);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).toHaveLength(queueRows);
    expect(revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH)).toBe(headAfter);

    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "legacy merge_status without detailed_merge_status: cannot_be_merged runs conflict resolution, can_be_merged runs nothing",
  async () => {
    const scenario = await openScenario(owned, { baseChange: "conflict" });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const baseTip = revParse(scenario.gitBin, scenario.remote, BASE_BRANCH);
    expect(mergesCleanly(scenario.gitBin, scenario.remote, baseTip, headBefore)).toBe(false);
    const baseUrl = scenario.forge.baseUrl;

    const mergeablePayload = mergeabilityHook(baseUrl, 1, headBefore, "mergeable", {
      legacyOnly: true,
    });
    const mergeableAttributes = mergeablePayload.object_attributes as Record<string, unknown>;
    expect(mergeableAttributes.merge_status).toBe("can_be_merged");
    expect("detailed_merge_status" in mergeableAttributes).toBe(false);
    const mergeable = await deliver(scenario, "Merge Request Hook", mergeablePayload);
    expect(mergeable.status, diagnostics(scenario)).toBe(200);
    expect(mergeable.body.message).toBe("GitLab event does not require processing");
    expect(deliverySettled(scenario.server.queueDbPath, mergeable.webhookId)).toBe(true);
    expect(scenario.forge.requests).toEqual([]);
    expectNoWork(scenario, headBefore);

    const conflictPayload = mergeabilityHook(baseUrl, 1, headBefore, "conflict", {
      legacyOnly: true,
    });
    const conflictAttributes = conflictPayload.object_attributes as Record<string, unknown>;
    expect(conflictAttributes.merge_status).toBe("cannot_be_merged");
    expect("detailed_merge_status" in conflictAttributes).toBe(false);
    const conflict = await deliver(scenario, "Merge Request Hook", conflictPayload);
    expect(conflict.status, diagnostics(scenario)).toBe(200);
    expect(conflict.body.message).toBe("GitLab event processing started");
    expect(conflict.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the legacy conflict delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, conflict.webhookId),
    );
    expectConflictResolved(scenario, headBefore, baseTip);
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "conflict Merge Request Hook for a stale last_commit SHA runs nothing; the current head does",
  async () => {
    const scenario = await openScenario(owned, { baseChange: "conflict" });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const oldHead = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const baseTip = revParse(scenario.gitBin, scenario.remote, BASE_BRANCH);
    const newHead = await advanceAgentBranch(scenario, "STALE_SHA_NOTE.md");
    expect(newHead).not.toBe(oldHead);
    expect(mergesCleanly(scenario.gitBin, scenario.remote, baseTip, newHead)).toBe(false);
    const baseUrl = scenario.forge.baseUrl;

    const stale = await deliver(
      scenario,
      "Merge Request Hook",
      mergeabilityHook(baseUrl, 1, oldHead, "conflict"),
    );
    expect(stale.status, diagnostics(scenario)).toBe(200);
    expect(stale.body.message).toBe("GitLab event processing started");
    expect(stale.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the stale conflict delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, stale.webhookId),
    );
    // Processing re-read the MR from the forge, saw a newer head, and stopped.
    expect(scenario.forge.requests.length, diagnostics(scenario)).toBeGreaterThan(0);
    expectNoWork(scenario, newHead);

    // The same delivery naming the current head runs conflict resolution.
    const current = await deliver(
      scenario,
      "Merge Request Hook",
      mergeabilityHook(baseUrl, 1, newHead, "conflict"),
    );
    expect(current.status, diagnostics(scenario)).toBe(200);
    expect(current.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the current-head conflict delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, current.webhookId),
    );
    expectConflictResolved(scenario, newHead, baseTip);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "STALE_SHA_NOTE.md")).toBe(
      "Advanced head: STALE_SHA_NOTE.md\n",
    );
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "failed Job and Pipeline Hooks for a stale head SHA run nothing; the current head runs CI repair",
  async () => {
    const jobMarker = promptMarker("JOB");
    const traceMarker = promptMarker("TRACE");
    const jobName = `unit-${jobMarker}`;
    const scenario = await openScenario(owned, {
      ci: {
        pipelineId: PIPELINE_ID,
        jobId: JOB_ID,
        jobName,
        // E2E_CI_FIX_MARKER selects the deterministic agent's CI-repair mode.
        trace: `$ bun test\nE2E_CI_FIX_MARKER greeting assertion failed ${traceMarker}\nJob failed: exit code 1\n`,
      },
    });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const oldHead = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    const newHead = await advanceAgentBranch(scenario, "STALE_CI_NOTE.md");
    expect(newHead).not.toBe(oldHead);
    // The failed pipeline now belongs to the new head only.
    scenario.forge.setCiSha(newHead);
    const baseUrl = scenario.forge.baseUrl;
    const job = { id: JOB_ID, name: jobName, pipelineId: PIPELINE_ID };

    const staleDeliveries = [
      await deliver(scenario, "Job Hook", jobHook(baseUrl, oldHead, "failed", job)),
      await deliver(
        scenario,
        "Pipeline Hook",
        pipelineHook(baseUrl, 1, oldHead, "failed", PIPELINE_ID),
      ),
    ];
    for (const stale of staleDeliveries) {
      expect(stale.status, diagnostics(scenario)).toBe(200);
      expect(stale.body.message).toBe("GitLab event processing started");
      expect(stale.body.matchedMergeRequests).toBe(1);
    }
    await waitFor(scenario, "both stale CI deliveries to settle", () =>
      staleDeliveries.every((stale) =>
        deliverySettled(scenario.server.queueDbPath, stale.webhookId),
      ),
    );
    // The MR was read, but no CI data was fetched for the old SHA.
    expect(scenario.forge.requests.length, diagnostics(scenario)).toBeGreaterThan(0);
    expect(ciRequests(scenario)).toEqual([]);
    expectNoWork(scenario, newHead);

    // A failed Job Hook naming the current head runs one CI repair.
    const current = await deliver(scenario, "Job Hook", jobHook(baseUrl, newHead, "failed", job));
    expect(current.status, diagnostics(scenario)).toBe(200);
    expect(current.body.matchedMergeRequests).toBe(1);
    await waitFor(scenario, "the current-head Job Hook to settle", () =>
      deliverySettled(scenario.server.queueDbPath, current.webhookId),
    );
    const invocations = agentInvocations(scenario.invocationsPath);
    expect(invocations, diagnostics(scenario)).toHaveLength(1);
    expect(invocations[0]?.mode).toBe("ci");
    expect(invocations[0]?.promptMarkers ?? []).toContain(jobMarker);
    expect(invocations[0]?.promptMarkers ?? []).toContain(traceMarker);
    const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([newHead]);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      CI_GREETING,
    );
    expect(ciRequests(scenario)).toContain(
      `/api/v4/projects/1/pipelines?sha=${newHead}&per_page=100&page=1`,
    );
    expect(ciRequests(scenario).some((path) => path.includes(oldHead))).toBe(false);
    expect(scenario.forge.unexpected, diagnostics(scenario)).toEqual([]);
    expect(scenario.forge.authFailures).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");
    expectNoSecretsInOutput(scenario);
  },
  180_000,
);
