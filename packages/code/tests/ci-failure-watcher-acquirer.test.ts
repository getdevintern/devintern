import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { CiFailureWatcherAcquirer, truncateCiLogs } from "../src/lib/ci-failure-watcher-acquirer";
import type {
  CiConditionalResult,
  CiFailureWatcherGitHub,
  PolledCiPr,
  WatchedStatusState,
  WatchedWorkflowRun,
} from "../src/lib/ci-failure-watcher-acquirer";
import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState } from "../src/lib/worker-state";

describe("truncateCiLogs", () => {
  test("returns null for empty input", () => {
    expect(truncateCiLogs(null)).toBeNull();
    expect(truncateCiLogs("")).toBeNull();
    expect(truncateCiLogs("   \n  \n")).toBeNull();
  });

  test("strips ANSI escape codes", () => {
    const raw = "\x1b[31mError: build failed\x1b[0m\nplain line";
    const excerpt = truncateCiLogs(raw)!;
    expect(excerpt).not.toContain("[31m");
    expect(excerpt).toContain("Error: build failed");
  });

  test("keeps lines around error markers with context", () => {
    // 120 filler lines + one error line near the top + more filler.
    const lines = Array.from({ length: 200 }, (_, i) => `pad-${String(i).padStart(4, "0")}`);
    lines[10] = "ERROR: cannot find module";
    const raw = lines.join("\n");
    const excerpt = truncateCiLogs(raw, { contextLines: 2 })!;
    expect(excerpt).toContain("ERROR: cannot find module");
    expect(excerpt).toContain("pad-0008"); // context before the error
    expect(excerpt).toContain("pad-0012"); // context after the error
    expect(excerpt).toContain("pad-0199"); // tail window always included
    // Far-away noise outside error context and tail is dropped.
    expect(excerpt).not.toContain("pad-0050");
    expect(excerpt).not.toContain("pad-0100");
  });

  test("caps output at maxChars keeping the tail", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `filler ${i}`).join("\n");
    const excerpt = truncateCiLogs(raw, { maxChars: 200 })!;
    expect(excerpt.length).toBeLessThanOrEqual(210);
    expect(excerpt.startsWith("...")).toBe(true);
  });

  test("keeps only the last maxLines lines", () => {
    const raw = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const excerpt = truncateCiLogs(raw, { maxLines: 50 })!;
    expect(excerpt).not.toContain("line 0\n");
    expect(excerpt).not.toContain("line 100");
    expect(excerpt).toContain("line 299");
  });
});

