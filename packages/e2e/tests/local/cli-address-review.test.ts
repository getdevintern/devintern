/**
 * Standalone `devintern address-review <GitLab MR URL>` options, offline.
 *
 * The built CLI runs directly from the seeded checkout (no worker, no
 * `webhook serve`) against the loopback `FakeGitlabForge` and a local bare
 * repository, with the deterministic agent. The GitLab URL and token come
 * from a plain project env; no workspace is registered. Covers `--no-push`,
 * `--no-reply`, `--ci-feedback`, `--expected-head`, and the parser's
 * missing-value errors. GitHub is out of scope: its review client hardcodes
 * `https://api.github.com`.
 */

import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath } from "../../helpers/fixture-workspace";
import {
  AGENT_BRANCH,
  agentInvocations,
  cleanupScenario,
  commitParents,
  expectNoTokenInCliOutput,
  openStandaloneScenario,
  revParse,
  runStandaloneCli,
  showFile,
} from "../../helpers/gitlab-webhook-scenario";
import type { ScenarioOwner, StandaloneScenario } from "../../helpers/gitlab-webhook-scenario";
import type { CommandResult } from "../../helpers/process";

const cliTest = test.skipIf(!existsSync(cliPath));

const REVIEW_GREETING = 'export const greeting = "Hello, reviewer!";\n';
const CI_GREETING = 'export const greeting = "Hello, CI!";\n';
const STALE_SHA = "0".repeat(40);
const REPLY_PATH = /^\/api\/v4\/projects\/1\/merge_requests\/1\/discussions\/[^/]+\/notes$/;

const owned: ScenarioOwner = {};

afterEach(async () => {
  await cleanupScenario(owned);
});

function marker(label = ""): string {
  return `E2EPROMPTMARKER${label}${randomBytes(6).toString("hex").toUpperCase()}`;
}

function reviewBody(promptMarker: string): string {
  return `Please greet the reviewer instead of the world. E2E_REVIEW_GREETING ${promptMarker}`;
}

