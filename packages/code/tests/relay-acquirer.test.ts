import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RelayAcquirer } from "../src/lib/relay/acquirer";
import type { RelayEnvelope, RelayHandlers } from "../src/lib/relay/acquirer";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";
import { PermanentWebhookError } from "../src/lib/webhook/webhook-errors";

const RELAY_URL = "http://relay.test";

interface HandlerLog {
  addressed: [string, number][];
  comments: [string, number, number][];
  tasks: Array<[string, string, string?]>;
  codeHosts: RelayEnvelope[];
}

function envelope(overrides: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    seq: 1,
    source: "github",
    eventType: "pr.review_submitted",
    repo: "acme/webapp",
    ref: { pr: 1 },
    deliveryId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe("RelayAcquirer", () => {
  let dir: string;
  let dbPath: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;
  let log: HandlerLog;

  beforeEach(() => {
    dir = join(tmpdir(), `relay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    workerState = new WorkerState(dbPath);
    queue = new WebhookQueue({ dbPath });
    log = { addressed: [], comments: [], tasks: [], codeHosts: [] };
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build an acquirer whose fetch returns scripted responses in sequence. */
  function makeAcquirer(
    responses: Array<{ status?: number; events?: RelayEnvelope[]; cursor?: number } | Error>,
    options: {
      agentPrs?: [string, number][];
      evaluateTask?: RelayHandlers["evaluateTask"];
      addressPr?: RelayHandlers["addressPr"];
      handlePrComment?: RelayHandlers["handlePrComment"];
      /** Override the shared queue (e.g. a lower retry ceiling for a test). */
      queue?: WebhookQueue;
      deliveryRetryWindowMs?: number;
      deliveryMaxAttempts?: number;
      runFailureMaxAttempts?: number;
    } = {},
  ): { acquirer: RelayAcquirer; requests: string[]; authHeaders: string[] } {
    const requests: string[] = [];
    const authHeaders: string[] = [];
    const deliveryQueue = options.queue ?? queue;
    let call = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) {
        authHeaders.push(auth);
      }
      if (call < responses.length) {
        const scripted = responses[call++];
        if (scripted instanceof Error) {
          throw scripted;
        }
        return new Response(
          JSON.stringify({
            events: scripted.events ?? [],
            cursor: scripted.cursor ?? 0,
          }),
          { status: scripted.status ?? 200 },
        );
      }
      // Past the script: park like a real long poll until aborted.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof fetch;

    const agentPrs = options.agentPrs ?? [];
    const acquirer = new RelayAcquirer({
      relayUrl: RELAY_URL,
      relayToken: "drt_test_token",
      workerState,
      queue: deliveryQueue,
      fetchImpl,
      isAgentPr: (repo, pr) => agentPrs.some(([r, n]) => r === repo && n === pr),
      deliveryRetryWindowMs: options.deliveryRetryWindowMs,
      deliveryMaxAttempts: options.deliveryMaxAttempts,
      runFailureMaxAttempts: options.runFailureMaxAttempts,
      handlers: {
        addressPr:
          options.addressPr ??
          (async (repo, pr) => {
            log.addressed.push([repo, pr]);
            return true;
          }),
        handlePrComment:
          options.handlePrComment ??
          (async (repo, pr, commentId) => {
            log.comments.push([repo, pr, commentId]);
            return true;
          }),
        evaluateTask:
          options.evaluateTask ??
          (async (taskKey, trackerSource, team) => {
            log.tasks.push([taskKey, trackerSource, team]);
          }),
        reconcileCodeHost: async (event) => {
          log.codeHosts.push(event);
        },
      },
    });
    return { acquirer, requests, authHeaders };
  }

  async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("condition not met in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("dispatches envelope types to the right handlers and persists the cursor", async () => {
    const events: RelayEnvelope[] = [
      envelope({ seq: 1, eventType: "pr.review_submitted", ref: { pr: 5 }, deliveryId: "a" }),
      envelope({
        seq: 2,
        eventType: "pr.comment_created",
        ref: { pr: 6, commentId: 99 },
        deliveryId: "b",
      }),
      envelope({
        seq: 3,
        eventType: "task.changed",
        source: "jira",
        team: "platform",
        repo: undefined,
        ref: { task: "PROJ-7" },
        deliveryId: "c",
      }),
    ];
    const { acquirer, requests, authHeaders } = makeAcquirer(
      [{ events, cursor: 3 }, { events: [] }],
      {
        agentPrs: [["acme/webapp", 5]],
      },
    );

    acquirer.start();
    await waitFor(() => log.tasks.length === 1);
    await acquirer.stop();

    expect(log.addressed).toEqual([["acme/webapp", 5]]);
    expect(log.comments).toEqual([["acme/webapp", 6, 99]]);
    expect(log.tasks).toEqual([["PROJ-7", "jira", "platform"]]);
    expect(queue.hasProcessed("relay", "jira:platform:c")).toBe(true);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("3");
    expect(requests[0]).toContain("cursor=0");
    expect(authHeaders[0]).toBe("Bearer drt_test_token");
  });

  test("reviews on non-agent PRs are ignored; duplicates are deduped", async () => {
    const review = envelope({ seq: 1, ref: { pr: 8 }, deliveryId: "dup" });
    const { acquirer } = makeAcquirer([
      { events: [review], cursor: 1 },
      { events: [{ ...review, seq: 2 }], cursor: 2 },
      { events: [] },
    ]);

    acquirer.start();
    await waitFor(() => (workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0") === "2");
    await acquirer.stop();

    // Not an agent PR → never addressed; second delivery deduped either way.
    expect(log.addressed.length).toBe(0);
    expect(queue.hasProcessed("relay", "github:dup")).toBe(true);
  });

  test("dispatches valid provider-neutral v2 code-host hints", async () => {
    const event = envelope({
      version: 2,
      seq: 1,
      source: "gitlab",
      eventType: "change.feedback",
      repo: undefined,
      codeHost: {
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
        projectId: "42",
        projectPath: "platform/widgets",
      },
      ref: { change: 17, branch: "feature/a", headSha: "abc123" },
      deliveryId: "webhook-id:delivery-1",
    });
    const { acquirer } = makeAcquirer([{ events: [event], cursor: 1 }, { events: [] }]);

    acquirer.start();
    await waitFor(() => log.codeHosts.length === 1);
    await acquirer.stop();

    expect(log.codeHosts[0]).toEqual(event);
  });

  test("ignores malformed or provider-mismatched v2 code-host hints", async () => {
    const identity = {
      provider: "gitlab" as const,
      instanceUrl: "https://gitlab.example.com",
      projectId: "42",
      projectPath: "platform/widgets",
    };
    const events = [
      envelope({
        seq: 1,
        source: "gitlab",
        eventType: "change.changed",
        codeHost: identity,
        ref: { change: 17 },
      }),
      envelope({
        version: 2,
        seq: 2,
        source: "github",
        eventType: "change.changed",
        codeHost: identity,
        ref: { change: 17 },
      }),
      envelope({
        version: 2,
        seq: 3,
        source: "gitlab",
        eventType: "ci.changed",
        codeHost: identity,
        ref: {},
      }),
    ];
    const { acquirer } = makeAcquirer([{ events, cursor: 3 }, { events: [] }]);
    acquirer.start();
    await waitFor(() => (workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0") === "3");
    await acquirer.stop();
    expect(log.codeHosts).toEqual([]);
  });

  test("resumes from the persisted cursor", async () => {
    workerState.setCursor(`relay:${RELAY_URL}`, "41");
    const { acquirer, requests } = makeAcquirer([{ events: [] }]);
    acquirer.start();
    await waitFor(() => requests.length >= 1);
    await acquirer.stop();
    expect(requests[0]).toContain("cursor=41");
  });

  test("reports successful polls for fallback suppression", async () => {
    let successes = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (successes === 0) {
        return new Response(JSON.stringify({ events: [], cursor: 0 }), { status: 200 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof fetch;
    const acquirer = new RelayAcquirer({
      relayUrl: RELAY_URL,
      relayToken: "drt_test_token",
      workerState,
      queue,
      fetchImpl,
      isAgentPr: () => false,
      handlers: {
        addressPr: async () => false,
        handlePrComment: async () => true,
        evaluateTask: async () => {},
      },
      onPollSuccess: () => {
        successes++;
      },
    });

    acquirer.start();
    await waitFor(() => successes === 1);
    await acquirer.stop();
    expect(successes).toBe(1);
  });

  test("errors back off and the loop recovers", async () => {
    const { acquirer, requests } = makeAcquirer(
      [
        new Error("connection refused"),
        { events: [envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "after-error" })], cursor: 1 },
        { events: [] },
      ],
      { agentPrs: [["acme/webapp", 5]] },
    );

    acquirer.start();
    // Backoff is 5s; stop early and verify no crash + first request made.
    await waitFor(() => requests.length >= 1);
    await acquirer.stop();
    expect(requests.length).toBe(1);
    expect(log.addressed.length).toBe(0);
  });

  test("transient handler failures are not acked and retry on redelivery", async () => {
    const flaky = envelope({
      seq: 1,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "FLAKY-1" },
      deliveryId: "flaky",
    });
    let attempts = 0;
    const evaluateTask: RelayHandlers["evaluateTask"] = async (taskKey, trackerSource) => {
      attempts++;
      if (attempts === 1) {
        throw new Error("upstream unavailable (503)");
      }
      log.tasks.push([taskKey, trackerSource]);
    };

    const { acquirer } = makeAcquirer([{ events: [flaky], cursor: 1 }], { evaluateTask });
    acquirer.start();
    await waitFor(() => attempts === 1);
    // Transient → not recorded handled, cursor not advanced.
    expect(queue.hasProcessed("relay", "jira:flaky")).toBe(false);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");
    await acquirer.stop();

    // The relay redelivers; the released claim lets the retry run.
    const { acquirer: retry } = makeAcquirer([{ events: [flaky], cursor: 1 }, { events: [] }], {
      evaluateTask,
    });
    retry.start();
    await waitFor(() => log.tasks.length === 1);
    await retry.stop();

    expect(log.tasks).toEqual([["FLAKY-1", "jira"]]);
    expect(queue.hasProcessed("relay", "jira:flaky")).toBe(true);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("1");
  });

  test("a failed review run stays retryable instead of being acknowledged", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "failed-review" });
    const following = envelope({
      seq: 2,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "NEXT-1" },
      deliveryId: "after-failed-review",
    });
    let attempts = 0;
    // A non-zero subprocess exit collapses to `false`, which could be a
    // transient transport/5xx failure. The relay must keep it retryable rather
    // than acknowledge and lose the review.
    const addressPr: RelayHandlers["addressPr"] = async (repo, pr) => {
      attempts++;
      log.addressed.push([repo, pr]);
      return attempts > 1;
    };
    const { acquirer } = makeAcquirer([{ events: [review, following], cursor: 2 }], {
      agentPrs: [["acme/webapp", 5]],
      addressPr,
    });

    acquirer.start();
    try {
      await waitFor(() => attempts === 1);
    } finally {
      await acquirer.stop();
    }

    expect(queue.hasProcessed("relay", "github:failed-review")).toBe(false);
    expect(queue.isInFlight("relay", "github:failed-review")).toBe(false);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");
    expect(log.tasks).toEqual([]);

    // The relay redelivers and the retry succeeds; later envelopes dispatch.
    const { acquirer: retry } = makeAcquirer([{ events: [review, following], cursor: 2 }], {
      agentPrs: [["acme/webapp", 5]],
      addressPr,
    });
    retry.start();
    try {
      await waitFor(() => log.tasks.length === 1);
    } finally {
      await retry.stop();
    }
    expect(attempts).toBe(2);
    expect(queue.hasProcessed("relay", "github:failed-review")).toBe(true);
    expect(log.tasks).toEqual([["NEXT-1", "jira"]]);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("2");
  });

  test("a started-but-failed review run spends the tighter started-run budget", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "deterministic-failure" });
    let attempts = 0;
    // A deterministic agent failure (bad repo state, compile error) can never
    // succeed, so it must not consume the full transport budget of eight whole
    // agent runs: the default started-run budget acknowledges it after one
    // retry.
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      return false;
    };
    const options = {
      agentPrs: [["acme/webapp", 5]] as [string, number][],
      addressPr,
    };

    const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], options);
    acquirer.start();
    try {
      await waitFor(
        () =>
          attempts === 1 &&
          queue.getRelayDeliveryFirstAttemptAt("github:deterministic-failure") !== null,
      );
    } finally {
      await acquirer.stop();
    }
    expect(queue.hasProcessed("relay", "github:deterministic-failure")).toBe(false);

    // One retry is allowed, then the failure is terminal even though the
    // eight-attempt transport ceiling is far from spent.
    const { acquirer: retry } = makeAcquirer([{ events: [review], cursor: 1 }], options);
    retry.start();
    try {
      await waitFor(() => queue.hasProcessed("relay", "github:deterministic-failure"));
    } finally {
      await retry.stop();
    }
    expect(attempts).toBe(2);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("1");

    // A further redelivery is acknowledged without another agent run.
    const { acquirer: later, requests } = makeAcquirer([{ events: [review], cursor: 1 }], options);
    later.start();
    try {
      await waitFor(() => requests.length === 1);
    } finally {
      await later.stop();
    }
    expect(attempts).toBe(2);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("1");
  });

  test("a prior transport failure does not consume the started-run retry budget", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "mixed-failure" });
    let attempts = 0;
    let phase: "transport" | "run" = "transport";
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      if (phase === "transport") {
        throw new Error("upstream unavailable (503)");
      }
      return false;
    };
    const options = {
      agentPrs: [["acme/webapp", 5]] as [string, number][],
      addressPr,
      runFailureMaxAttempts: 2,
    };

    // First a transport failure, which must spend only the transport budget.
    const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], options);
    acquirer.start();
    try {
      await waitFor(() => attempts === 1);
    } finally {
      await acquirer.stop();
    }
    expect(queue.hasProcessed("relay", "github:mixed-failure")).toBe(false);
    expect(queue.getRelayDeliveryRunFailureAttempts("github:mixed-failure")).toBe(0);

    // The first started-run failure is 1/2 against the run budget and must
    // stay retryable even though the delivery already failed once in transit.
    phase = "run";
    const { acquirer: second } = makeAcquirer([{ events: [review], cursor: 1 }], options);
    second.start();
    try {
      await waitFor(
        () =>
          attempts === 2 && queue.getRelayDeliveryRunFailureAttempts("github:mixed-failure") === 1,
      );
    } finally {
      await second.stop();
    }
    expect(queue.hasProcessed("relay", "github:mixed-failure")).toBe(false);

    // The second started-run failure spends the run budget and is terminal.
    const { acquirer: third } = makeAcquirer([{ events: [review], cursor: 1 }], options);
    third.start();
    try {
      await waitFor(() => queue.hasProcessed("relay", "github:mixed-failure"));
    } finally {
      await third.stop();
    }
    expect(attempts).toBe(3);
  });

  test("an interrupted review run stays retryable and holds the cursor", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "interrupted-review" });
    const following = envelope({
      seq: 2,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "NEXT-1" },
      deliveryId: "after-interrupted-review",
    });
    let attempts = 0;
    const addressPr: RelayHandlers["addressPr"] = async (repo, pr) => {
      attempts++;
      log.addressed.push([repo, pr]);
      return "interrupted";
    };
    const { acquirer } = makeAcquirer([{ events: [review, following], cursor: 2 }], {
      agentPrs: [["acme/webapp", 5]],
      addressPr,
    });

    acquirer.start();
    try {
      await waitFor(() => attempts === 1);
    } finally {
      await acquirer.stop();
    }

    // A shutdown drain stopped the run; its outcome is unknown, so the
    // delivery must not be recorded handled and the cursor must not advance.
    expect(queue.hasProcessed("relay", "github:interrupted-review")).toBe(false);
    expect(queue.isInFlight("relay", "github:interrupted-review")).toBe(false);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");
    expect(log.tasks).toEqual([]);

    // The relay redelivers after restart and the retry runs normally.
    const { acquirer: retry } = makeAcquirer([{ events: [review, following], cursor: 2 }], {
      agentPrs: [["acme/webapp", 5]],
    });
    retry.start();
    try {
      await waitFor(() => log.tasks.length === 1);
    } finally {
      await retry.stop();
    }
    expect(queue.hasProcessed("relay", "github:interrupted-review")).toBe(true);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("2");
  });

  test("an interrupted mention run stays retryable and holds the cursor", async () => {
    const comment = envelope({
      seq: 1,
      eventType: "pr.comment_created",
      ref: { pr: 5, commentId: 77 },
      deliveryId: "interrupted-mention",
    });
    const following = envelope({
      seq: 2,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "NEXT-1" },
      deliveryId: "after-interrupted-mention",
    });
    let attempts = 0;
    const handlePrComment: RelayHandlers["handlePrComment"] = async () => {
      attempts++;
      return "interrupted";
    };
    const { acquirer } = makeAcquirer([{ events: [comment, following], cursor: 2 }], {
      handlePrComment,
    });

    acquirer.start();
    try {
      await waitFor(() => attempts === 1);
    } finally {
      await acquirer.stop();
    }

    expect(queue.hasProcessed("relay", "github:interrupted-mention")).toBe(false);
    expect(queue.isInFlight("relay", "github:interrupted-mention")).toBe(false);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");
    expect(log.tasks).toEqual([]);

    // The relay redelivers after restart and the retry runs normally.
    const { acquirer: retry } = makeAcquirer([{ events: [comment, following], cursor: 2 }]);
    retry.start();
    try {
      await waitFor(() => log.tasks.length === 1);
    } finally {
      await retry.stop();
    }
    expect(queue.hasProcessed("relay", "github:interrupted-mention")).toBe(true);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("2");
  });

  test("a rate-limited delivery retries beyond the webhook retry budget", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "rate-limited" });
    let attempts = 0;
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      throw new Error("GitHub API error (403): API rate limit exceeded");
    };
    // `WEBHOOK_MAX_RETRIES` is intentionally 1: the relay budget is
    // time-based, so a rate limit lasting minutes must not be acknowledged
    // after the first failure.
    const cappedQueue = new WebhookQueue({ dbPath: join(dir, "rate-limit.db"), maxRetries: 1 });
    try {
      for (let round = 1; round <= 3; round++) {
        const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], {
          agentPrs: [["acme/webapp", 5]],
          addressPr,
          queue: cappedQueue,
        });
        acquirer.start();
        try {
          await waitFor(() => attempts === round);
        } finally {
          await acquirer.stop();
        }
        expect(cappedQueue.hasProcessed("relay", "github:rate-limited")).toBe(false);
        expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");
      }

      const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], {
        agentPrs: [["acme/webapp", 5]],
        queue: cappedQueue,
      });
      acquirer.start();
      try {
        await waitFor(() => cappedQueue.hasProcessed("relay", "github:rate-limited"));
      } finally {
        await acquirer.stop();
      }
      expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("1");
    } finally {
      cappedQueue.close();
    }
  });

  test("a delivery is acknowledged once the relay retry window elapses", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "window-spent" });
    let attempts = 0;
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      throw new Error("upstream unavailable (503)");
    };
    const windowQueue = new WebhookQueue({ dbPath: join(dir, "window.db"), maxRetries: 100 });
    try {
      // Seed a failure from a day ago so the first observed failure is
      // already outside the one-hour retry window.
      windowQueue.beginRelayDeliveryAttempt(
        "github:window-spent",
        "seeded outage",
        Date.now() - 24 * 60 * 60 * 1000,
      );
      const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], {
        agentPrs: [["acme/webapp", 5]],
        addressPr,
        queue: windowQueue,
      });
      acquirer.start();
      try {
        await waitFor(() => windowQueue.hasProcessed("relay", "github:window-spent"));
      } finally {
        await acquirer.stop();
      }
      expect(attempts).toBe(1);
      expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("1");
    } finally {
      windowQueue.close();
    }
  });

  test("a delivery whose retry window is spent is acknowledged so later envelopes dispatch", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "capped-review" });
    const following = envelope({
      seq: 2,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "NEXT-1" },
      deliveryId: "after-capped-review",
    });
    let attempts = 0;
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      throw new Error("upstream unavailable (503)");
    };
    const cappedQueue = new WebhookQueue({ dbPath: join(dir, "capped.db"), maxRetries: 2 });
    try {
      // The window started a day ago, so this failure exhausts it.
      cappedQueue.beginRelayDeliveryAttempt(
        "github:capped-review",
        "seeded outage",
        Date.now() - 24 * 60 * 60 * 1000,
      );
      const { acquirer } = makeAcquirer([{ events: [review, following], cursor: 2 }], {
        agentPrs: [["acme/webapp", 5]],
        addressPr,
        queue: cappedQueue,
      });
      acquirer.start();
      try {
        await waitFor(() => log.tasks.length === 1);
      } finally {
        await acquirer.stop();
      }
      // The exhausted delivery is acknowledged so it stops pinning the cursor,
      // then later envelopes dispatch in the same poll.
      expect(attempts).toBe(1);
      expect(cappedQueue.hasProcessed("relay", "github:capped-review")).toBe(true);
      expect(log.tasks).toEqual([["NEXT-1", "jira"]]);
      expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("2");
    } finally {
      cappedQueue.close();
    }
  });

  for (const outcome of ["deferred", "rate-limit"] as const) {
    test(`review outcome ${outcome} stays retryable and blocks later envelopes`, async () => {
      const review = envelope({ ref: { pr: 5 }, deliveryId: "retry-review" });
      const following = envelope({
        seq: 2,
        eventType: "task.changed",
        source: "jira",
        ref: { task: "NEXT-1" },
        deliveryId: "following",
      });
      let attempts = 0;
      const addressPr: RelayHandlers["addressPr"] = async () => {
        attempts++;
        if (attempts > 1) return true;
        if (outcome === "rate-limit") {
          throw new Error("GitHub API error (403): API rate limit exceeded");
        }
        return outcome;
      };
      const options = { agentPrs: [["acme/webapp", 5]] as [string, number][], addressPr };
      const { acquirer } = makeAcquirer([{ events: [review, following], cursor: 2 }], options);
      acquirer.start();
      try {
        await waitFor(() => attempts === 1);
      } finally {
        await acquirer.stop();
      }
      expect(queue.hasProcessed("relay", "github:retry-review")).toBe(false);
      expect(queue.isInFlight("relay", "github:retry-review")).toBe(false);
      expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");
      expect(log.tasks).toEqual([]);

      const { acquirer: retry, requests } = makeAcquirer(
        [{ events: [review, following], cursor: 2 }],
        options,
      );
      retry.start();
      try {
        await waitFor(() => log.tasks.length === 1);
      } finally {
        await retry.stop();
      }
      expect(new URL(requests[0]).searchParams.get("cursor")).toBe("0");
      expect(attempts).toBe(2);
      expect(queue.hasProcessed("relay", "github:retry-review")).toBe(true);
      expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("2");
    });
  }

  test("a deferred run is not recorded as a failed attempt", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "deferred-review" });
    let attempts = 0;
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      return "deferred";
    };
    const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], {
      agentPrs: [["acme/webapp", 5]],
      addressPr,
    });

    acquirer.start();
    try {
      await waitFor(() => attempts === 1);
    } finally {
      await acquirer.stop();
    }

    // Deferral is an expected capacity gap: it must not spend the retry
    // budget (or be reported as a failure).
    expect(queue.getRelayDeliveryFirstAttemptAt("github:deferred-review")).toBeNull();
    expect(queue.hasProcessed("relay", "github:deferred-review")).toBe(false);
  });

  test("a delivery is acknowledged once the attempt ceiling is spent", async () => {
    const review = envelope({ seq: 1, ref: { pr: 5 }, deliveryId: "attempt-capped" });
    let attempts = 0;
    const addressPr: RelayHandlers["addressPr"] = async () => {
      attempts++;
      throw new Error("upstream unavailable (503)");
    };
    const { acquirer } = makeAcquirer([{ events: [review], cursor: 1 }], {
      agentPrs: [["acme/webapp", 5]],
      addressPr,
      deliveryMaxAttempts: 2,
    });

    acquirer.start();
    try {
      // First failure records attempt 1 and retries.
      await waitFor(() => attempts === 1);
      expect(queue.hasProcessed("relay", "github:attempt-capped")).toBe(false);
    } finally {
      await acquirer.stop();
    }

    const { acquirer: retry } = makeAcquirer([{ events: [review], cursor: 1 }], {
      agentPrs: [["acme/webapp", 5]],
      addressPr,
      deliveryMaxAttempts: 2,
    });
    retry.start();
    try {
      await waitFor(() => queue.hasProcessed("relay", "github:attempt-capped"));
    } finally {
      await retry.stop();
    }
    // The second failure hits the ceiling, so the envelope stops pinning the
    // cursor even though the one-hour window has not elapsed.
    expect(attempts).toBe(2);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("1");
  });

  test("an in-flight delivery holds the cursor without releasing another run's claim", async () => {
    const review = envelope({ ref: { pr: 5 }, deliveryId: "running" });
    queue.beginDelivery("relay", "github:running");
    const { acquirer, requests } = makeAcquirer([{ events: [review], cursor: 1 }], {
      agentPrs: [["acme/webapp", 5]],
    });
    acquirer.start();
    try {
      await waitFor(() => requests.length === 1);
    } finally {
      await acquirer.stop();
    }
    expect(log.addressed).toEqual([]);
    expect(queue.hasProcessed("relay", "github:running")).toBe(false);
    expect(queue.isInFlight("relay", "github:running")).toBe(true);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue ?? "0").toBe("0");

    queue.completeDelivery("relay", "github:running");
    const { acquirer: retry } = makeAcquirer([{ events: [review], cursor: 1 }]);
    retry.start();
    try {
      await waitFor(() => workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue === "1");
    } finally {
      await retry.stop();
    }
    expect(log.addressed).toEqual([]);
  });

  test("permanent handler failures are acked and the loop continues", async () => {
    const gone = envelope({
      seq: 1,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "GONE-1" },
      deliveryId: "gone",
    });
    const following = envelope({
      seq: 2,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "OK-2" },
      deliveryId: "ok",
    });
    const { acquirer } = makeAcquirer([{ events: [gone, following], cursor: 2 }, { events: [] }], {
      evaluateTask: async (taskKey, trackerSource) => {
        if (taskKey === "GONE-1") {
          throw new PermanentWebhookError("issue was deleted", { status: 404 });
        }
        log.tasks.push([taskKey, trackerSource]);
      },
    });

    acquirer.start();
    await waitFor(() => log.tasks.length === 1);
    await acquirer.stop();

    expect(log.tasks).toEqual([["OK-2", "jira"]]);
    // The permanent failure is recorded, not retried, and the loop moves on.
    expect(queue.hasProcessed("relay", "jira:gone")).toBe(true);
    expect(queue.hasProcessed("relay", "jira:ok")).toBe(true);
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("2");
  });
});
