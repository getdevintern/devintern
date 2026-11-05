/**
 * A GitHub 503 can survive `fetchWithRetry` and escape into the review polling
 * loop. It is expected upstream noise — the next tick retries it — so polling
 * must warn without reporting it as a fresh Sentry issue. Non-transient API
 * failures must keep their existing capture path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realUtils = { ...(await import("@devintern/utils")) };
const captures: Array<{ error: unknown; context?: Record<string, unknown> }> = [];

mock.module("@devintern/utils", () => ({
  ...realUtils,
  captureError: (error: unknown, context?: Record<string, unknown>) => {
    captures.push({ error, context });
  },
}));

const { ReviewPollingAcquirer } = await import("../src/lib/acquirers/review-polling");
const { WebhookQueue } = await import("../src/lib/state/webhook-queue");
const { WorkerState } = await import("../src/lib/state/worker-state");

afterAll(() => {
  mock.module("@devintern/utils", () => ({ ...realUtils }));
});

describe("ReviewPollingAcquirer transient GitHub failures", () => {
  let dbPath: string;
  let workerState: InstanceType<typeof WorkerState>;
  let queue: InstanceType<typeof WebhookQueue>;
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    captures.length = 0;
    warnings = [];
    dbPath = join(tmpdir(), `rp-transient-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    workerState.close();
    queue.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function acquirerThrowing(error: Error) {
    workerState.recordAgentPr({ repo: "acme/widgets", prNumber: 7 });
    return new ReviewPollingAcquirer({
      intervalSeconds: 60,
      workerState,
      queue,
      github: {
        async fetchPr() {
          throw error;
        },
        async fetchReviews() {
          throw new Error("must not be reached");
        },
        async fetchReviewCommentsSince() {
          throw new Error("must not be reached");
        },
      },
      addressPr: async () => {
        throw new Error("must not be addressed");
      },
    });
  }

  test("a 503 that survives client retries warns but is not captured", async () => {
    const acquirer = acquirerThrowing(new Error("GitHub API error (503): Unknown error"));

    await acquirer.tick();

    expect(captures).toHaveLength(0);
    expect(warnings.some((line) => line.includes("GitHub API error (503)"))).toBe(true);
    // Reconciliation could not reach GitHub, so the PR stays watched.
    expect(workerState.listOpenAgentPrs()).toHaveLength(1);
  });

  test("rate limits are transient and are not captured either", async () => {
    const acquirer = acquirerThrowing(new Error("GitHub API error (429): API rate limit exceeded"));

    await acquirer.tick();

    expect(captures).toHaveLength(0);
  });

  test("non-transient API failures still capture with poll context", async () => {
    const acquirer = acquirerThrowing(new Error("GitHub API error (422): Validation Failed"));

    await acquirer.tick();

    expect(captures).toHaveLength(1);
    expect(captures[0]?.error).toBeInstanceOf(Error);
    expect(captures[0]?.context).toMatchObject({
      acquirer: "poll:reviews",
      repo: "acme/widgets",
      prNumber: 7,
      stage: "poll-pr",
    });
  });
});
