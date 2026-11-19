import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { CiFailureWatcherAcquirer } from "../src/lib/acquirers/ci-failure-watcher";
import { GitLabReviewPollingAcquirer } from "../src/lib/acquirers/gitlab-review-polling";
import { createGitLabCiProvider } from "../src/lib/code-host/gitlab/ci-provider";
import type { GitLabPollingSnapshot } from "../src/lib/code-host/gitlab/reviews";
import { normalizeGitLabWebhook } from "../src/lib/code-host/gitlab/webhook";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";
import { processGitLabWithPersistence } from "../src/lib/webhook/gitlab-webhook";
import { gitLabCiMarkClosed } from "../src/lib/workspace/gitlab-fleet-events";

const identity = {
  provider: "gitlab" as const,
  instanceUrl: "https://gitlab.com",
  projectId: "42",
  projectPath: "acme/widgets",
  number: 17,
  webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
};

let dir: string;
let dbPath: string;
let workerState: WorkerState;
let previousDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gitlab-merged-close-"));
  dbPath = join(dir, "queue.db");
  workerState = new WorkerState(dbPath);
  workerState.recordAgentChangeRequest(identity);
  previousDb = process.env.WEBHOOK_QUEUE_DB;
  process.env.WEBHOOK_QUEUE_DB = dbPath;
});

afterEach(() => {
  if (previousDb === undefined) delete process.env.WEBHOOK_QUEUE_DB;
  else process.env.WEBHOOK_QUEUE_DB = previousDb;
  workerState.close();
  rmSync(dir, { recursive: true, force: true });
});

function mergedNumbers(): number[] {
  return workerState.listMergedAgentChangeRequests(10).map((mr) => mr.changeNumber);
}

describe("GitLab close paths record merges for the dashboard Merged tab", () => {
  for (const [state, expected] of [
    ["merged", [17]],
    ["closed", []],
  ] as const) {
    test(`webhook lifecycle with state ${state}`, async () => {
      const event = normalizeGitLabWebhook("Merge Request Hook", {
        project: { id: 42, path_with_namespace: "acme/widgets" },
        object_attributes: { iid: 17, state },
      });
      expect(event?.kind).toBe("lifecycle");
      const [target] = workerState.listOpenAgentChangeRequests();
      await processGitLabWithPersistence(undefined, { event: event!, target: target! });

      expect(workerState.listOpenAgentChangeRequests()).toHaveLength(0);
      expect(mergedNumbers()).toEqual([...expected]);
    });

    test(`review poller snapshot with state ${state}`, async () => {
      const snapshot: GitLabPollingSnapshot = {
        state,
        headSha: "abc123",
        webUrl: identity.webUrl,
        assignedReviewerIds: [],
        sourceBranch: "feature/widgets",
        targetBranch: "main",
        baseSha: "base123",
        mergeability: "mergeable",
        feedback: [],
      };
      const acquirer = new GitLabReviewPollingAcquirer({
        intervalSeconds: 60,
        workerState,
        queue: { hasProcessed: () => false, markProcessed: () => {} },
        clientFor: () => ({
          getPollingSnapshot: async () => snapshot,
          getMemberAccessLevel: async () => 30,
        }),
        addressMr: async () => true,
      });
      await acquirer.tick();

      expect(workerState.listOpenAgentChangeRequests()).toHaveLength(0);
      expect(mergedNumbers()).toEqual([...expected]);
    });

    test(`fleet CI watcher close with state ${state}`, async () => {
      const queue = new WebhookQueue({ dbPath: join(dir, "ci-queue.db") });
      try {
        const rows = new Map(
          workerState.listOpenAgentChangeRequests().map((mr) => [mr.changeNumber, mr]),
        );
        const key = `${identity.instanceUrl}:${identity.projectPath}`;
        const ciRow = (k: string, n: number) => (k === key ? rows.get(n) : undefined);
        const acquirer = new CiFailureWatcherAcquirer({
          intervalSeconds: 60,
          workerState,
          queue,
          namespace: "gitlab",
          watchedChanges: () => [{ repo: key, prNumber: identity.number }],
          markClosed: gitLabCiMarkClosed(workerState, ciRow),
          provider: createGitLabCiProvider((_k, n) => ({
            mr: rows.get(n ?? identity.number)!,
            client: {
              getChangeRequest: async () => ({
                number: identity.number,
                title: "Widgets",
                state,
                head: { ref: "feature/widgets", sha: "abc123" },
                base: { ref: "main", sha: "base123" },
                mergeability: "mergeable",
                webUrl: identity.webUrl,
              }),
              getCiSnapshot: async () => {
                throw new Error("terminal MR must not fetch CI");
              },
              getJobTraces: async () => null,
              postMergeRequestNote: async () => {},
            },
          })),
          fixPr: async () => true,
        });
        await acquirer.tick();
      } finally {
        queue.close();
      }

      expect(workerState.listOpenAgentChangeRequests()).toHaveLength(0);
      expect(mergedNumbers()).toEqual([...expected]);
    });
  }
});