describe("CiFailureWatcherAcquirer", () => {
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `ci-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  interface FakeGitHubState {
    prState: string;
    headSha?: string;
    headRepoFullName?: string;
    prEtagHit?: boolean;
    workflowRuns: WatchedWorkflowRun[];
    actionsEtagHit?: boolean;
    status?: WatchedStatusState;
    statusEtagHit?: boolean;
    jobLogs?: string | null;
    seenPrEtag?: string;
    seenActionsEtag?: string;
    seenStatusEtag?: string;
    prCalls?: number;
    actionsCalls?: number;
    statusCalls?: number;
  }

  function makeGithub(gh: FakeGitHubState): CiFailureWatcherGitHub {
    return {
      async fetchPr(_repo, _n, etag): Promise<CiConditionalResult<PolledCiPr>> {
        gh.prCalls = (gh.prCalls ?? 0) + 1;
        gh.seenPrEtag = etag;
        if (gh.prEtagHit) {
          return { data: null, etag, notModified: true };
        }
        return {
          data: {
            state: gh.prState,
            head: gh.headSha
              ? {
                  sha: gh.headSha,
                  repo: gh.headRepoFullName ? { full_name: gh.headRepoFullName } : null,
                }
              : undefined,
          },
          etag: 'W/"pr-1"',
          notModified: false,
        };
      },
      async fetchWorkflowRuns(
        _repo,
        _sha,
        etag,
      ): Promise<CiConditionalResult<WatchedWorkflowRun[]>> {
        gh.actionsCalls = (gh.actionsCalls ?? 0) + 1;
        gh.seenActionsEtag = etag;
        if (gh.actionsEtagHit) {
          return { data: null, etag, notModified: true };
        }
        return { data: gh.workflowRuns, etag: 'W/"actions-1"', notModified: false };
      },
      async fetchCommitStatus(_repo, _sha, etag): Promise<CiConditionalResult<WatchedStatusState>> {
        gh.statusCalls = (gh.statusCalls ?? 0) + 1;
        gh.seenStatusEtag = etag;
        if (gh.statusEtagHit) {
          return { data: null, etag, notModified: true };
        }
        return {
          data: gh.status ?? { state: "pending", total_count: 0, statuses: [] },
          etag: 'W/"status-1"',
          notModified: false,
        };
      },
      async fetchFailingJobLogs() {
        return gh.jobLogs ?? null;
      },
      async postComment() {},
    };
  }

  function makeAcquirer(
    gh: FakeGitHubState,
    overrides: {
      maxAttempts?: number;
      fixResults?: boolean[];
      enabled?: () => boolean;
      now?: () => number;
    } = {},
  ) {
    const fixed: string[] = [];
    const comments: string[] = [];
    const base = makeGithub(gh);
    const github: CiFailureWatcherGitHub = {
      ...base,
      postComment: async (_repo, _n, body) => {
        comments.push(body);
      },
    };
    const options: ConstructorParameters<typeof CiFailureWatcherAcquirer>[0] = {
      intervalSeconds: 60,
      workerState,
      queue,
      github,
      fixPr: async (repo, n) => {
        fixed.push(`${repo}#${n}`);
        return overrides.fixResults?.shift() ?? true;
      },
      enabled: overrides.enabled,
      now: overrides.now,
      verbose: false,
    };
    if (overrides.maxAttempts !== undefined) {
      options.maxAttempts = overrides.maxAttempts;
    }
    const acquirer = new CiFailureWatcherAcquirer(options);
    return { acquirer, fixed, comments };
  }

  const sha1 = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  const sha2 = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

  function failingRun(id: number): WatchedWorkflowRun {
    return { id, name: `workflow-${id}`, status: "completed", conclusion: "failure" };
  }

  test("a failing completed Actions run triggers exactly one fix attempt", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [
        failingRun(101),
        { id: 102, name: "lint", status: "completed", conclusion: "success" },
      ],
    };
    const { acquirer, fixed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(fixed).toEqual(["acme/widgets#42"]);

    // Same failure next tick is deduped.
    await acquirer.tick();
    expect(fixed).toEqual(["acme/widgets#42"]);
  });

  test("pending and non-failure conclusions never trigger", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [
        { id: 201, name: "build", status: "in_progress", conclusion: null },
        { id: 202, name: "build", status: "completed", conclusion: "success" },
        { id: 203, name: "skipped-job", status: "completed", conclusion: "skipped" },
        { id: 204, name: "cancelled-job", status: "completed", conclusion: "cancelled" },
      ],
    };
    const { acquirer, fixed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(fixed).toEqual([]);
  });

  test("provider hooks reuse retry and dedupe semantics in an isolated namespace", async () => {
    const key = "https://gitlab.example:acme/widgets";
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [
        {
          ...failingRun(201),
          externalId: "gitlab:https://gitlab.example:job:42:aaaa:201",
        },
      ],
    };
    const fixed: string[] = [];
    const acquirer = new CiFailureWatcherAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: makeGithub(gh),
      watchedChanges: () => [{ repo: key, prNumber: 17 }],
      namespace: "gitlab",
      fixPr: async (repo, n, _path, expectedHead) => {
        fixed.push(`${repo}!${n}@${expectedHead}`);
        return true;
      },
    });

    await acquirer.tick();
    await acquirer.tick();

    expect(fixed).toEqual([`${key}!17@${sha1}`]);
    expect(queue.hasProcessed("gitlab:ci", "gitlab:https://gitlab.example:job:42:aaaa:201")).toBe(
      true,
    );
  });

  test("dedupe survives worker restarts (new instance, shared queue)", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [failingRun(301)],
    };
    const first = makeAcquirer(gh);
    await first.acquirer.tick();
    expect(first.fixed).toEqual(["acme/widgets#42"]);

    // A fresh acquirer over the same DB (restart) must not re-trigger.
    const second = makeAcquirer(gh);
    await second.acquirer.tick();
    expect(second.fixed).toEqual([]);
  });

  test("a failure on a NEW head SHA triggers again", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [failingRun(401)],
    };
    const { acquirer, fixed } = makeAcquirer(gh);
    await acquirer.tick();

    gh.headSha = sha2;
    gh.workflowRuns = [failingRun(402)];
    await acquirer.tick();
    expect(fixed).toEqual(["acme/widgets#42", "acme/widgets#42"]);
  });

  test("commit status failures trigger and dedupe per context", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [],
      status: {
        state: "failure",
        total_count: 2,
        statuses: [
          { id: 1, state: "failure", context: "ci/travis" },
          { id: 2, state: "success", context: "ci/coverage" },
        ],
      },
    };
    const { acquirer, fixed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(fixed).toEqual(["acme/widgets#42"]);

    await acquirer.tick();
    expect(fixed).toEqual(["acme/widgets#42"]);
  });

  test("a closed PR is unwatched without triggering fixes", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "closed",
      headSha: sha1,
      workflowRuns: [failingRun(501)],
    };
    const { acquirer, fixed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(fixed).toEqual([]);
    expect(workerState.listOpenAgentPrs()).toHaveLength(0);
  });

  test("fork PRs are skipped gracefully", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      headRepoFullName: "contributor/widgets-fork",
      workflowRuns: [failingRun(601)],
    };
    const { acquirer, fixed } = makeAcquirer(gh);

    await acquirer.tick();
    expect(fixed).toEqual([]);
  });

  test("ETags are stored and replayed on subsequent ticks", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [{ id: 701, name: "ok", status: "completed", conclusion: "success" }],
    };
    const { acquirer } = makeAcquirer(gh);

    await acquirer.tick();
    expect(gh.seenPrEtag).toBeUndefined();
    expect(gh.seenActionsEtag).toBeUndefined();

    gh.prEtagHit = true;
    gh.actionsEtagHit = true;
    await acquirer.tick();
    expect(gh.seenPrEtag).toBe('W/"pr-1"');
    expect(gh.seenActionsEtag).toBe('W/"actions-1"');
  });

  test("progressively backs off unchanged terminal-green PRs", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 0;
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [{ id: 710, name: "ok", status: "completed", conclusion: "success" }],
    };
    const { acquirer } = makeAcquirer(gh, { now: () => now });

    await acquirer.tick(); // Fresh observation stays on the fast cadence.
    gh.prEtagHit = true;
    gh.actionsEtagHit = true;
    gh.statusEtagHit = true;
    now = 60_000;
    await acquirer.tick(); // Unchanged green → wait 5 minutes.
    expect(gh.prCalls).toBe(2);

    now = 359_999;
    await acquirer.tick();
    expect(gh.prCalls).toBe(2);
    now = 360_000;
    await acquirer.tick(); // Still green → wait 15 minutes.
    expect(gh.prCalls).toBe(3);

    now = 1_259_999;
    await acquirer.tick();
    expect(gh.prCalls).toBe(3);
    now = 1_260_000;
    await acquirer.tick(); // Still green → wait 30 minutes.
    expect(gh.prCalls).toBe(4);

    now = 3_059_999;
    await acquirer.tick();
    expect(gh.prCalls).toBe(4);
    now = 3_060_000;
    await acquirer.tick();
    expect(gh.prCalls).toBe(5);
    expect(gh.actionsCalls).toBe(5);
    expect(gh.statusCalls).toBe(5);
  });

  test("an observed CI change resets a green PR to the fast cadence", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 0;
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [{ id: 720, name: "ok", status: "completed", conclusion: "success" }],
    };
    const { acquirer } = makeAcquirer(gh, { now: () => now });

    await acquirer.tick();
    gh.prEtagHit = true;
    gh.actionsEtagHit = true;
    gh.statusEtagHit = true;
    now = 60_000;
    await acquirer.tick(); // Enter 5-minute backoff.

    now = 360_000;
    gh.actionsEtagHit = false;
    gh.workflowRuns = [{ id: 721, name: "rerun", status: "in_progress", conclusion: null }];
    await acquirer.tick(); // Change observed: leave backoff.
    expect(gh.prCalls).toBe(3);

    now = 420_000;
    await acquirer.tick();
    expect(gh.prCalls).toBe(4);
  });

  test("PRs with pending or no CI stay on the configured cadence", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    let now = 0;
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [],
    };
    const { acquirer } = makeAcquirer(gh, { now: () => now });

    await acquirer.tick();
    gh.prEtagHit = true;
    gh.actionsEtagHit = true;
    gh.statusEtagHit = true;
    now = 60_000;
    await acquirer.tick();
    now = 120_000;
    await acquirer.tick();

    expect(gh.prCalls).toBe(3);
    expect(gh.actionsCalls).toBe(3);
    expect(gh.statusCalls).toBe(3);
  });

  test("CI success resets the retry counter", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [failingRun(801)],
    };
    const { acquirer } = makeAcquirer(gh, { maxAttempts: 1 });

    await acquirer.tick(); // attempt 1 → budget exhausted
    expect(workerState.getCiFixState("acme/widgets", 42).consecutiveFailures).toBe(1);

    // The processed failure does not trigger another attempt or a premature
    // escalation while GitHub is still reporting the pre-push head.
    await acquirer.tick();
    expect(workerState.getCiFixState("acme/widgets", 42).escalatedSha).toBeUndefined();

    gh.workflowRuns = [{ id: 802, name: "build", status: "completed", conclusion: "success" }];
    await acquirer.tick(); // CI passed → reset
    const state = workerState.getCiFixState("acme/widgets", 42);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.escalatedSha).toBeUndefined();
  });

  test("does not reset the retry budget while another workflow is still running", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    workerState.setCiFixState("acme/widgets", 42, { consecutiveFailures: 2 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [
        { id: 810, name: "lint", status: "completed", conclusion: "success" },
        { id: 811, name: "tests", status: "in_progress", conclusion: null },
      ],
    };
    const { acquirer } = makeAcquirer(gh);
    await acquirer.tick();
    expect(workerState.getCiFixState("acme/widgets", 42).consecutiveFailures).toBe(2);
  });

  test("retries an invocation that made no push and then escalates", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [failingRun(820)],
    };
    const { acquirer, fixed, comments } = makeAcquirer(gh, {
      maxAttempts: 2,
      fixResults: [false, false],
    });
    await acquirer.tick();
    gh.prEtagHit = true;
    gh.actionsEtagHit = true;
    gh.statusEtagHit = true;
    await acquirer.tick();
    expect(fixed).toHaveLength(2);
    expect(comments).toHaveLength(1);
    expect(workerState.getCiFixState("acme/widgets", 42).escalatedSha).toBe(sha1);
  });

  test("a disabled watcher makes no GitHub requests", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [failingRun(830)],
    };
    const { acquirer, fixed } = makeAcquirer(gh, { enabled: () => false });
    await acquirer.tick();
    expect(fixed).toEqual([]);
    expect(gh.seenPrEtag).toBeUndefined();
  });

  test("exhausted budget escalates once and blocks until the head moves", async () => {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 42 });
    const gh: FakeGitHubState = {
      prState: "open",
      headSha: sha1,
      workflowRuns: [failingRun(901)],
    };
    const { acquirer, fixed, comments } = makeAcquirer(gh, { maxAttempts: 2 });

    await acquirer.tick(); // attempt 1
    expect(fixed).toHaveLength(1);
    await acquirer.tick(); // new failure at new SHA? No — dedupe; nothing happens

    gh.headSha = sha2;
    gh.workflowRuns = [failingRun(902)];
    await acquirer.tick(); // attempt 2 → exhausted
    expect(fixed).toHaveLength(2);

    gh.headSha = "cccc3333cccc3333cccc3333cccc3333cccc3333";
    gh.workflowRuns = [failingRun(903)];
    await acquirer.tick(); // budget exhausted → escalate, no fix
    expect(fixed).toHaveLength(2);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("stopped retrying");

    // Still blocked at the escalation head even for brand-new failures.
    gh.workflowRuns = [failingRun(904)];
    await acquirer.tick();
    expect(fixed).toHaveLength(2);
    expect(comments).toHaveLength(1); // escalation posted exactly once

    // A human push moves the head past the escalation point → unblocked.
    gh.headSha = "dddd4444dddd4444dddd4444dddd4444dddd4444";
    gh.workflowRuns = [failingRun(905)];
    await acquirer.tick();
    expect(fixed).toHaveLength(3);
  });
});
