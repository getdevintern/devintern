import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  SENTRY_ACTION_FAILED_COMMENT,
  SENTRY_ACTION_SUCCEEDED_COMMENT,
  SentryClient,
} from "../src/lib/observability/sentry-client";
import type { SentryIssue } from "../src/lib/observability/sentry-client";
import { ErrorMonitorAcquirer, SourceFetchError } from "../src/lib/acquirers/error-monitor";
import type { SourceStatusInput } from "../src/lib/acquirers/source-fetch";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { AutomationStateStore } from "../src/lib/automation/state";

async function expectFetchError(promise: Promise<unknown>): Promise<SourceFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceFetchError) return error;
    throw error;
  }
  throw new Error("expected the fetch to reject with a SourceFetchError");
}

function issue(overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    externalId: "issue:1001",
    displayId: "APP-1",
    occurrenceCount: 12,
    id: "1001",
    shortId: "APP-1",
    title: "TypeError: cannot read properties of undefined",
    culprit: "src/app.ts in handler",
    level: "error",
    status: "unresolved",
    count: "12",
    firstSeen: "2026-08-20T10:00:00Z",
    lastSeen: "2026-08-21T09:00:00Z",
    permalink: "https://sentry.io/organizations/acme/issues/1001/",
    metadata: { type: "TypeError", value: "cannot read properties of undefined" },
    ...overrides,
  };
}

describe("SentryClient", () => {
  test("queries the project endpoint with auth and is:unresolved", async () => {
    const requests: string[] = [];
    const authHeaders: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) {
        authHeaders.push(auth);
      }
      return new Response(JSON.stringify([issue()]), { status: 200 });
    }) as typeof fetch;

    const client = new SentryClient({
      authToken: "sntrys_test",
      organization: "acme",
      project: "webapp",
      baseUrl: "https://sentry.example.com/",
      fetchImpl,
    });
    const issues = await client.fetchUnresolvedIssues();

    expect(requests[0]).toContain("https://sentry.example.com/api/0/projects/acme/webapp/issues/");
    expect(requests[0]).toContain("query=is%3Aunresolved");
    expect(authHeaders[0]).toBe("Bearer sntrys_test");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("1001");
  });

  test("falls back to the organization endpoint without a project", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new SentryClient({
      authToken: "t",
      organization: "acme",
      fetchImpl,
    });
    await client.fetchUnresolvedIssues("environment:production");

    expect(requests[0]).toContain("/api/0/organizations/acme/issues/");
    expect(requests[0]).toContain("environment%3Aproduction");
  });

  test("throws a clear error on bad credentials", async () => {
    const fetchImpl = (async () =>
      new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const client = new SentryClient({ authToken: "bad", organization: "acme", fetchImpl });
    expect(client.fetchUnresolvedIssues()).rejects.toThrow("auth token");
  });

  test("classifies an auth failure as auth-failed", async () => {
    const fetchImpl = (async () =>
      new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const client = new SentryClient({ authToken: "bad", organization: "acme", fetchImpl });
    const error = await expectFetchError(client.fetchIssues());
    expect(error.status).toBe("auth-failed");
  });

  test("classifies a 429 as rate-limited and preserves Retry-After", async () => {
    const fetchImpl = (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "30" },
      })) as unknown as typeof fetch;
    const client = new SentryClient({ authToken: "t", organization: "acme", fetchImpl });
    const error = await expectFetchError(client.fetchIssues());
    expect(error.status).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("classifies a transient API error as unreadable", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new SentryClient({ authToken: "t", organization: "acme", fetchImpl });
    const error = await expectFetchError(client.fetchIssues());
    expect(error.status).toBe("unreadable");
  });

  test("classifies a network failure as unreadable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = new SentryClient({ authToken: "t", organization: "acme", fetchImpl });
    const error = await expectFetchError(client.fetchIssues());
    expect(error.status).toBe("unreadable");
    expect(error.message).toContain("ECONNRESET");
  });

  test("posts terminal action feedback without changing issue status", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const client = new SentryClient({
      authToken: "sntrys_write",
      organization: "acme",
      baseUrl: "https://sentry.example.com/",
      fetchImpl,
    });

    await client.reportAction(issue(), true);
    await client.reportAction(issue(), false);

    expect(requests[0]?.url).toBe(
      "https://sentry.example.com/api/0/organizations/acme/issues/1001/comments/",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ text: SENTRY_ACTION_SUCCEEDED_COMMENT }));
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ text: SENTRY_ACTION_FAILED_COMMENT }));
  });

  test("explains the write-token requirement when a comment is rejected", async () => {
    const fetchImpl = (async () =>
      new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const client = new SentryClient({ authToken: "read-only", organization: "acme", fetchImpl });

    expect(client.reportAction(issue(), true)).rejects.toThrow("Issue & Event write access");
  });
});

