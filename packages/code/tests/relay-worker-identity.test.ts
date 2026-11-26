import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseConnectArgs, runWorkerConnectCommand } from "../src/lib/init/worker-connect";
import { buildTargetDocument } from "../src/lib/init/worker-connect-json";
import { relayReadinessCheck } from "../src/lib/observability/relay-readiness";
import { RelayAcquirer } from "../src/lib/relay/acquirer";
import { connectRelayTarget, loadRelayState, saveRelayState } from "../src/lib/relay/connect";
import type { ConnectOutcome, RelayConnectState } from "../src/lib/relay/connect";
import {
  registerRelayWorker,
  relayWorkerClaims,
  relayWorkerLabel,
  relayWorkerView,
} from "../src/lib/relay/worker-identity";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { WorkerState } from "../src/lib/state/worker-state";

const RELAY_URL = "http://relay.test";
const WORKER_ID = `wkr_${"a".repeat(32)}`;
const OTHER_ID = `wkr_${"b".repeat(32)}`;
const LAST_SEEN = Date.UTC(2026, 10, 20, 9, 30);

interface Call {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/**
 * Minimal relay with per-worker routing. `conflicts` are reported for any
 * claim of those keys unless the request sets `takeover`.
 */
function fakeRelay(options: {
  calls: Call[];
  conflictKeys?: string[];
  registerStatus?: number;
  sourceConflict?: boolean;
  created?: boolean;
  cursor?: number;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    options.calls.push({ url, auth, body });
    const reply = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status });
    const conflict = (key: string, kind = "repo") => ({
      kind,
      key,
      ownerWorkerId: OTHER_ID,
      ownerLabel: "host-b:ws-12345678",
      lastSeenAt: LAST_SEEN,
    });
    if (url.endsWith("/v1/worker/register")) {
      if (options.registerStatus) return reply(options.registerStatus, { error: "not found" });
      const claims = (body?.claims as Array<{ kind: string; key: string }>) ?? [];
      const conflicted = body?.takeover
        ? []
        : claims.filter((claim) => options.conflictKeys?.includes(claim.key));
      return reply(200, {
        customerId: "user_1",
        worker: { workerId: WORKER_ID, label: body?.label, lastSeenAt: Date.now() },
        created: options.created ?? true,
        cursor: options.cursor ?? 166,
        claimed: claims.filter((claim) => !conflicted.includes(claim)),
        conflicts: conflicted.map((claim) => conflict(claim.key, claim.kind)),
      });
    }
    if (url.endsWith("/v1/status")) {
      return reply(200, {
        customerId: "user_1",
        licenseSource: "solo-automation",
        buffered: 0,
        registrations: [
          {
            kind: "repo",
            key: "acme/web",
            createdAt: 1,
            lastEventAt: null,
            ownerWorkerId: WORKER_ID,
          },
          { kind: "repo", key: "acme/api", createdAt: 1, lastEventAt: null, ownerWorkerId: null },
        ],
      });
    }
    if (body?.action === "issue-token") {
      return reply(200, {
        customerId: "user_1",
        licenseSource: "solo-automation",
        relayToken: "drt_new",
      });
    }
    if (body?.action === "register-source") {
      if (options.sourceConflict && !body.takeover) {
        return reply(409, {
          error: 'jira is served by worker "host-b:ws-12345678"',
          code: "registration_owned_by_other_worker",
          conflicts: [conflict("jira", "source")],
        });
      }
      return reply(200, {
        customerId: "user_1",
        licenseSource: "solo-automation",
        ingestUrl: `${RELAY_URL}/ingest/jira/${"c".repeat(64)}`,
        registrations: [{ kind: "source", key: "jira", createdAt: 1, lastEventAt: null }],
      });
    }
    return reply(404, { error: "not found" });
  }) as typeof fetch;
}