function output(scenario: StandaloneScenario, result: CommandResult): string {
  const text = `exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  return text.split(scenario.codeHostToken).join("[redacted]");
}

function remoteHead(scenario: StandaloneScenario): string {
  return revParse(scenario.gitBin, scenario.remote, AGENT_BRANCH);
}

/** The forge saw no write: no reply, MR note, or merge. */
function expectNoForgeWrites(scenario: StandaloneScenario): void {
  expect(scenario.forge.mutations()).toEqual([]);
  expect(scenario.forge.discussionReplies).toEqual([]);
  expect(scenario.forge.notes).toEqual([]);
}

function expectCleanForge(scenario: StandaloneScenario): void {
  expect(scenario.forge.unexpected).toEqual([]);
  expect(scenario.forge.authFailures).toEqual([]);
}

cliTest(
  "address-review: missing flag values, --no-push, stale and current --expected-head",
  async () => {
    const promptMarker = marker();
    const scenario = await openStandaloneScenario(owned, {
      review: { body: reviewBody(promptMarker) },
    });
    const url = scenario.forge.mergeRequestUrl;
    const headBefore = remoteHead(scenario);

    // A flag whose value is missing (or is another flag) is a usage error:
    // exit 1 before the forge or agent is touched.
    for (const [args, message] of [
      [[url, "--ci-feedback"], "Error: --ci-feedback requires a file path"],
      [[url, "--expected-head", "--no-push"], "Error: --expected-head requires a commit SHA"],
    ] as const) {
      const result = await runStandaloneCli(scenario, ["address-review", ...args]);
      expect(result.exitCode, output(scenario, result)).toBe(1);
      expect(result.stderr).toContain(message);
      expectNoTokenInCliOutput(scenario, result);
    }
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(scenario.forge.requests).toEqual([]);

    // --no-push: the agent runs and the commit stays local. No reply either,
    // because acknowledging is skipped whenever the push is.
    const noPush = await runStandaloneCli(scenario, ["address-review", url, "--no-push"]);
    expect(noPush.exitCode, output(scenario, noPush)).toBe(0);
    expect(noPush.stdout).toContain("Skipping push (--no-push flag)");
    expect(agentInvocations(scenario.invocationsPath)).toEqual([
      { mode: "review", promptMarkers: [promptMarker] },
    ]);
    expect(remoteHead(scenario)).toBe(headBefore);
    const localHead = revParse(scenario.gitBin, join(scenario.seed, ".git"), AGENT_BRANCH);
    expect(localHead).not.toBe(headBefore);
    expect(commitParents(scenario.gitBin, join(scenario.seed, ".git"), localHead)).toEqual([
      headBefore,
    ]);
    expectNoForgeWrites(scenario);
    expectNoTokenInCliOutput(scenario, noPush);

    // A stale --expected-head refuses before the agent or any push.
    const stale = await runStandaloneCli(scenario, [
      "address-review",
      url,
      "--expected-head",
      STALE_SHA,
    ]);
    expect(stale.exitCode, output(scenario, stale)).toBe(1);
    expect(stale.stderr).toContain(
      "MR head changed before CI repair started; refusing stale feedback.",
    );
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(1);
    expect(remoteHead(scenario)).toBe(headBefore);
    expectNoForgeWrites(scenario);
    expectNoTokenInCliOutput(scenario, stale);

    // The current head proceeds with the default flags: the worktree is
    // rebuilt from the remote (the --no-push commit is not pushed), the agent
    // runs again, its commit lands as a fast-forward, and the discussion gets
    // one reply.
    const current = await runStandaloneCli(scenario, [
      "address-review",
      url,
      "--expected-head",
      headBefore,
    ]);
    expect(current.exitCode, output(scenario, current)).toBe(0);
    expect(agentInvocations(scenario.invocationsPath)).toHaveLength(2);
    const headAfter = remoteHead(scenario);
    expect(headAfter).not.toBe(headBefore);
    expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([headBefore]);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      REVIEW_GREETING,
    );
    expect(scenario.forge.discussionReplies).toHaveLength(1);
    expect(scenario.forge.discussionReplies[0]?.body).toContain(
      "Addressed this feedback in the latest commit.",
    );
    expect(scenario.forge.mutations()).toEqual([
      { method: "POST", path: expect.stringMatching(REPLY_PATH) },
    ]);
    expect(scenario.forge.notes).toEqual([]);
    expectCleanForge(scenario);
    expectNoTokenInCliOutput(scenario, current);
  },
  300_000,
);

cliTest(
  "address-review --no-reply pushes the fix without replying to the discussion",
  async () => {
    const promptMarker = marker();
    const scenario = await openStandaloneScenario(owned, {
      review: { body: reviewBody(promptMarker) },
    });
    const headBefore = remoteHead(scenario);

    const result = await runStandaloneCli(scenario, [
      "address-review",
      scenario.forge.mergeRequestUrl,
      "--no-reply",
    ]);
    expect(result.exitCode, output(scenario, result)).toBe(0);
    expect(result.stdout).toContain("Skipping marking comments (--no-reply flag)");
    expect(agentInvocations(scenario.invocationsPath)).toEqual([
      { mode: "review", promptMarkers: [promptMarker] },
    ]);
    const headAfter = remoteHead(scenario);
    expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([headBefore]);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      REVIEW_GREETING,
    );
    expectNoForgeWrites(scenario);
    expectCleanForge(scenario);
    expectNoTokenInCliOutput(scenario, result);
  },
  180_000,
);

cliTest(
  "address-review --ci-feedback fixes the failing check without a review reply",
  async () => {
    const reviewMarker = marker("REVIEW");
    const checkMarker = marker("CHECK");
    const logMarker = marker("LOG");
    // The MR also has an open reviewer discussion, so a reply would be possible.
    const scenario = await openStandaloneScenario(owned, {
      review: { body: reviewBody(reviewMarker) },
    });
    const url = scenario.forge.mergeRequestUrl;
    const headBefore = remoteHead(scenario);

    // Same shape the worker's CI failure watcher writes.
    const feedbackPath = join(scenario.root, "ci-feedback.json");
    writeFileSync(
      feedbackPath,
      JSON.stringify({
        repository: "fixture/repo",
        prNumber: 1,
        failures: [{ name: `unit-${checkMarker}`, conclusion: "failed" }],
        logs: `$ bun test\nE2E_CI_FIX_MARKER greeting assertion failed ${logMarker}\n`,
      }),
    );

    // A stale --expected-head refuses the CI repair too.
    const stale = await runStandaloneCli(scenario, [
      "address-review",
      url,
      "--ci-feedback",
      feedbackPath,
      "--expected-head",
      STALE_SHA,
    ]);
    expect(stale.exitCode, output(scenario, stale)).toBe(1);
    expect(stale.stderr).toContain("refusing stale feedback");
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(remoteHead(scenario)).toBe(headBefore);

    const result = await runStandaloneCli(scenario, [
      "address-review",
      url,
      "--ci-feedback",
      feedbackPath,
      "--expected-head",
      headBefore,
    ]);
    expect(result.exitCode, output(scenario, result)).toBe(0);
    expect(result.stdout).toContain("CI failure mode: fixing 1 failing check(s)");
    expect(result.stdout).toContain("Successfully pushed a CI fix for MR #1");
    // The prompt carried the check name and log excerpt, not the discussion.
    expect(agentInvocations(scenario.invocationsPath)).toEqual([
      { mode: "ci", promptMarkers: [checkMarker, logMarker] },
    ]);
    const headAfter = remoteHead(scenario);
    expect(commitParents(scenario.gitBin, scenario.remote, headAfter)).toEqual([headBefore]);
    expect(showFile(scenario.gitBin, scenario.remote, AGENT_BRANCH, "src/greeting.ts")).toBe(
      CI_GREETING,
    );
    expectNoForgeWrites(scenario);
    expectCleanForge(scenario);
    expectNoTokenInCliOutput(scenario, stale);
    expectNoTokenInCliOutput(scenario, result);
  },
  180_000,
);
