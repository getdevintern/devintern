import { afterEach, describe, expect, test } from "bun:test";

import { autoMergeCliArgs, parseAutoMergeResultLine } from "../src/lib/acquirers/auto-merge-cli";
import {
  checkRollupForRef,
  listCheckRunsForRef,
  listLatestCommitStatuses,
} from "../src/lib/code-host/github/commit-checks";
import { GitHubReviewsClient } from "../src/lib/code-host/github/reviews";
import { buildAutoMergeStatusComment } from "../src/lib/review/auto-merge-comment";
import {
  checkRunState,
  ciChecksFromRollup,
  commitStatusState,
  hiddenCheckRunsName,
  evaluateCiChecks,
  NO_CI_CHECKS_MESSAGE,
  normalizeCiChecks,
} from "../src/lib/review/ci-checks";
import { parseAutoMergeArgs } from "../src/lib/review/cli";
import { autoMergeRequireChecksFor, parseWorkspaceConfig } from "../src/lib/workspace/config";
import { fleetAutoMergePolicyFingerprint } from "../src/lib/workspace/fleet-events";

const gate = await import("../src/lib/review/merge-gate");

describe("checkRunState / commitStatusState", () => {
  test("maps check runs: incomplete is pending, unknown conclusions fail closed", () => {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      expect(checkRunState({ status, conclusion: null })).toBe("pending");
    }
    expect(checkRunState({ status: "completed", conclusion: "success" })).toBe("success");
    expect(checkRunState({ status: "completed", conclusion: "skipped" })).toBe("neutral");
    expect(checkRunState({ status: "completed", conclusion: "neutral" })).toBe("neutral");
    for (const conclusion of [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "stale",
      "something-new",
      null,
    ]) {
      expect(checkRunState({ status: "completed", conclusion })).toBe("failing");
    }
  });

  test("maps commit statuses", () => {
    expect(commitStatusState("success")).toBe("success");
    expect(commitStatusState("pending")).toBe("pending");
    expect(commitStatusState("failure")).toBe("failing");
    expect(commitStatusState("error")).toBe("failing");
  });
});

describe("evaluateCiChecks", () => {
  const strict = { requireSuccess: true };

  test("zero checks need a passing check unless waived", () => {
    expect(evaluateCiChecks([], strict)).toEqual({
      ready: false,
      problem: "no-checks",
      message: NO_CI_CHECKS_MESSAGE,
    });
    expect(evaluateCiChecks([], { requireSuccess: false })).toEqual({ ready: true });
  });

  test("failing beats pending, and pending beats a missing success", () => {
    const checks = normalizeCiChecks(
      [
        { name: "a", status: "in_progress", conclusion: null },
        { name: "b", status: "completed", conclusion: "failure" },
      ],
      [{ context: "c", state: "error" }],
    );
    const verdict = evaluateCiChecks(checks, strict);
    expect(verdict).toMatchObject({ ready: false, problem: "failing" });
    expect(verdict.ready ? "" : verdict.message).toBe("CI checks failed: b, c.");
    expect(evaluateCiChecks([{ name: "a", state: "pending" }], { requireSuccess: false })).toEqual(
      expect.objectContaining({ ready: false, problem: "pending" }),
    );
  });

  test("neutral checks never pass or block", () => {
    expect(evaluateCiChecks([{ name: "n", state: "neutral" }], strict)).toMatchObject({
      ready: false,
      problem: "no-passing",
    });
    expect(
      evaluateCiChecks(
        [
          { name: "n", state: "neutral" },
          { name: "s", state: "success" },
        ],
        strict,
      ),
    ).toEqual({ ready: true });
  });
});

describe("ciChecksFromRollup (token without Checks permission)", () => {
  const status = (state: "success" | "failing" | "pending") => ({ name: "ci/status", state });

  test("no checks at all stays empty", () => {
    expect(ciChecksFromRollup([], { state: null, total: 0 })).toEqual([]);
  });

  test("hidden check runs take the rollup state", () => {
    for (const [state, expected] of [
      ["SUCCESS", "success"],
      ["PENDING", "pending"],
      ["EXPECTED", "pending"],
      ["FAILURE", "failing"],
      ["ERROR", "failing"],
      ["SOMETHING_NEW", "failing"],
    ] as const) {
      expect(ciChecksFromRollup([], { state, total: 2 })).toEqual([
        { name: hiddenCheckRunsName(2), state: expected },
      ]);
    }
  });

  test("statuses alone add no hidden entry", () => {
    expect(ciChecksFromRollup([status("success")], { state: "SUCCESS", total: 1 })).toEqual([
      status("success"),
    ]);
  });

  test("a failing status that explains the rollup leaves the runs neutral", () => {
    const checks = ciChecksFromRollup([status("failing")], { state: "FAILURE", total: 3 });
    expect(checks).toEqual([status("failing"), { name: hiddenCheckRunsName(2), state: "neutral" }]);
    expect(evaluateCiChecks(checks, { requireSuccess: false })).toMatchObject({
      problem: "failing",
      message: "CI check failed: ci/status.",
    });
  });

  test("a failing rollup with passing statuses blames the hidden runs", () => {
    const checks = ciChecksFromRollup([status("success")], { state: "FAILURE", total: 2 });
    expect(evaluateCiChecks(checks, { requireSuccess: false })).toMatchObject({
      problem: "failing",
      message: `CI check failed: ${hiddenCheckRunsName(1)}.`,
    });
  });
});