describe("isIssueValid", () => {
  test("accepts an issue with enough events and metadata", () => {
    const client = new SentryClient({ authToken: "t", organization: "acme" });
    expect(client.validateIssue(issue()).valid).toBe(true);
  });

  test("rejects issues without any locating context", () => {
    const client = new SentryClient({ authToken: "t", organization: "acme" });
    const verdict = client.validateIssue(issue({ culprit: null, metadata: undefined }));
    expect(verdict.valid).toBe(false);
  });
});

describe("buildBugfixTaskMarkdown", () => {
  test("includes the error details and fix instructions", () => {
    const client = new SentryClient({ authToken: "t", organization: "acme" });
    const md = client.buildTaskMarkdown(issue());
    expect(md).toContain("# Fix Sentry error APP-1");
    expect(md).toContain("TypeError");
    expect(md).toContain("src/app.ts in handler");
    expect(md).toContain(issue().permalink);
  });
});

describe("ErrorMonitorAcquirer with Sentry issues", () => {
  let dir: string;
  let dbPath: string;
  let queue: WebhookQueue;

  beforeEach(() => {
    dir = join(tmpdir(), `sentry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    queue = new WebhookQueue({ dbPath });
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAcquirer(
    scriptedIssues: SentryIssue[] | Error,
    overrides: Partial<ConstructorParameters<typeof ErrorMonitorAcquirer<SentryIssue>>[0]> = {},
  ): { acquirer: ErrorMonitorAcquirer<SentryIssue>; fixed: SentryIssue[] } {
    const fixed: SentryIssue[] = [];
    const provider = {
      providerName: "sentry",
      fetchIssues: async () => {
        if (scriptedIssues instanceof Error) throw scriptedIssues;
        return scriptedIssues;
      },
      validateIssue: (item: SentryIssue) =>
        new SentryClient({ authToken: "t", organization: "acme" }).validateIssue(item),
      buildTaskMarkdown: (item: SentryIssue) =>
        new SentryClient({ authToken: "t", organization: "acme" }).buildTaskMarkdown(item),
    };
    const acquirer = new ErrorMonitorAcquirer<SentryIssue>({
      sourceId: "primary",
      intervalSeconds: 60,
      queue,
      provider,
      executeTask: async (i) => {
        fixed.push(i);
        return true;
      },
      ...overrides,
    });
    return { acquirer, fixed };
  }

  test("creates bugfixes for new valid issues and marks them processed", async () => {
    const { acquirer, fixed } = makeAcquirer([issue()]);
    await acquirer.tick();

    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.shortId).toBe("APP-1");
    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(true);
  });

  test("never processes the same error group twice", async () => {
    const { acquirer, fixed } = makeAcquirer([issue()]);
    await acquirer.tick();
    await acquirer.tick();

    expect(fixed).toHaveLength(1);
  });

  test("only one competing acquirer submits an error group", async () => {
    const competingQueue = new WebhookQueue({ dbPath });
    try {
      const first = makeAcquirer([issue()]);
      const second = makeAcquirer([issue()], { queue: competingQueue });

      await Promise.all([first.acquirer.tick(), second.acquirer.tick()]);

      expect(first.fixed.length + second.fixed.length).toBe(1);
    } finally {
      competingQueue.close();
    }
  });

  test("skips invalid issues without marking them processed", async () => {
    const { acquirer, fixed } = makeAcquirer([issue({ count: "1", occurrenceCount: 1 })]);
    await acquirer.tick();

    expect(fixed).toHaveLength(0);
    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(false);
  });

  test("stays quiet while an issue is below the occurrence threshold", async () => {
    const { acquirer, fixed } = makeAcquirer([issue({ count: "1", occurrenceCount: 1 })]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await acquirer.tick();
      await acquirer.tick();
    } finally {
      console.log = originalLog;
    }

    expect(fixed).toHaveLength(0);
    expect(logs.some((line) => line.includes("skipping"))).toBe(false);
    expect(logs.some((line) => line.includes("APP-1"))).toBe(false);
  });

  test("surfaces the skip reason in verbose mode", async () => {
    const { acquirer, fixed } = makeAcquirer([issue({ count: "1", occurrenceCount: 1 })], {
      verbose: true,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await acquirer.tick();
    } finally {
      console.log = originalLog;
    }

    expect(fixed).toHaveLength(0);
    expect(
      logs.some(
        (line) => line.includes("skipping APP-1") && line.includes("only 1 occurrence(s); need 5"),
      ),
    ).toBe(true);
  });

  test("logs the pickup with project, issue id, and occurrence count once", async () => {
    const { acquirer, fixed } = makeAcquirer([issue({ projectSlug: "webapp" })]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await acquirer.tick();
      await acquirer.tick();
    } finally {
      console.log = originalLog;
    }

    expect(fixed).toHaveLength(1);
    const pickups = logs.filter((line) => line.includes("📌"));
    expect(pickups).toHaveLength(1);
    expect(pickups[0]).toContain("webapp APP-1");
    expect(pickups[0]).toContain("12 occurrences");
  });

  test("marks before executing so failing runs do not loop every tick", async () => {
    let attempts = 0;
    const provider = {
      providerName: "sentry",
      fetchIssues: async () => [issue()],
      validateIssue: () => ({ valid: true }),
      buildTaskMarkdown: () => "task",
    };
    const acquirer = new ErrorMonitorAcquirer({
      sourceId: "primary",
      intervalSeconds: 60,
      queue,
      provider,
      executeTask: async () => {
        attempts++;
        return false;
      },
    });

    await acquirer.tick();
    await acquirer.tick();

    expect(attempts).toBe(1);
  });

  test("unclaims capacity-deferred issues so a later tick can retry", async () => {
    let attempts = 0;
    const { acquirer } = makeAcquirer([issue()], {
      executeTask: async () => {
        attempts++;
        return attempts === 1 ? "deferred" : true;
      },
    });

    await acquirer.tick();
    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(false);
    await acquirer.tick();
    expect(attempts).toBe(2);
    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(true);
  });

  test("comments once after a terminal run but not after a deferral", async () => {
    const outcomes: boolean[] = [];
    let attempts = 0;
    const provider = {
      providerName: "sentry",
      fetchIssues: async () => [issue()],
      validateIssue: () => ({ valid: true }),
      buildTaskMarkdown: () => "task",
      reportAction: async (_item: SentryIssue, succeeded: boolean) => {
        outcomes.push(succeeded);
      },
    };
    const acquirer = new ErrorMonitorAcquirer({
      sourceId: "primary",
      intervalSeconds: 60,
      queue,
      provider,
      commentOnAction: true,
      executeTask: async () => {
        attempts++;
        return attempts === 1 ? "deferred" : false;
      },
    });

    await acquirer.tick();
    expect(outcomes).toEqual([]);
    await acquirer.tick();
    expect(outcomes).toEqual([false]);
  });

  test("a rejected action comment does not fail the completed run", async () => {
    const provider = {
      providerName: "sentry",
      fetchIssues: async () => [issue()],
      validateIssue: () => ({ valid: true }),
      buildTaskMarkdown: () => "task",
      reportAction: async () => {
        throw new Error("comment denied");
      },
    };
    const acquirer = new ErrorMonitorAcquirer({
      sourceId: "primary",
      intervalSeconds: 60,
      queue,
      provider,
      commentOnAction: true,
      executeTask: async () => true,
    });

    await acquirer.tick();

    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(true);
  });

  test("caps work per tick", async () => {
    const many = [
      issue(),
      issue({ id: "1002", shortId: "APP-2", externalId: "issue:1002", displayId: "APP-2" }),
      issue({ id: "1003", shortId: "APP-3", externalId: "issue:1003", displayId: "APP-3" }),
    ];
    const { acquirer, fixed } = makeAcquirer(many, { maxIssuesPerTick: 2 });
    await acquirer.tick();

    expect(fixed).toHaveLength(2);
  });

  test("a failed fetch does not throw or mark anything", async () => {
    const { acquirer, fixed } = makeAcquirer(new Error("network down"));
    await acquirer.tick();

    expect(fixed).toHaveLength(0);
    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(false);
  });

  test("records an ok read and resets failure counters", async () => {
    const store = new AutomationStateStore(join(dir, "status.db"));
    try {
      const { acquirer, fixed } = makeAcquirer([issue()], {
        statusStore: store,
        now: () => 1_000,
      });
      const outcome = await acquirer.tick();

      expect(outcome.status).toBe("ok");
      expect(outcome.issues).toHaveLength(1);
      expect(fixed).toHaveLength(1);
      const record = store.getSourceStatus("sentry", "primary");
      expect(record?.status).toBe("ok");
      expect(record?.consecutiveFailures).toBe(0);
      expect(record?.lastSuccessAt).toBe(1_000);
    } finally {
      store.close();
    }
  });

  test("an unreadable read is a distinct outcome and does not advance the cursor", async () => {
    const store = new AutomationStateStore(join(dir, "status.db"));
    try {
      const { acquirer, fixed } = makeAcquirer(new SourceFetchError("unreadable", "boom"), {
        statusStore: store,
        now: () => 2_000,
      });

      const first = await acquirer.tick();
      expect(first.status).toBe("unreadable");
      expect(first.issues).toEqual([]);
      expect(first.error).toContain("boom");
      expect(fixed).toHaveLength(0);
      expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(false);

      const record = store.getSourceStatus("sentry", "primary");
      expect(record?.status).toBe("unreadable");
      expect(record?.message).toContain("boom");
      expect(record?.consecutiveFailures).toBe(1);

      await acquirer.tick();
      expect(store.getSourceStatus("sentry", "primary")?.consecutiveFailures).toBe(2);
    } finally {
      store.close();
    }
  });

  test("retries a transient failure and processes once the source is readable", async () => {
    const store = new AutomationStateStore(join(dir, "status.db"));
    let failing = true;
    const provider = {
      providerName: "sentry",
      fetchIssues: async () => {
        if (failing) throw new SourceFetchError("unreadable", "temporary");
        return [issue()];
      },
      validateIssue: () => ({ valid: true }),
      buildTaskMarkdown: () => "task",
    };
    const fixed: SentryIssue[] = [];
    const acquirer = new ErrorMonitorAcquirer({
      sourceId: "primary",
      intervalSeconds: 60,
      queue,
      provider,
      statusStore: store,
      now: () => 5_000,
      executeTask: async (item) => {
        fixed.push(item);
        return true;
      },
    });

    try {
      expect((await acquirer.tick()).status).toBe("unreadable");
      expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(false);

      failing = false;
      expect((await acquirer.tick()).status).toBe("ok");
      expect(fixed).toHaveLength(1);
      expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(true);

      const record = store.getSourceStatus("sentry", "primary");
      expect(record?.status).toBe("ok");
      expect(record?.consecutiveFailures).toBe(0);
      expect(record?.lastSuccessAt).toBe(5_000);
    } finally {
      store.close();
    }
  });

  test("records a rate-limited read with its retry window", async () => {
    const store = new AutomationStateStore(join(dir, "status.db"));
    try {
      const { acquirer } = makeAcquirer(
        new SourceFetchError("rate-limited", "HTTP 429", { retryAfterMs: 30_000 }),
        { statusStore: store, now: () => 10_000 },
      );
      const outcome = await acquirer.tick();

      expect(outcome.status).toBe("rate-limited");
      expect(outcome.retryAfterMs).toBe(30_000);
      const record = store.getSourceStatus("sentry", "primary");
      expect(record?.status).toBe("rate-limited");
      expect(record?.retryAfterAt).toBe(40_000);
    } finally {
      store.close();
    }
  });

  test("an auth failure is recorded as auth-failed", async () => {
    const store = new AutomationStateStore(join(dir, "status.db"));
    try {
      const { acquirer } = makeAcquirer(new SourceFetchError("auth-failed", "bad token"), {
        statusStore: store,
        now: () => 7,
      });
      const outcome = await acquirer.tick();

      expect(outcome.status).toBe("auth-failed");
      expect(store.getSourceStatus("sentry", "primary")?.status).toBe("auth-failed");
    } finally {
      store.close();
    }
  });

  test("a throwing status store never changes the read outcome", async () => {
    const store = {
      recordSourceStatus() {
        throw new Error("SQLITE_BUSY");
      },
    };
    const { acquirer } = makeAcquirer(
      new SourceFetchError("rate-limited", "HTTP 429", { retryAfterMs: 30_000 }),
      { statusStore: store, now: () => 1_000 },
    );

    const outcome = await acquirer.tick();

    expect(outcome.status).toBe("rate-limited");
    expect(outcome.retryAfterMs).toBe(30_000);
  });

  test("skips redundant ok-to-ok status writes", async () => {
    const statuses: string[] = [];
    const store = {
      recordSourceStatus(status: SourceStatusInput) {
        statuses.push(status.status);
      },
    };
    const { acquirer } = makeAcquirer([issue()], { statusStore: store, now: () => 1_000 });

    await acquirer.tick();
    await acquirer.tick();

    expect(statuses).toEqual(["ok"]);
  });
});
