import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  connectGitHubRepo,
  ensureRelayToken,
  fetchRelayStatus,
  loadRelayState,
  registerRelaySource,
  runWorkerConnect,
} from "../src/lib/relay-connect";

const RELAY_URL = "http://relay.test";

describe("relay-connect auth", () => {
  let dir: string;
  let calls: Array<{ url: string; auth: string | null; body: unknown }>;

  beforeEach(() => {
    dir = join(tmpdir(), `relay-connect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, ".devintern-code"), { recursive: true });
    calls = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function mockFetch(handler: (url: string, body: unknown) => Response): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, auth, body });
      return handler(url, body);
    }) as typeof fetch;
  }

  test("ensureRelayToken mints with the Supabase session and stores drt_ token", async () => {
    const fetchImpl = mockFetch((_url, body) => {
      expect((body as { action: string }).action).toBe("issue-token");
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "solo-automation",
          relayToken: "drt_minted_abc",
        }),
        { status: 200 },
      );
    });

    const { relayToken, state } = await ensureRelayToken("supa-access", {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });

    expect(relayToken).toBe("drt_minted_abc");
    expect(state.customerId).toBe("user_1");
    expect(loadRelayState(dir)?.relayToken).toBe("drt_minted_abc");
    expect(calls[0].auth).toBe("Bearer supa-access");

    // Second call reuses the stored token (no re-mint).
    calls.length = 0;
    const again = await ensureRelayToken("supa-access", {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });
    expect(again.relayToken).toBe("drt_minted_abc");
    expect(calls.length).toBe(0);
  });

  test("connectGitHubRepo waits for verified GitHub App pairing", async () => {
    const fetchImpl = mockFetch((url, body) => {
      if (url.includes("/v1/github/pairings/")) {
        return new Response(
          JSON.stringify({
            status: "complete",
            customerId: "user_1",
            licenseSource: "solo-automation",
            repo: "Acme/WebApp",
            installationId: 7001,
            repositoryId: 9001,
            registrations: [{ kind: "repo", key: "acme/webapp", createdAt: 1, lastEventAt: null }],
          }),
          { status: 200 },
        );
      }
      const action = (body as { action: string }).action;
      if (action === "issue-token") {
        return new Response(
          JSON.stringify({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_repo_1",
          }),
          { status: 200 },
        );
      }
      expect(action).toBe("begin-github-pairing");
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "solo-automation",
          installUrl: "https://github.com/apps/devintern-ai/installations/new?state=abc",
          pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/abc`,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200 },
      );
    });

    const state = await connectGitHubRepo({
      repo: "Acme/WebApp",
      accessToken: "supa-access",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });

    expect(state.relayToken).toBe("drt_repo_1");
    expect(state.registrations[0]?.key).toBe("acme/webapp");
    expect(state.github?.repositoryId).toBe(9001);
    expect(calls.filter((c) => c.body).map((c) => (c.body as { action: string }).action)).toEqual([
      "issue-token",
      "begin-github-pairing",
    ]);
    expect(calls.every((c) => c.auth === "Bearer supa-access")).toBe(true);
  });

  test("registerRelaySource returns an ingest URL and keeps the relay token", async () => {
    const fetchImpl = mockFetch((url, body) => {
      if (url.includes("/v1/github/pairings/")) {
        return new Response(
          JSON.stringify({
            status: "complete",
            customerId: "user_1",
            licenseSource: "solo-automation",
            repo: "acme/web",
            installationId: 7001,
            repositoryId: 9001,
            registrations: [{ kind: "repo", key: "acme/web", createdAt: 1, lastEventAt: null }],
          }),
          { status: 200 },
        );
      }
      const action = (body as { action: string }).action;
      if (action === "issue-token") {
        return new Response(
          JSON.stringify({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_src_1",
          }),
          { status: 200 },
        );
      }
      expect(action).toBe("register-source");
      expect((body as { source: string; secret?: string }).source).toBe("linear");
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "solo-automation",
          ingestUrl: `${RELAY_URL}/ingest/linear/${"a".repeat(64)}`,
          registrations: [{ kind: "source", key: "linear", createdAt: 1, lastEventAt: null }],
        }),
        { status: 200 },
      );
    });

    const { ingestUrl, state } = await registerRelaySource({
      source: "linear",
      accessToken: "supa-access",
      secret: "lin-sec",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });

    expect(ingestUrl).toContain("/ingest/linear/");
    expect(state.relayToken).toBe("drt_src_1");
  });

  test("fetchRelayStatus authenticates with the relay token, not the session", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/v1/status");
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "solo-automation",
          buffered: 0,
          registrations: [],
        }),
        { status: 200 },
      );
    });

    await fetchRelayStatus({
      relayToken: "drt_status",
      relayUrl: RELAY_URL,
      fetchImpl,
    });
    expect(calls[0].auth).toBe("Bearer drt_status");
  });

  test("runWorkerConnect requires a signed-in session", async () => {
    const code = await runWorkerConnect(["github", "--repo", "acme/web"], async () => "acme/web", {
      workingDir: dir,
      getAccessToken: async () => {
        throw new Error("Not authenticated. Run `devintern login` first.");
      },
    });
    expect(code).toBe(1);
  });

  test("runWorkerConnect github path mints a token and registers the repo", async () => {
    const fetchImpl = mockFetch((url, body) => {
      if (url.includes("/v1/github/pairings/")) {
        return new Response(
          JSON.stringify({
            status: "complete",
            customerId: "user_1",
            licenseSource: "solo-automation",
            repo: "acme/web",
            installationId: 7001,
            repositoryId: 9001,
            registrations: [{ kind: "repo", key: "acme/web", createdAt: 1, lastEventAt: null }],
          }),
          { status: 200 },
        );
      }
      const action = (body as { action: string }).action;
      if (action === "issue-token") {
        return new Response(
          JSON.stringify({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_cli_1",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "solo-automation",
          installUrl: "https://github.com/apps/devintern-ai/installations/new?state=abc",
          pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/abc`,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200 },
      );
    });

    const code = await runWorkerConnect(["github", "--repo", "acme/web"], async () => null, {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
      getAccessToken: async () => "supa-access",
    });
    expect(code).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, ".devintern-code", "relay.json"), "utf8")) as {
      relayToken: string;
    };
    expect(saved.relayToken).toBe("drt_cli_1");
    const appRecord = JSON.parse(
      readFileSync(join(dir, ".devintern-code", "github-app.json"), "utf8"),
    ) as { installationId: number; repositoryId: number };
    expect(appRecord.installationId).toBe(7001);
    expect(appRecord.repositoryId).toBe(9001);
  });
});
