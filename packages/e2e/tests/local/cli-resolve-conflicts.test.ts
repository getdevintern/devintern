/**
 * Standalone `devintern resolve-conflicts <GitLab MR URL>` options, offline.
 *
 * Same fixture as `cli-address-review.test.ts`: the built CLI runs directly
 * from the seeded checkout against the loopback `FakeGitlabForge` and a local
 * bare repository whose target branch conflicts with the MR branch. Covers a
 * stale `--expected-head` / `--expected-base` (deferred, no agent, no push),
 * `--no-push`, a trailing `--expected-head` with no value, and the default
 * merge-and-push with current guards.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cliPath } from "../../helpers/fixture-workspace";
import {
  AGENT_BRANCH,
  BASE_BRANCH,
  BASE_CONFLICT_GREETING,
  agentInvocations,
  cleanupScenario,
  commitParents,
  expectNoTokenInCliOutput,
  isAncestor,
  mergesCleanly,
  openStandaloneScenario,
  revParse,
  runStandaloneCli,
  showFile,
} from "../../helpers/gitlab-webhook-scenario";
import type { ScenarioOwner, StandaloneScenario } from "../../helpers/gitlab-webhook-scenario";
import type { CommandResult } from "../../helpers/process";

const cliTest = test.skipIf(!existsSync(cliPath));

const MERGED_GREETING = 'export const greeting = "Hello, merged!";\n';
const STALE_SHA = "0".repeat(40);

const owned: ScenarioOwner = {};

afterEach(async () => {
  await cleanupScenario(owned);
});

function output(scenario: StandaloneScenario, result: CommandResult): string {
  const text = `exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  return text.split(scenario.codeHostToken).join("[redacted]");
}

cliTest(
  "resolve-conflicts: stale guards defer, --no-push stays local, current guards merge and push",
  async () => {
    const scenario = await openStandaloneScenario(owned, { baseChange: "conflict" });
    const { gitBin, remote } = scenario;
    const url = scenario.forge.mergeRequestUrl;
    const headBefore = revParse(gitBin, remote, AGENT_BRANCH);
    const baseTip = revParse(gitBin, remote, BASE_BRANCH);
    expect(mergesCleanly(gitBin, remote, baseTip, headBefore)).toBe(false);
    // GitLab's `diff_refs.base_sha` (the merge base) is what `--expected-base` is compared with.
    const mergeBase = commitParents(gitBin, remote, baseTip)[0] ?? "";

    // A stale head or base defers (exit 2) before the agent or any push.
    for (const [flag, message] of [
      ["--expected-head", "Deferred: MR head changed before execution"],
      ["--expected-base", "Deferred: MR base changed before execution"],
    ] as const) {
      const result = await runStandaloneCli(scenario, ["resolve-conflicts", url, flag, STALE_SHA]);
      expect(result.exitCode, output(scenario, result)).toBe(2);
      expect(result.stdout).toContain(message);
      expectNoTokenInCliOutput(scenario, result);
    }
    expect(agentInvocations(scenario.invocationsPath)).toEqual([]);
    expect(revParse(gitBin, remote, AGENT_BRANCH)).toBe(headBefore);
    expect(scenario.forge.mutations()).toEqual([]);

    // --no-push resolves and commits locally; the remote branch is unchanged.
    // Observed (unconfirmed intent): a trailing --expected-head with no value
    // is accepted as "no guard" instead of a usage error.
    const noPush = await runStandaloneCli(scenario, [
      "resolve-conflicts",
      "--no-push",
      url,
      "--expected-head",
    ]);
    expect(noPush.exitCode, output(scenario, noPush)).toBe(0);
    expect(agentInvocations(scenario.invocationsPath)).toEqual([{ mode: "conflict" }]);
    expect(revParse(gitBin, remote, AGENT_BRANCH)).toBe(headBefore);
    expect(scenario.forge.mutations()).toEqual([]);
    expectNoTokenInCliOutput(scenario, noPush);

    // Current guards: merge the target into the branch and push without
    // rewriting history (a merge commit on top of the old head).
    const result = await runStandaloneCli(scenario, [
      "resolve-conflicts",
      url,
      "--expected-head",
      headBefore,
      "--expected-base",
      mergeBase,
    ]);
    expect(result.exitCode, output(scenario, result)).toBe(0);
    expect(agentInvocations(scenario.invocationsPath)).toEqual([
      { mode: "conflict" },
      { mode: "conflict" },
    ]);
    const headAfter = revParse(gitBin, remote, AGENT_BRANCH);
    expect(commitParents(gitBin, remote, headAfter)).toEqual([headBefore, baseTip]);
    expect(isAncestor(gitBin, remote, headBefore, headAfter)).toBe(true);
    expect(mergesCleanly(gitBin, remote, baseTip, headAfter)).toBe(true);
    expect(showFile(gitBin, remote, AGENT_BRANCH, "src/greeting.ts")).toBe(MERGED_GREETING);
    expect(revParse(gitBin, remote, BASE_BRANCH)).toBe(baseTip);
    expect(showFile(gitBin, remote, BASE_BRANCH, "src/greeting.ts")).toBe(BASE_CONFLICT_GREETING);
    expect(scenario.forge.unexpected).toEqual([]);
    expect(scenario.forge.authFailures).toEqual([]);
    expectNoTokenInCliOutput(scenario, result);
    // The only forge write is the outcome note on the MR.
    expect(scenario.forge.mutations()).toEqual([
      { method: "POST", path: "/api/v4/projects/fixture%2Frepo/merge_requests/1/notes" },
    ]);
    expect(scenario.forge.notes).toHaveLength(1);
    expect(scenario.forge.notes[0]).toContain("devintern resolved them and pushed the merge");
  },
  300_000,
);
