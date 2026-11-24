/**
 * Signed GitLab MR deliveries drive the `webhook serve` review pipeline offline.
 *
 * The built CLI runs `devintern webhook serve` against a loopback GitLab v4
 * stand-in (`FakeGitlabForge`) and a local bare repository. Deliveries are
 * signed with GitLab Standard Webhooks headers. A note on a registered agent MR
 * must spawn `address-review`, run the deterministic agent on the reviewer's
 * feedback, push a commit to the MR branch, and reply to the discussion;
 * merge/close hooks must settle the registry row; and a delivery for an
 * unregistered MR must be acknowledged without touching the agent or forge.
 *
 * Unlike `webhook-serve.test.ts`, the review queue is not paused: these
 * deliveries really reach the pipeline, and the fake forge and bare remote are
 * the only things it can reach.
 */

import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cliPath } from "../../helpers/fixture-workspace";
import {
  AGENT_BRANCH,
  BASE_BRANCH,
  SECOND_BRANCH,
  agentInvocations,
  agentPrRows,
  cleanupScenario,
  deliver,
  deliverySettled,
  diagnostics,
  expectNoSecretsInOutput,
  expectUnregisteredNoteIgnored,
  mergeRequestHook,
  noteHook,
  openScenario,
  registerMergeRequest,
  revParse,
  showFile,
  waitFor,
  webhookEventStatuses,
} from "../../helpers/gitlab-webhook-scenario";
import type { ScenarioOwner } from "../../helpers/gitlab-webhook-scenario";

const cliTest = test.skipIf(!existsSync(cliPath));

/** Everything a test created, torn down by `afterEach` even after a failure. */
const owned: ScenarioOwner = {};

afterEach(async () => {
  await cleanupScenario(owned);
});

cliTest(
  "signed GitLab MR note on a registered agent MR runs address-review and replies",
  async () => {
    const marker = `E2EPROMPTMARKER${randomBytes(6).toString("hex").toUpperCase()}`;
    const scenario = await openScenario(owned, {
      review: {
        body: `Please greet the reviewer instead of the world. E2E_REVIEW_GREETING ${marker}`,
      },
    });
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    const headBefore = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);

    // The delivery's own note text carries no marker: the agent can only see
    // it by fetching the MR discussions from the forge.
    const notePayload = noteHook(scenario.forge.baseUrl, 1, "Please greet the reviewer.");
    const accepted = await deliver(scenario, "Note Hook", notePayload);
    expect(accepted.status, diagnostics(scenario)).toBe(200);
    expect(accepted.body.message).toBe("GitLab event processing started");
    expect(accepted.body.matchedMergeRequests).toBe(1);

    await waitFor(scenario, "the delivery to settle", () =>
      deliverySettled(scenario.server.queueDbPath, accepted.webhookId),
    );

    // The deterministic agent ran once, in review mode, on a prompt that
    // carried the reviewer's discussion note fetched from the forge.
    const invocations = agentInvocations(scenario.invocationsPath);
    expect(invocations, diagnostics(scenario)).toHaveLength(1);
    expect(invocations[0]?.mode).toBe("review");
    expect(invocations[0]?.promptMarkers).toEqual([marker]);

    // A new commit with the review edit landed on the MR branch.
    const headAfter = revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
    expect(headAfter).not.toBe(headBefore);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      'export const greeting = "Hello, reviewer!";\n',
    );

    // The run replied to the discussion (and wrote nothing else).
    expect(scenario.forge.discussionReplies, diagnostics(scenario)).toHaveLength(1);
    expect(scenario.forge.discussionReplies[0]?.body).toContain(
      "Addressed this feedback in the latest commit.",
    );
    expect(scenario.forge.mutations()).toEqual([
      {
        method: "POST",
        path: expect.stringMatching(
          /^\/api\/v4\/projects\/1\/merge_requests\/1\/discussions\/[^/]+\/notes$/,
        ),
      },
    ]);
    expect(scenario.forge.notes).toEqual([]);
    expect(scenario.forge.unexpected).toEqual([]);
    expect(scenario.forge.authFailures).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");

    // The settled delivery is deduplicated: a replay never runs the agent again.
    const forgeBefore = scenario.forge.requests.length;
    const replay = await deliver(scenario, "Note Hook", notePayload, accepted.webhookId);
    expect(replay.status).toBe(200);
    expect(replay.body.message).toBe("Duplicate delivery");
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(1);
    expect(scenario.forge.requests.length).toBe(forgeBefore);
    expect(revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH)).toBe(headAfter);

    expectNoSecretsInOutput(scenario);
  },
  180_000,
);

cliTest(
  "signed GitLab merge/close hooks settle registered MRs; unregistered MRs are ignored",
  async () => {
    const scenario = await openScenario(owned);
    await expectUnregisteredNoteIgnored(scenario);
    registerMergeRequest(scenario, 1, AGENT_BRANCH);
    registerMergeRequest(scenario, 2, SECOND_BRANCH);

    // With registered rows present, an unregistered iid still matches nothing.
    await expectUnregisteredNoteIgnored(scenario);

    const mergedAt = "2026-11-20T12:00:00.000Z";
    const merged = await deliver(
      scenario,
      "Merge Request Hook",
      mergeRequestHook(scenario.forge.baseUrl, 1, AGENT_BRANCH, "merge", mergedAt),
    );
    expect(merged.status, diagnostics(scenario)).toBe(200);
    expect(merged.body.matchedMergeRequests).toBe(1);

    const closed = await deliver(
      scenario,
      "Merge Request Hook",
      mergeRequestHook(scenario.forge.baseUrl, 2, SECOND_BRANCH, "close"),
    );
    expect(closed.status, diagnostics(scenario)).toBe(200);
    expect(closed.body.matchedMergeRequests).toBe(1);

    await waitFor(
      scenario,
      "both lifecycle deliveries to settle",
      () =>
        deliverySettled(scenario.server.queueDbPath, merged.webhookId) &&
        deliverySettled(scenario.server.queueDbPath, closed.webhookId),
    );

    const rows = agentPrRows(scenario.server.queueDbPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      change_number: 1,
      state: "closed",
      close_reason: "merged",
      host_merged_at: Date.parse(mergedAt),
      merged_into: BASE_BRANCH,
    });
    expect(rows[0]?.merged_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      change_number: 2,
      state: "closed",
      close_reason: "closed",
      merged_at: null,
      host_merged_at: null,
      merged_into: null,
    });

    // Lifecycle handling is local bookkeeping: no agent run, no forge call.
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(scenario.forge.requests).toEqual([]);
    expect(webhookEventStatuses(scenario.server.queueDbPath)).not.toContain("failed");

    // A merged MR is no longer open, so a later note for it matches nothing.
    const late = await deliver(
      scenario,
      "Note Hook",
      noteHook(scenario.forge.baseUrl, 1, "One more thing after merge."),
    );
    expect(late.status).toBe(200);
    expect(late.body.message).toBe("No registered GitLab MR matched");
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(scenario.forge.requests).toEqual([]);

    expectNoSecretsInOutput(scenario);
  },
  120_000,
);
