import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RelayAcquirer } from "../src/lib/relay-acquirer";
import type { RelayEnvelope } from "../src/lib/relay-acquirer";
import { WebhookQueue } from "../src/lib/webhook-queue";
import { WorkerState } from "../src/lib/worker-state";

const RELAY_URL = "http://relay.test";

interface HandlerLog {
  addressed: [string, number][];
  comments: [string, number, number][];
  tasks: string[];
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
    log = { addressed: [], comments: [], tasks: [] };
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build an acquirer whose fetch returns scripted responses in sequence. */
  function makeAcquirer(
    responses: Array<{ status?: number; events?: RelayEnvelope[]; cursor?: number } | Error>,
    options: { agentPrs?: [string, number][] } = {},
  ): { acquirer: RelayAcquirer; requests: string[]; authHeaders: string[] } {
    const requests: string[] = [];
    const authHeaders: string[] = [];
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
      queue,
      fetchImpl,
      isAgentPr: (repo, pr) => agentPrs.some(([r, n]) => r === repo && n === pr),
      handlers: {
        addressPr: async (repo, pr) => {
          log.addressed.push([repo, pr]);
        },
        handlePrComment: async (repo, pr, commentId) => {
          log.comments.push([repo, pr, commentId]);
        },
        evaluateTask: async (taskKey) => {
          log.tasks.push(taskKey);
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
    expect(log.tasks).toEqual(["PROJ-7"]);
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

  test("resumes from the persisted cursor", async () => {
    workerState.setCursor(`relay:${RELAY_URL}`, "41");
    const { acquirer, requests } = makeAcquirer([{ events: [] }]);
    acquirer.start();
    await waitFor(() => requests.length >= 1);
    await acquirer.stop();
    expect(requests[0]).toContain("cursor=41");
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

  test("handler failures do not kill the loop and are not retried", async () => {
    const failing = envelope({
      seq: 1,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "BOOM-1" },
      deliveryId: "boom",
    });
    const following = envelope({
      seq: 2,
      eventType: "task.changed",
      source: "jira",
      ref: { task: "OK-2" },
      deliveryId: "ok",
    });
    let call = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ events: [failing, following], cursor: 2 }), {
          status: 200,
        });
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
        addressPr: async () => {},
        handlePrComment: async () => {},
        evaluateTask: async (taskKey) => {
          if (taskKey === "BOOM-1") {
            throw new Error("handler exploded");
          }
          log.tasks.push(taskKey);
        },
      },
    });

    acquirer.start();
    await waitFor(() => log.tasks.length === 1);
    await acquirer.stop();

    expect(log.tasks).toEqual(["OK-2"]);
    // The failing envelope is marked processed — no retry loop.
    expect(queue.hasProcessed("relay", "jira:boom")).toBe(true);
  });
});
