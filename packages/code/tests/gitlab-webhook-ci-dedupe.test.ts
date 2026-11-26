/**
 * A branch pipeline and an MR pipeline for one push each send a failed
 * Pipeline Hook with a different pipeline id. Both match the registered MR,
 * but the repair reads the whole CI snapshot for the head SHA, so only one
 * CI-repair run may start for the same failures.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const realWatcher = { ...(await import("../src/lib/acquirers/ci-failure-watcher")) };
const realReviews = { ...(await import("../src/lib/code-host/gitlab/reviews")) };

const HEAD = "a".repeat(40);
let failures = [{ externalId: "job:42:sha:1", name: "unit", conclusion: "failed", jobId: 1 }];
let fixResult: boolean | "deferred" = true;
const fixRuns: string[] = [];

mock.module("../src/lib/acquirers/ci-failure-watcher", () => ({
  ...realWatcher,
  runCiFixViaCli: async (
    _repo: string,
    _pr: number,
    _path: string,
    opts: { expectedHeadSha?: string },
  ) => {
    fixRuns.push(opts.expectedHeadSha ?? "");
    return fixResult;
  },
}));

mock.module("../src/lib/code-host/gitlab/reviews", () => ({
  ...realReviews,
  GitLabReviewsClient: class {
    async getChangeRequest() {
      return { state: "opened", head: { sha: HEAD, ref: "feature/a" }, base: { sha: "b" } };
    }
    async getCiSnapshot() {
      return { state: "failure", failures, jobIds: failures.map((failure) => failure.jobId) };
    }
    async getJobTraces() {
      return "trace";
    }
  },
}));

const { normalizeGitLabWebhook } = await import("../src/lib/code-host/gitlab/webhook");
const { WebhookQueue } = await import("../src/lib/state/webhook-queue");
const { WorkerState } = await import("../src/lib/state/worker-state");
const { processGitLabWithPersistence } = await import("../src/lib/webhook/gitlab-webhook");
const { runtime } = await import("../src/lib/webhook/runtime");

afterAll(() => {
  mock.module("../src/lib/acquirers/ci-failure-watcher", () => ({ ...realWatcher }));
  mock.module("../src/lib/code-host/gitlab/reviews", () => ({ ...realReviews }));
});

const ENV_KEYS = [
  "DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST",
  "GITLAB_CODE_HOST_TOKEN",
  "WEBHOOK_QUEUE_DB",
];

describe("GitLab webhook CI repair dedupe", () => {
  let dir: string;
  let workerState: InstanceType<typeof WorkerState>;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitlab-ci-dedupe-"));
    const dbPath = join(dir, "queue.db");
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST = "true";
    process.env.GITLAB_CODE_HOST_TOKEN = "test-token";
    process.env.WEBHOOK_QUEUE_DB = dbPath;
    workerState = new WorkerState(dbPath);
    workerState.recordAgentChangeRequest(
      {
        provider: "gitlab",
        instanceUrl: "https://gitlab.com",
        projectId: "42",
        projectPath: "acme/widgets",
        number: 7,
        webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/7",
      },
      { branch: "feature/a" },
    );
    runtime.queue = new WebhookQueue({ dbPath });
    fixRuns.length = 0;
    fixResult = true;
    failures = [{ externalId: "job:42:sha:1", name: "unit", conclusion: "failed", jobId: 1 }];
  });

  afterEach(() => {
    runtime.queue?.close();
    runtime.queue = null;
    workerState.close();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function failedPipeline(pipelineId: number, mergeRequestIid?: number) {
    const event = normalizeGitLabWebhook("Pipeline Hook", {
      project: { id: 42, path_with_namespace: "acme/widgets" },
      object_attributes: {
        id: pipelineId,
        iid: pipelineId,
        status: "failed",
        ref: "feature/a",
        sha: HEAD,
      },
      ...(mergeRequestIid ? { merge_request: { iid: mergeRequestIid } } : {}),
    });
    const [target] = workerState.listOpenAgentChangeRequests();
    return { event: event!, target: target! };
  }

  test("branch and MR pipelines for the same SHA start one repair run", async () => {
    const branch = failedPipeline(101);
    const mr = failedPipeline(102, 7);
    expect(branch.event.failure?.externalId).not.toBe(mr.event.failure?.externalId);

    await processGitLabWithPersistence(undefined, branch);
    await processGitLabWithPersistence(undefined, mr);

    expect(fixRuns).toEqual([HEAD]);
  });

  test("the other pipeline's copy of a failure, seen later, does not rerun repair", async () => {
    // Branch pipeline's unit job fails while the MR pipeline is still running.
    await processGitLabWithPersistence(undefined, failedPipeline(101));
    // MR pipeline's own unit job (different job id) fails later; the live
    // snapshot now holds both failures.
    failures = [
      ...failures,
      { externalId: "job:42:sha:9", name: "unit", conclusion: "failed", jobId: 9 },
    ];
    await processGitLabWithPersistence(undefined, failedPipeline(102, 7));

    expect(fixRuns).toEqual([HEAD]);
  });

  test("a new failure at the same SHA still runs repair", async () => {
    await processGitLabWithPersistence(undefined, failedPipeline(101));
    failures = [
      ...failures,
      { externalId: "job:42:sha:2", name: "lint", conclusion: "failed", jobId: 2 },
    ];
    await processGitLabWithPersistence(undefined, failedPipeline(102, 7));

    expect(fixRuns).toEqual([HEAD, HEAD]);
  });

  test("a failed repair stays retryable by the next delivery", async () => {
    fixResult = false;
    await expect(processGitLabWithPersistence(undefined, failedPipeline(101))).rejects.toThrow(
      "GitLab CI repair did not complete",
    );
    fixResult = true;
    await processGitLabWithPersistence(undefined, failedPipeline(102, 7));

    expect(fixRuns).toEqual([HEAD, HEAD]);
  });

  test("a retried job that fails again at the same SHA reruns repair once", async () => {
    // First repair exits 0 without pushing (agent judged the failure flaky).
    await processGitLabWithPersistence(undefined, failedPipeline(101));
    // User clicks Retry: GitLab replaces job 1 with job 3, which fails too.
    failures = [{ externalId: "job:42:sha:3", name: "unit", conclusion: "failed", jobId: 3 }];
    await processGitLabWithPersistence(undefined, failedPipeline(101));
    // A duplicate delivery for the same retried job does not run again.
    await processGitLabWithPersistence(undefined, failedPipeline(101));

    expect(fixRuns).toEqual([HEAD, HEAD]);
  });

  test("a delivery whose repair key is still in flight does not start a second repair", async () => {
    const { CI_REPAIR_SOURCE, ciRepairKey } = await import("../src/lib/webhook/gitlab-webhook");
    const key = ciRepairKey("https://gitlab.com:acme/widgets!7", HEAD, failures);
    expect(runtime.queue!.beginDelivery(CI_REPAIR_SOURCE, key)).toBe("started");
    let settled: string | undefined;
    await expect(
      processGitLabWithPersistence(undefined, failedPipeline(101), (outcome) => {
        settled = outcome;
      }),
    ).rejects.toThrow("GitLab CI repair already in progress");

    expect(settled).toBe("transient");
    expect(fixRuns).toEqual([]);
  });
});