describe("auto-merge CI-wait status comment", () => {
  test("says it is waiting and how to opt out", () => {
    const body = buildAutoMergeStatusComment({
      kind: "left-open",
      headSha: "a".repeat(40),
      reason: { kind: "ci-checks", problem: "no-checks", detail: NO_CI_CHECKS_MESSAGE },
    });
    expect(body).toContain("waiting for CI checks");
    expect(body).toContain(NO_CI_CHECKS_MESSAGE);
    expect(body).toContain("auto_merge_require_checks = true");
    expect(body).not.toContain("left open for human review");
  });
});

describe("auto_merge_require_checks config", () => {
  const config = (workspace: string, repo = "") =>
    parseWorkspaceConfig(`
[workspace]
auto_merge = true
${workspace}

[defaults]
tracker = "markdown"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"
${repo}
`);
  const effective = (workspace: string, repo = "") => {
    const parsed = config(workspace, repo);
    return autoMergeRequireChecksFor(parsed.workspace.autoMerge, parsed.repos[0]!);
  };

  test("defaults to false", () => {
    expect(effective("")).toBe(false);
  });

  test("workspace value applies; a repo value overrides it both ways", () => {
    expect(effective("auto_merge_require_checks = true")).toBe(true);
    expect(effective("auto_merge_require_checks = true", "auto_merge_require_checks = false")).toBe(
      false,
    );
    expect(effective("auto_merge_require_checks = false", "auto_merge_require_checks = true")).toBe(
      true,
    );
  });

  test("rejects a non-boolean", () => {
    expect(() => config('auto_merge_require_checks = "yes"')).toThrow(/auto_merge_require_checks/);
  });

  test("turning it on changes the policy fingerprint; the default hashes as before", () => {
    const fingerprint = (workspace: string, repo = "") =>
      fleetAutoMergePolicyFingerprint(config(workspace, repo), "acme/backend", "/ws");
    const base = fingerprint("");
    expect(fingerprint("auto_merge_require_checks = false")).toBe(base);
    expect(fingerprint("auto_merge_require_checks = true")).not.toBe(base);
    expect(fingerprint("", "auto_merge_require_checks = true")).not.toBe(base);
  });
});

describe("--require-checks", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("round-trips through the worker's CLI args", () => {
    const policy = {
      safePaths: [],
      denyPaths: [],
      review: true,
      method: "squash" as const,
      requireChecks: true,
    };
    const args = autoMergeCliArgs(policy, "a".repeat(40));
    expect(args).toContain("--require-checks");
    expect(
      parseAutoMergeArgs(["https://github.com/o/r/pull/1", ...args], gate)?.policy,
    ).toMatchObject({ requireChecks: true });
    expect(autoMergeCliArgs({ ...policy, requireChecks: false }, "a".repeat(40))).not.toContain(
      "--require-checks",
    );
    expect(parseAutoMergeArgs(["https://github.com/o/r/pull/1"], gate)?.policy.requireChecks).toBe(
      undefined,
    );
  });

  test("requireApproval round-trips through the worker's CLI args", () => {
    const policy = {
      safePaths: [],
      denyPaths: [],
      review: true,
      method: "squash" as const,
      requireApproval: true,
    };
    const args = autoMergeCliArgs(policy, "a".repeat(40));
    expect(args).toContain("--require-approval");
    expect(
      parseAutoMergeArgs(["https://github.com/o/r/pull/1", ...args], gate)?.policy,
    ).toMatchObject({ requireApproval: true });
    expect(autoMergeCliArgs({ ...policy, requireApproval: false }, "a".repeat(40))).not.toContain(
      "--require-approval",
    );
  });

  test("the CI wait already posted round-trips through the worker's CLI args", () => {
    const policy = { safePaths: [], denyPaths: [], review: true, method: "squash" as const };
    const message = "Ready gate: CI check failed: unit tests, --lint.";
    const args = autoMergeCliArgs(policy, "a".repeat(40), { ciWaitPosted: message });
    expect(parseAutoMergeArgs(["https://github.com/o/r/pull/1", ...args], gate)?.ciWaitPosted).toBe(
      message,
    );
    expect(autoMergeCliArgs(policy, "a".repeat(40)).join(" ")).not.toContain("--ci-wait-posted");
  });

  test("the subprocess result carries the CI-wait flag", () => {
    expect(
      parseAutoMergeResultLine(
        JSON.stringify({ outcome: "waiting", message: "m", reviewed: false, ciWait: true }),
      ),
    ).toEqual({ outcome: "waiting", message: "m", reviewed: false, ciWait: true });
  });

  test("the subprocess result carries a reviewer wait", () => {
    const record = {
      outcome: "waiting" as const,
      message: "m",
      reviewed: false,
      approvalWait: true,
    };
    expect(parseAutoMergeResultLine(JSON.stringify(record))).toEqual(record);
  });

  test("the subprocess result carries the CI problem; an unknown one is dropped", () => {
    const record = {
      outcome: "waiting" as const,
      message: "m",
      reviewed: false,
      ciWait: true,
      ciWaitProblem: "pending" as const,
    };
    expect(parseAutoMergeResultLine(JSON.stringify(record))).toEqual(record);
    expect(parseAutoMergeResultLine(JSON.stringify({ ...record, ciWaitProblem: "bogus" }))).toEqual(
      { outcome: "waiting", message: "m", reviewed: false, ciWait: true },
    );
  });

  test("the subprocess result carries the unread-checks flag", () => {
    const record = {
      outcome: "waiting" as const,
      message: "m",
      reviewed: false,
      ciChecksUnread: true,
    };
    expect(parseAutoMergeResultLine(JSON.stringify(record))).toEqual(record);
  });
});

