import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  beginGitLabRelayRegistration,
  completeGitLabRelayRegistration,
  connectRelayTarget,
  connectGitHubRepo,
  ensureRelayToken,
  fetchRelayStatus,
  hasGitHubRelayRegistration,
  hasGitHubRelayRouting,
  loadRelayState,
  removeGitLabRelayRegistration,
  registerRelaySource,
  saveRelayState,
} from "../src/lib/relay-connect";
import type { RelayConnectState } from "../src/lib/relay-connect";

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

  test("central App mode requires verified immutable ids, not a legacy repo registration", () => {
    const state: RelayConnectState = {
      relayUrl: RELAY_URL,
      customerId: "user_1",
      connectedAt: new Date(0).toISOString(),
      relayToken: "drt_test",
      registrations: [],
    };
    expect(hasGitHubRelayRegistration(state)).toBe(false);
    state.registrations.push({
      kind: "repo",
      key: "acme/widgets",
      createdAt: 0,
      lastEventAt: null,
    });
    expect(hasGitHubRelayRegistration(state)).toBe(false);
    state.github = { repo: "acme/widgets", installationId: 7001, repositoryId: 9001 };
    expect(hasGitHubRelayRegistration(state)).toBe(true);
    expect(hasGitHubRelayRegistration(state, "ACME/WIDGETS")).toBe(true);
    expect(hasGitHubRelayRegistration(state, "acme/other")).toBe(false);
  });

  test("runtime relay routing preserves a live legacy repo registration", () => {
    const state: RelayConnectState = {
      relayUrl: RELAY_URL,
      customerId: "user_1",
      connectedAt: new Date(0).toISOString(),
      relayToken: "drt_test",
      registrations: [{ kind: "repo", key: "acme/widgets", createdAt: 0, lastEventAt: Date.now() }],
    };

    expect(hasGitHubRelayRegistration(state)).toBe(false);
    expect(hasGitHubRelayRouting(state)).toBe(true);
    expect(hasGitHubRelayRouting(state, "ACME/WIDGETS")).toBe(true);
    expect(hasGitHubRelayRouting(state, "acme/other")).toBe(false);
  });

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
    expect(statSync(join(dir, ".devintern-code", "relay.json")).mode & 0o777).toBe(0o600);
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

  test("token rotation for another customer drops the previous GitHub associations", async () => {
    saveRelayState(
      {
        relayUrl: RELAY_URL,
        customerId: "user_1",
        connectedAt: new Date(0).toISOString(),
        relayToken: "drt_old",
        registrations: [{ kind: "repo", key: "acme/api", createdAt: 1, lastEventAt: null }],
        github: { repo: "acme/api", installationId: 7001, repositoryId: 9001 },
        githubRepositories: [{ repo: "acme/api", installationId: 7001, repositoryId: 9001 }],
      },
      dir,
    );
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            customerId: "user_2",
            licenseSource: "solo-automation",
            relayToken: "drt_new",
          }),
          { status: 200 },
        ),
    );

    const { state } = await ensureRelayToken("other-supa-access", {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
      force: true,
    });

    expect(state.customerId).toBe("user_2");
    expect(state.registrations).toEqual([]);
    expect(state.github).toBeUndefined();
    expect(state.githubRepositories).toBeUndefined();
    expect(state.gitlabRepositories).toBeUndefined();
    expect(hasGitHubRelayRegistration(state)).toBe(false);
  });

  test("GitLab registration lifecycle persists identity but never signing material", async () => {
    const signingToken = "whsec_standard-secret";
    const legacySecret = "legacy-secret";
    const fetchImpl = mockFetch((_url, body) => {
      const action = (body as { action: string }).action;
      if (action === "issue-token") {
        return new Response(
          JSON.stringify({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_gitlab",
          }),
          { status: 200 },
        );
      }
      if (action === "begin-gitlab-registration") {
        return new Response(
          JSON.stringify({
            registrationId: "glr_1",
            ingestUrl: "https://relay.test/ingest/gitlab/route",
            signingToken,
            legacySecret,
            expiresAt: Date.now() + 60_000,
          }),
          { status: 200 },
        );
      }
      if (action === "complete-gitlab-registration") {
        return new Response(
          JSON.stringify({
            registration: {
              provider: "gitlab",
              instanceUrl: "https://gitlab.example.com",
              projectId: "42",
              projectPath: "platform/widgets",
              registrationId: "glr_1",
              status: "active",
              hookId: 7,
              activatedAt: 1234,
            },
          }),
          { status: 200 },
        );
      }
      expect(action).toBe("remove-gitlab-registration");
      return new Response(JSON.stringify({ removed: true }), { status: 200 });
    });

    const begun = await beginGitLabRelayRegistration({
      instanceUrl: "https://gitlab.example.com",
      projectId: "42",
      projectPath: "platform/widgets",
      accessToken: "supa-access",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });
    expect(begun.signingToken).toBe(signingToken);
    expect(begun.legacySecret).toBe(legacySecret);

    const state = await completeGitLabRelayRegistration({
      registrationId: begun.registrationId,
      hookId: 7,
      instanceUrl: "https://gitlab.example.com/",
      projectId: "42",
      projectPath: "platform/widgets",
      accessToken: "supa-access",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });
    expect(state.gitlabRepositories).toEqual([
      {
        instanceUrl: "https://gitlab.example.com",
        projectId: "42",
        projectPath: "platform/widgets",
        hookId: 7,
        registrationId: "glr_1",
        connectedAt: expect.any(String),
      },
    ]);
    const persisted = readFileSync(join(dir, ".devintern-code", "relay.json"), "utf8");
    expect(persisted).not.toContain(signingToken);
    expect(persisted).not.toContain(legacySecret);

    expect(
      await removeGitLabRelayRegistration({
        registrationId: "glr_1",
        accessToken: "supa-access",
        workingDir: dir,
        relayUrl: RELAY_URL,
        fetchImpl,
      }),
    ).toBe(true);
    expect(loadRelayState(dir)?.gitlabRepositories).toEqual([]);
    expect(calls.map((call) => (call.body as { action: string }).action)).toEqual([
      "issue-token",
      "begin-gitlab-registration",
      "complete-gitlab-registration",
      "remove-gitlab-registration",
    ]);
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
    expect(state.githubRepositories).toEqual([
      { repo: "acme/webapp", installationId: 7001, repositoryId: 9001 },
    ]);
    expect(calls.filter((c) => c.body).map((c) => (c.body as { action: string }).action)).toEqual([
      "issue-token",
      "begin-github-pairing",
    ]);
    expect(calls.every((c) => c.auth === "Bearer supa-access")).toBe(true);
  });

  test("connectGitHubRepo preserves verified associations for multiple repositories", async () => {
    let pairingRepo = "";
    const verified = new Map([
      ["acme/api", { installationId: 7001, repositoryId: 9001 }],
      ["acme/web", { installationId: 7001, repositoryId: 9002 }],
    ]);
    const fetchImpl = mockFetch((url, body) => {
      if (url.includes("/v1/github/pairings/")) {
        const ids = verified.get(pairingRepo)!;
        return new Response(
          JSON.stringify({
            status: "complete",
            customerId: "user_1",
            licenseSource: "solo-automation",
            repo: pairingRepo,
            ...ids,
            registrations: [...verified.keys()].map((key) => ({
              kind: "repo",
              key,
              createdAt: 1,
              lastEventAt: null,
            })),
          }),
          { status: 200 },
        );
      }
      const request = body as { action: string; repo?: string };
      if (request.action === "issue-token") {
        return new Response(
          JSON.stringify({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_multi",
          }),
          { status: 200 },
        );
      }
      pairingRepo = request.repo!.toLowerCase();
      return new Response(
        JSON.stringify({
          installUrl: `https://github.com/apps/devintern-ai/installations/new?state=${pairingRepo}`,
          pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/${pairingRepo}`,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200 },
      );
    });

    await connectGitHubRepo({
      repo: "acme/api",
      accessToken: "supa-access",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });
    const state = await connectGitHubRepo({
      repo: "acme/web",
      accessToken: "supa-access",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
    });

    expect(state.githubRepositories).toEqual([
      { repo: "acme/api", installationId: 7001, repositoryId: 9001 },
      { repo: "acme/web", installationId: 7001, repositoryId: 9002 },
    ]);
    expect(hasGitHubRelayRegistration(state, "acme/api")).toBe(true);
    expect(hasGitHubRelayRegistration(state, "acme/web")).toBe(true);
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

  test("connectRelayTarget requires a signed-in session", async () => {
    const code = await connectRelayTarget("github", {
      repo: "acme/web",
      workingDir: dir,
      getAccessToken: async () => {
        throw new Error("Not authenticated. Run `devintern login` first.");
      },
    });
    expect(code).toBe(1);
  });

  test("connectRelayTarget github path mints a token and registers the repo", async () => {
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

    const code = await connectRelayTarget("github", {
      repo: "acme/web",
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
    ) as { repositories: Array<{ installationId: number; repositoryId: number }> };
    expect(appRecord.repositories[0]?.installationId).toBe(7001);
    expect(appRecord.repositories[0]?.repositoryId).toBe(9001);
  });

  test("connectRelayTarget installs, tests, and activates a GitLab project hook", async () => {
    const adminCalls: string[] = [];
    const fetchImpl = mockFetch((_url, body) => {
      const action = (body as { action: string }).action;
      if (action === "issue-token") {
        return new Response(
          JSON.stringify({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_gitlab_target",
          }),
          { status: 200 },
        );
      }
      if (action === "begin-gitlab-registration") {
        return new Response(
          JSON.stringify({
            registrationId: "glr_target",
            ingestUrl: "https://relay.test/ingest/gitlab/route",
            signingToken: "whsec_target",
            legacySecret: "legacy-target",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 200 },
        );
      }
      if (action === "remove-gitlab-registration") {
        return new Response(JSON.stringify({ removed: true }), { status: 200 });
      }
      expect(action).toBe("complete-gitlab-registration");
      return new Response(
        JSON.stringify({
          registration: {
            provider: "gitlab",
            instanceUrl: "https://gitlab.example.com",
            projectId: "42",
            projectPath: "Platform/Widgets",
            registrationId: "glr_target",
            status: "active",
            hookId: 7,
            activatedAt: 1234,
          },
        }),
        { status: 200 },
      );
    });

    const result = await connectRelayTarget("gitlab", {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
      getAccessToken: async () => "supa-access",
      env: { GITLAB_WEBHOOK_ADMIN_TOKEN: "admin-token" },
      gitlabProject: {
        instanceUrl: "https://gitlab.example.com",
        projectPath: "platform/widgets",
      },
      gitlabAdmin: {
        async resolveMaintainedProject(path) {
          adminCalls.push(`resolve:${path}`);
          return { id: 42, path: "Platform/Widgets", accessLevel: 40 };
        },
        async upsertRelayHook(projectId, config, existingHookId) {
          adminCalls.push(
            `upsert:${projectId}:${config.signingToken}:${config.legacySecret}:${existingHookId ?? "new"}`,
          );
          return {
            hook: { id: 7, url: config.ingestUrl, name: "DevIntern Relay" },
            standardSigning: true,
          };
        },
        async testHook(projectId, hookId) {
          adminCalls.push(`test:${projectId}:${hookId}`);
        },
        async deleteHook(projectId, hookId) {
          adminCalls.push(`delete:${projectId}:${hookId}`);
          return true;
        },
      },
    });

    expect(result).toBe(0);
    expect(adminCalls).toEqual([
      "resolve:platform/widgets",
      "upsert:42:whsec_target:legacy-target:new",
      "test:42:7",
    ]);
    expect(loadRelayState(dir)?.gitlabRepositories?.[0]).toMatchObject({
      instanceUrl: "https://gitlab.example.com",
      projectId: "42",
      projectPath: "Platform/Widgets",
      hookId: 7,
      registrationId: "glr_target",
    });

    const disconnected = await connectRelayTarget("gitlab", {
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl,
      getAccessToken: async () => "supa-access",
      env: { GITLAB_WEBHOOK_ADMIN_TOKEN: "admin-token" },
      disconnectGitLab: true,
      gitlabProject: {
        instanceUrl: "https://gitlab.example.com",
        projectPath: "platform/widgets",
      },
      gitlabAdmin: {
        async resolveMaintainedProject(path) {
          adminCalls.push(`resolve:${path}`);
          return { id: 42, path: "Platform/Widgets", accessLevel: 40 };
        },
        async upsertRelayHook() {
          throw new Error("disconnect must not upsert");
        },
        async testHook() {
          throw new Error("disconnect must not test");
        },
        async deleteHook(projectId, hookId) {
          adminCalls.push(`delete:${projectId}:${hookId}`);
          return true;
        },
      },
    });
    expect(disconnected).toBe(0);
    expect(adminCalls.slice(-2)).toEqual(["resolve:platform/widgets", "delete:42:7"]);
    expect(loadRelayState(dir)?.gitlabRepositories).toEqual([]);
  });
});
