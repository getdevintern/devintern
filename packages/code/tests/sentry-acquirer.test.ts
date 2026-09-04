import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SentryClient } from "../src/lib/sentry-client";
import type { SentryIssue } from "../src/lib/sentry-client";
import { ErrorMonitorAcquirer } from "../src/lib/error-monitor";
import { WebhookQueue } from "../src/lib/webhook-queue";

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

  test("skips invalid issues without marking them processed", async () => {
    const { acquirer, fixed } = makeAcquirer([issue({ count: "1", occurrenceCount: 1 })]);
    await acquirer.tick();

    expect(fixed).toHaveLength(0);
    expect(queue.hasProcessed("errors:sentry:primary", "issue:1001")).toBe(false);
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
});