describe("commit check reads", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const respond = (handler: (url: string) => unknown): string[] => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      urls.push(String(url));
      return new Response(JSON.stringify(handler(String(url))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return urls;
  };
  const run = (id: number) => ({ id, name: `c${id}`, status: "completed", conclusion: "success" });
  const client = () => new GitHubReviewsClient({ token: "test-token" });

  test("reads the combined CI state over GraphQL", async () => {
    const urls = respond(() => ({
      data: {
        repository: {
          object: { statusCheckRollup: { state: "PENDING", contexts: { totalCount: 3 } } },
        },
      },
    }));
    expect(await checkRollupForRef(client(), "o", "r", "abc")).toEqual({
      state: "PENDING",
      total: 3,
    });
    expect(urls).toEqual(["https://api.github.com/graphql"]);
  });

  test("a commit with no checks has a null rollup", async () => {
    respond(() => ({ data: { repository: { object: { statusCheckRollup: null } } } }));
    expect(await checkRollupForRef(client(), "o", "r", "abc")).toEqual({ state: null, total: 0 });
  });

  test("an unknown commit throws instead of reading as no checks", async () => {
    respond(() => ({ data: { repository: { object: null } }, errors: [{ message: "nope" }] }));
    await expect(checkRollupForRef(client(), "o", "r", "abc")).rejects.toThrow("nope");
  });

  test("a refused rollup (null next to an error) throws instead of reading as no checks", async () => {
    respond(() => ({
      data: { repository: { object: { statusCheckRollup: null } } },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
    }));
    await expect(checkRollupForRef(client(), "o", "r", "abc")).rejects.toThrow(
      "Resource not accessible",
    );
  });

  test("an unknown commit with no error still throws", async () => {
    respond(() => ({ data: { repository: { object: null } } }));
    await expect(checkRollupForRef(client(), "o", "r", "abc")).rejects.toThrow("no CI state");
  });

  test("reads every page of check runs", async () => {
    const urls = respond((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const start = (page - 1) * 100;
      const count = Math.min(100, 150 - start);
      return {
        total_count: 150,
        check_runs: Array.from({ length: count }, (_, i) => run(start + i)),
      };
    });
    const result = await listCheckRunsForRef(client(), "o", "r", "sha");
    expect(result.checkRuns).toHaveLength(150);
    expect(result.complete).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(
      "/repos/o/r/commits/sha/check-runs?filter=latest&per_page=100&page=1",
    );
  });

  test("a list shorter than total_count is reported incomplete", async () => {
    respond(() => ({ total_count: 5, check_runs: [run(1)] }));
    expect((await listCheckRunsForRef(client(), "o", "r", "sha")).complete).toBe(false);
    respond(() => ({
      state: "success",
      total_count: 3,
      statuses: [{ id: 1, state: "success", context: "a" }],
    }));
    expect((await listLatestCommitStatuses(client(), "o", "r", "sha")).complete).toBe(false);
  });

  test("reads commit statuses page by page", async () => {
    const urls = respond(() => ({
      state: "success",
      total_count: 1,
      statuses: [{ id: 1, state: "success", context: "jenkins" }],
    }));
    const result = await listLatestCommitStatuses(client(), "o", "r", "sha");
    expect(result).toEqual({
      statuses: [{ id: 1, state: "success", context: "jenkins" }],
      complete: true,
    });
    expect(urls[0]).toContain("/repos/o/r/commits/sha/status?per_page=100&page=1");
  });
});