describe("relay worker identity", () => {
  let dir: string;
  let calls: Call[];

  beforeEach(() => {
    dir = join(tmpdir(), `relay-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "state", "code"), { recursive: true });
    calls = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedState(overrides: Partial<RelayConnectState> = {}): void {
    saveRelayState(
      {
        relayUrl: RELAY_URL,
        customerId: "user_1",
        connectedAt: "2026-11-01T00:00:00.000Z",
        registrations: [],
        relayToken: "drt_existing",
        githubRepositories: [{ repo: "acme/web", installationId: 1, repositoryId: 2 }],
        gitlabRepositories: [
          {
            instanceUrl: "https://gitlab.example.com/",
            projectId: "42",
            projectPath: "group/app",
            hookId: 7,
            registrationId: "glr_1",
            connectedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
        sources: [{ source: "linear", team: "growth" }],
        ...overrides,
      },
      dir,
    );
  }

  test("label is the hostname plus a workspace path hash, without control characters", () => {
    const label = relayWorkerLabel("/srv/ws-one", "build\u001b[0m-01");
    expect(label).toMatch(/^build\[0m-01:ws-[0-9a-f]{8}$/);
    expect(relayWorkerLabel("/srv/ws-two", "build-01")).not.toBe(
      relayWorkerLabel("/srv/ws-one", "build-01"),
    );
  });

  test("claims cover the workspace's GitHub repos, GitLab projects, and tracker sources", () => {
    seedState();
    expect(relayWorkerClaims(loadRelayState(dir))).toEqual([
      { kind: "repo", key: "acme/web" },
      { kind: "code-host", key: "gitlab:https://gitlab.example.com:42" },
      { kind: "source", key: "linear", team: "growth" },
    ]);
  });

  test("registers, persists the identity and start cursor owner-only, and reuses it", async () => {
    seedState();
    const result = await registerRelayWorker({
      relayToken: "drt_existing",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, conflictKeys: [] }),
      label: "host-a:ws-00000000",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]?.auth).toBe("Bearer drt_existing");
    expect(calls[0]?.body).toMatchObject({ label: "host-a:ws-00000000" });
    expect(calls[0]?.body?.workerId).toBeUndefined();
    const saved = loadRelayState(dir)!;
    expect(saved.worker).toMatchObject({
      workerId: WORKER_ID,
      label: "host-a:ws-00000000",
      startCursor: 166,
      owned: [{ kind: "repo", key: "acme/web" }],
      conflicts: [],
    });
    expect(statSync(join(dir, "state", "code", "relay.json")).mode & 0o777).toBe(0o600);

    // Reuse: the persisted id goes up, and the creation-time start cursor stays.
    calls.length = 0;
    await registerRelayWorker({
      relayToken: "drt_existing",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, created: false, cursor: 400 }),
      label: "host-a:ws-00000000",
    });
    expect(calls[0]?.body?.workerId).toBe(WORKER_ID);
    expect(loadRelayState(dir)?.worker?.startCursor).toBe(166);
  });

  test("an older relay without per-worker routing is reported as unsupported", async () => {
    seedState();
    const result = await registerRelayWorker({
      relayToken: "drt_existing",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, registerStatus: 404 }),
    });
    expect(result).toEqual({ kind: "unsupported" });
    expect(loadRelayState(dir)?.worker).toBeUndefined();
  });

  test("connect fails with a machine-readable conflict for a repo another worker owns", async () => {
    seedState();
    const outcomes: ConnectOutcome[] = [];
    const code = await connectRelayTarget("github", {
      workingDir: dir,
      repos: ["acme/web"],
      identityOnly: true,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, conflictKeys: ["acme/web"] }),
      getAccessToken: async () => "supa-access",
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(code).toBe(1);
    expect(outcomes[0]).toMatchObject({
      kind: "failed",
      code: "registration_owned_by_other_worker",
      conflicts: [{ key: "acme/web", ownerLabel: "host-b:ws-12345678", lastSeenAt: LAST_SEEN }],
    });
    expect((outcomes[0] as { error: string }).error).toContain("--takeover");
    expect(loadRelayState(dir)?.worker?.conflicts?.[0]?.key).toBe("acme/web");

    // --takeover moves it: the claim goes up with takeover and connect succeeds.
    calls.length = 0;
    outcomes.length = 0;
    const moved = await connectRelayTarget("github", {
      workingDir: dir,
      repos: ["acme/web"],
      identityOnly: true,
      takeover: true,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, conflictKeys: ["acme/web"] }),
      getAccessToken: async () => "supa-access",
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(moved).toBe(0);
    expect(calls.find((call) => call.url.endsWith("/v1/worker/register"))?.body?.takeover).toBe(
      true,
    );
    expect(outcomes[0]).toMatchObject({ kind: "connected", repos: ["acme/web"] });
  });

  test("tracker registration sends the worker id and surfaces a 409 conflict", async () => {
    seedState({ sources: [] });
    const outcomes: ConnectOutcome[] = [];
    const code = await connectRelayTarget("jira", {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, sourceConflict: true }),
      getAccessToken: async () => "supa-access",
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(code).toBe(1);
    const register = calls.find((call) => call.body?.action === "register-source");
    expect(register?.body).toMatchObject({ workerId: WORKER_ID });
    expect(outcomes[0]).toMatchObject({
      kind: "failed",
      code: "registration_owned_by_other_worker",
      conflicts: [{ kind: "source", key: "jira" }],
    });

    calls.length = 0;
    const taken = await connectRelayTarget("jira", {
      workingDir: dir,
      takeover: true,
      relayUrl: RELAY_URL,
      fetchImpl: fakeRelay({ calls, sourceConflict: true }),
      getAccessToken: async () => "supa-access",
    });
    expect(taken).toBe(0);
    expect(calls.find((call) => call.body?.action === "register-source")?.body).toMatchObject({
      workerId: WORKER_ID,
      takeover: true,
    });
    // The workspace remembers the source so its worker claims it on startup.
    expect(loadRelayState(dir)?.sources).toEqual([{ source: "jira" }]);
  });

  test("--takeover parses, validates, and --json reports workerId and conflicts", async () => {
    expect(parseConnectArgs(["github", "--takeover"]).takeover).toBe(true);
    const output: string[] = [];
    const code = await runWorkerConnectCommand(["status", "--takeover", "--json"], {
      workspaceDir: dir,
      writeStdout: (text) => output.push(text),
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.join("")).error).toContain("--takeover is only valid");

    const doc = buildTargetDocument({
      target: "github",
      exitCode: 1,
      outcomes: [
        {
          kind: "failed",
          target: "github",
          error: "acme/web is served by another worker",
          code: "registration_owned_by_other_worker",
          conflicts: [
            {
              kind: "repo",
              key: "acme/web",
              ownerWorkerId: OTHER_ID,
              ownerLabel: "host-b:ws-12345678",
              lastSeenAt: LAST_SEEN,
            },
          ],
        },
      ],
      errorLines: [],
      workspaceSuffix: "",
      workerId: WORKER_ID,
    });
    expect(doc).toEqual({
      target: "github",
      result: "failure",
      error: "acme/web is served by another worker",
      code: "registration_owned_by_other_worker",
      conflicts: [
        {
          kind: "repo",
          key: "acme/web",
          ownerWorkerId: OTHER_ID,
          ownerLabel: "host-b:ws-12345678",
          lastSeenAt: new Date(LAST_SEEN).toISOString(),
        },
      ],
      nextSteps: [
        {
          id: "takeover",
          message: expect.stringContaining("Another worker owns these registrations"),
          command: "devintern worker connect github --takeover --json",
        },
      ],
      workerId: WORKER_ID,
    });
  });

  test("doctor shows this worker's label and owned repos, and warns on conflicts", () => {
    seedState({
      worker: {
        workerId: WORKER_ID,
        label: "host-a:ws-00000000",
        registeredAt: "2026-11-01T00:00:00.000Z",
        startCursor: 0,
        owned: [{ kind: "repo", key: "acme/web" }],
        conflicts: [],
      },
    });
    const ok = relayReadinessCheck(dir, undefined);
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("worker host-a:ws-00000000, owns acme/web");

    const state = loadRelayState(dir)!;
    saveRelayState(
      {
        ...state,
        worker: {
          ...state.worker!,
          conflicts: [
            {
              kind: "repo",
              key: "acme/api",
              ownerWorkerId: OTHER_ID,
              ownerLabel: "host-b:ws-12345678",
              lastSeenAt: LAST_SEEN,
            },
          ],
        },
      },
      dir,
    );
    const warn = relayReadinessCheck(dir, undefined);
    expect(warn.status).toBe("warn");
    expect(warn.detail).toContain('acme/api is served by worker "host-b:ws-12345678"');
    expect(warn.hint).toContain("devintern worker connect github --takeover");

    expect(relayWorkerView(dir)).toMatchObject({
      workerId: WORKER_ID,
      label: "host-a:ws-00000000",
      owned: [{ kind: "repo", key: "acme/web" }],
      conflicts: [{ key: "acme/api", lastSeenAt: new Date(LAST_SEEN).toISOString() }],
    });
    expect(JSON.stringify(relayWorkerView(dir))).not.toContain("drt_");
    expect(readFileSync(join(dir, "state", "code", "relay.json"), "utf8")).toContain(WORKER_ID);
  });
});

describe("RelayAcquirer start cursor and upgrade hint", () => {
  let dir: string;
  let workerState: WorkerState;
  let queue: WebhookQueue;

  beforeEach(() => {
    dir = join(tmpdir(), `relay-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    workerState = new WorkerState(join(dir, "queue.db"));
    queue = new WebhookQueue({ dbPath: join(dir, "queue.db") });
  });

  afterEach(() => {
    workerState.close();
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function pollTwice(
    initialCursor: number | undefined,
    upgrade = false,
  ): Promise<{ urls: string[]; warnings: string[] }> {
    const urls: string[] = [];
    const warnings: string[] = [];
    let polls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      polls++;
      // A real long poll waits; yield so the test's timers can run.
      await Bun.sleep(5);
      return new Response(
        JSON.stringify({
          events: [],
          cursor: 0,
          ...(upgrade ? { upgrade: { code: "per_worker_routing", message: "upgrade me" } } : {}),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      const acquirer = new RelayAcquirer({
        relayUrl: RELAY_URL,
        relayToken: "drt_x",
        workerState,
        queue,
        isAgentPr: () => false,
        handlers: {
          addressPr: async () => true,
          handlePrComment: async () => "skipped",
          evaluateTask: async () => {},
        },
        fetchImpl,
        initialCursor,
      });
      acquirer.start();
      // Let the loop run two polls (the second proves the hint is not repeated).
      while (polls < 2) await Bun.sleep(1);
      await acquirer.stop();
    } finally {
      console.warn = originalWarn;
    }
    return { urls, warnings };
  }

  test("a worker without a cursor starts at the registration head", async () => {
    const { urls } = await pollTwice(166);
    expect(urls[0]).toContain("cursor=166");
    expect(workerState.getCursor(`relay:${RELAY_URL}`)?.cursorValue).toBe("166");
  });

  test("an existing cursor wins over the registration head", async () => {
    workerState.setCursor(`relay:${RELAY_URL}`, "12");
    const { urls } = await pollTwice(166);
    expect(urls[0]).toContain("cursor=12");
  });

  test("without an identity the worker starts at 0, and the upgrade hint is shown once", async () => {
    const { urls, warnings } = await pollTwice(undefined, true);
    expect(urls[0]).toContain("cursor=0");
    expect(warnings.filter((line) => line.includes("upgrade me"))).toHaveLength(1);
  });
});
