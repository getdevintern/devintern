import { describe, expect, test } from "bun:test";
import { GitLabReviewPollingAcquirer } from "../src/lib/gitlab-review-polling-acquirer";
import type { GitLabPollingClient } from "../src/lib/gitlab-review-polling-acquirer";
import type { GitLabPollingSnapshot } from "../src/lib/gitlab-reviews";
import type { AgentPr } from "../src/lib/worker-state";

function registered(overrides: Partial<AgentPr> = {}): AgentPr {
  return {
    provider: "gitlab",
    instanceUrl: "https://gitlab.com",
    projectId: "42",
    projectPath: "acme/widgets",
    changeNumber: 17,
    webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
    repo: "acme/widgets",
    prNumber: 17,
    state: "open",
    createdAt: Date.parse("2026-09-09T00:00:00Z"),
    updatedAt: Date.parse("2026-09-09T00:00:00Z"),
    ...overrides,
  };
}

function snapshot(overrides: Partial<GitLabPollingSnapshot> = {}): GitLabPollingSnapshot {
  return {
    state: "opened",
    headSha: "abc123",
    webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
    assignedReviewerIds: [],
    feedback: [
      {
        discussionId: "discussion-1",
        noteId: 101,
        author: { id: 8, username: "maintainer", state: "active" },
        createdAt: "2026-09-09T01:00:00Z",
      },
    ],
    ...overrides,
  };
}

function harness(options: {
  rows?: AgentPr[];
  snapshot?: GitLabPollingSnapshot;
  access?: number | null;
  addressOutcome?: true | false | "deferred";
  now?: () => number;
  allowlist?: string[];
  fetchError?: Error;
}) {
  const rows = options.rows ?? [registered()];
  const processed = new Set<string>();
  const closed: string[] = [];
  let addressCalls = 0;
  let snapshotCalls = 0;
  let membershipCalls = 0;
  const client: GitLabPollingClient = {
    async getPollingSnapshot() {
      snapshotCalls++;
      if (options.fetchError) throw options.fetchError;
      return options.snapshot ?? snapshot();
    },
    async getMemberAccessLevel() {
      membershipCalls++;
      return options.access === undefined ? 30 : options.access;
    },
  };
  const acquirer = new GitLabReviewPollingAcquirer({
    intervalSeconds: 60,
    workerState: {
      listOpenAgentChangeRequests: () => rows,
      markAgentChangeRequestClosed: (identity) =>
        closed.push(`${identity.projectPath}!${identity.number}`),
    },
    queue: {
      hasProcessed: (_source, id) => processed.has(id),
      markProcessed: (_source, id) => {
        processed.add(id);
      },
    },
    clientFor: () => client,
    addressMr: async () => {
      addressCalls++;
      return options.addressOutcome ?? true;
    },
    reviewerAllowlist: options.allowlist,
    now: options.now,
  });
  return {
    acquirer,
    processed,
    closed,
    get addressCalls() {
      return addressCalls;
    },
    get snapshotCalls() {
      return snapshotCalls;
    },
    get membershipCalls() {
      return membershipCalls;
    },
  };
}

describe("GitLabReviewPollingAcquirer", () => {
  test("addresses new unresolved feedback from a Developer and deduplicates it", async () => {
    const run = harness({ access: 30 });
    await run.acquirer.tick();
    await run.acquirer.tick();
    expect(run.addressCalls).toBe(1);
    expect(run.processed.size).toBe(1);
    expect(run.membershipCalls).toBe(1);
  });

  test("assigned reviewers qualify without a membership lookup", async () => {
    const run = harness({ snapshot: snapshot({ assignedReviewerIds: [8] }), access: null });
    await run.acquirer.tick();
    expect(run.addressCalls).toBe(1);
    expect(run.membershipCalls).toBe(0);
  });

  test("fails closed for unknown or insufficient permissions and honors the allowlist", async () => {
    const unknown = harness({ access: null });
    await unknown.acquirer.tick();
    expect(unknown.addressCalls).toBe(0);

    const reporter = harness({ access: 20 });
    await reporter.acquirer.tick();
    expect(reporter.addressCalls).toBe(0);

    const denied = harness({ access: 40, allowlist: ["someone-else"] });
    await denied.acquirer.tick();
    expect(denied.addressCalls).toBe(0);
    expect(denied.membershipCalls).toBe(0);
  });

  test("ignores feedback predating registration", async () => {
    const run = harness({
      snapshot: snapshot({
        feedback: [
          {
            discussionId: "old",
            noteId: 100,
            author: { id: 8, username: "maintainer" },
            createdAt: "2026-09-08T23:59:59Z",
          },
        ],
      }),
    });
    await run.acquirer.tick();
    expect(run.addressCalls).toBe(0);
  });

  test("reconciles closed and inaccessible MRs", async () => {
    const merged = harness({ snapshot: snapshot({ state: "merged", feedback: [] }) });
    await merged.acquirer.tick();
    expect(merged.closed).toEqual(["acme/widgets!17"]);

    const gone = harness({ fetchError: new Error("GitLab API error (404): Not found") });
    await gone.acquirer.tick();
    expect(gone.closed).toEqual(["acme/widgets!17"]);
  });

  test("retries failed addressing with bounded backoff and marks only success", async () => {
    let now = 1_000_000;
    const run = harness({ addressOutcome: false, now: () => now });
    await run.acquirer.tick();
    await run.acquirer.tick();
    expect(run.addressCalls).toBe(1);
    expect(run.processed.size).toBe(0);

    now += 30_000;
    await run.acquirer.tick();
    expect(run.addressCalls).toBe(2);
  });

  test("polls only registered GitLab rows allowed for this workspace", async () => {
    let snapshotCalls = 0;
    const filtered = new GitLabReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState: {
        listOpenAgentChangeRequests: () => [
          registered({ provider: "github" }),
          registered({ projectPath: "other/repo", projectId: "99" }),
        ],
        markAgentChangeRequestClosed: () => {},
      },
      queue: { hasProcessed: () => false, markProcessed: () => {} },
      clientFor: () => ({
        getPollingSnapshot: async () => {
          snapshotCalls++;
          return snapshot();
        },
        getMemberAccessLevel: async () => 30,
      }),
      addressMr: async () => true,
      allowed: (mr) => mr.projectPath === "acme/widgets",
    });
    await filtered.tick();
    expect(snapshotCalls).toBe(0);
  });
});
