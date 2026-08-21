import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadRelayState, runWorkerConnect } from "../src/lib/relay-connect";
import {
  loadWorkspaceRelayState,
  resolveFleetRelayCredentials,
  runWorkspaceConnect,
  workspaceRepoSlugs,
} from "../src/lib/workspace/connect";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

const RELAY_URL = "http://relay.test";

const WORKSPACE_TOML = `
[defaults]
tracker = "jira"
task_query = "labels = devintern"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "https://github.com/acme/frontend"

[[repos]]
name = "lib"
remote = "git@gitlab.com:acme/lib.git"
`;

function makeWorkspace(): string {
  const dir = join(tmpdir(), `ws-relay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.toml"), WORKSPACE_TOML);
  return dir;
}

interface RecordedCall {
  url: string;
  auth: string | null;
  body: unknown;
}

function mockFetch(
  calls: RecordedCall[],
  handler: (url: string, body: unknown) => Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, auth, body });
    return handler(url, body);
  }) as typeof fetch;
}

/** Standard relay mock: mints tokens, then echoes cumulative registrations. */
function tokenThenRegistrations(calls: RecordedCall[], relayToken: string): typeof fetch {
  let issued = 0;
  const registrations: Array<{ kind: string; key: string; createdAt: number; lastEventAt: null }> =
    [];
  return mockFetch(calls, (_url, body) => {
    const action = (body as { action?: string }).action;
    if (action === "issue-token") {
      issued++;
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "team-automation",
          relayToken: `${relayToken}-${issued}`,
        }),
        { status: 200 },
      );
    }
    if (action === "register-repo") {
      const repo = (body as { repo: string }).repo.toLowerCase();
      if (!registrations.some((r) => r.kind === "repo" && r.key === repo)) {
        registrations.push({ kind: "repo", key: repo, createdAt: 1, lastEventAt: null });
      }
      return respond(registrations);
    }
    if (action === "register-source") {
      const source = (body as { source: string }).source;
      if (!registrations.some((r) => r.kind === "source" && r.key === source)) {
        registrations.push({ kind: "source", key: source, createdAt: 1, lastEventAt: null });
      }
      return new Response(
        JSON.stringify({
          customerId: "user_1",
          licenseSource: "team-automation",
          ingestUrl: `${RELAY_URL}/ingest/${source}/secret`,
          registrations,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "unexpected action" }), { status: 400 });
  });
}

function respond(
  registrations: Array<{ kind: string; key: string; createdAt: number; lastEventAt: null }>,
): Response {
  return new Response(
    JSON.stringify({
      customerId: "user_1",
      licenseSource: "team-automation",
      registrations,
    }),
    { status: 200 },
  );
}

describe("workspace connect", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeWorkspace();
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("registers every GitHub repo and stores state at <workspaceDir>/relay.json", async () => {
    const calls: RecordedCall[] = [];
    const code = await runWorkspaceConnect(["github"], {
      workspaceDir,
      getAccessToken: async () => "supa-access",
      relayUrl: RELAY_URL,
      fetchImpl: tokenThenRegistrations(calls, "drt_ws"),
    });

    expect(code).toBe(0);
    expect(existsSync(join(workspaceDir, ".devintern-code"))).toBe(false);
    const saved = JSON.parse(readFileSync(join(workspaceDir, "relay.json"), "utf8")) as {
      relayToken: string;
      registrations: Array<{ kind: string; key: string }>;
    };
    expect(saved.relayToken).toBe("drt_ws-1");
    expect(saved.registrations.map((r) => r.key).sort()).toEqual(["acme/backend", "acme/frontend"]);

    const repos = calls
      .map((c) => (c.body as { repo?: string }).repo)
      .filter((repo): repo is string => Boolean(repo));
    expect(repos).toEqual(["acme/backend", "acme/frontend"]);
    expect(calls.every((c) => c.auth === "Bearer supa-access")).toBe(true);
    // The non-GitHub remote is skipped with a clear message.
    expect(calls.some((c) => JSON.stringify(c.body).includes("gitlab"))).toBe(false);
  });

  test("re-connect is idempotent; --force re-mints the token", async () => {
    const deps = {
      workspaceDir,
      getAccessToken: async () => "supa-access",
      relayUrl: RELAY_URL,
    };
    const calls: RecordedCall[] = [];

    await runWorkspaceConnect(["github"], {
      ...deps,
      fetchImpl: tokenThenRegistrations(calls, "drt_a"),
    });
    expect(loadWorkspaceRelayState(workspaceDir)?.relayToken).toBe("drt_a-1");

    // Second connect reuses the stored token: no new issue-token call.
    calls.length = 0;
    await runWorkspaceConnect(["github"], {
      ...deps,
      fetchImpl: tokenThenRegistrations(calls, "drt_b"),
    });
    expect(
      calls.filter((c) => (c.body as { action?: string }).action === "issue-token"),
    ).toHaveLength(0);
    expect(loadWorkspaceRelayState(workspaceDir)?.relayToken).toBe("drt_a-1");

    // --force re-mints and replaces the stored token.
    calls.length = 0;
    await runWorkspaceConnect(["github", "--force"], {
      ...deps,
      fetchImpl: tokenThenRegistrations(calls, "drt_c"),
    });
    expect(
      calls.filter((c) => (c.body as { action?: string }).action === "issue-token"),
    ).toHaveLength(1);
    expect(loadWorkspaceRelayState(workspaceDir)?.relayToken).toBe("drt_c-1");
  });

  test("tracker target registers a source into the workspace state file", async () => {
    const calls: RecordedCall[] = [];
    const code = await runWorkspaceConnect(["jira"], {
      workspaceDir,
      getAccessToken: async () => "supa-access",
      relayUrl: RELAY_URL,
      fetchImpl: tokenThenRegistrations(calls, "drt_jira"),
    });

    expect(code).toBe(0);
    expect(
      calls.filter((c) => (c.body as { action?: string }).action === "register-source"),
    ).toHaveLength(1);
    const saved = loadWorkspaceRelayState(workspaceDir);
    expect(saved?.relayToken).toBe("drt_jira-1");
    expect(saved?.registrations[0]?.kind).toBe("source");
    expect(saved?.registrations[0]?.key).toBe("jira");
  });

  test("status authenticates with the stored drt_ token and flags unregistered repos", async () => {
    const connectCalls: RecordedCall[] = [];
    await runWorkspaceConnect(["github"], {
      workspaceDir,
      getAccessToken: async () => "supa-access",
      relayUrl: RELAY_URL,
      fetchImpl: tokenThenRegistrations(connectCalls, "drt_status"),
    });

    // Only backend registered server-side so far.
    const statusCalls: RecordedCall[] = [];
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
    try {
      const code = await runWorkspaceConnect(["status"], {
        workspaceDir,
        getAccessToken: async () => "supa-access",
        relayUrl: RELAY_URL,
        fetchImpl: mockFetch(
          statusCalls,
          () =>
            new Response(
              JSON.stringify({
                customerId: "user_1",
                licenseSource: "team-automation",
                buffered: 3,
                registrations: [
                  { kind: "repo", key: "acme/backend", createdAt: 1, lastEventAt: 42 },
                ],
              }),
              { status: 200 },
            ),
        ),
      });
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(statusCalls[0].url).toContain("/v1/status");
    expect(statusCalls[0].auth).toBe("Bearer drt_status-1");
    const output = lines.join("\n");
    expect(output).toContain("Buffered envelopes: 3");
    expect(output).toContain("Not registered yet: acme/frontend");
  });

  test("fails cleanly without a workspace or a session", async () => {
    const empty = join(
      tmpdir(),
      `ws-relay-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(empty, { recursive: true });
    try {
      const code = await runWorkspaceConnect(["github"], {
        workspaceDir: empty,
        getAccessToken: async () => "supa-access",
        relayUrl: RELAY_URL,
      });
      expect(code).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    const code = await runWorkspaceConnect(["github"], {
      workspaceDir,
      getAccessToken: async () => {
        throw new Error("Not authenticated. Run `devintern login` first.");
      },
      relayUrl: RELAY_URL,
    });
    expect(code).toBe(1);
  });

  test("worker loads workspace relay state over a checkout-local state file", async () => {
    // No workspace pairing yet: fall back to the cwd checkout state.
    const checkoutDir = join(
      tmpdir(),
      `ws-relay-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(checkoutDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(checkoutDir, ".devintern-code", "relay.json"),
      JSON.stringify({
        relayUrl: RELAY_URL,
        customerId: "user_1",
        connectedAt: "",
        registrations: [],
        relayToken: "drt_checkout",
      }),
    );

    const fallback = resolveFleetRelayCredentials({ workspaceDir, cwd: checkoutDir });
    // No workspace pairing yet, so the legacy checkout state is the fallback.
    expect(fallback.relayToken).toBe("drt_checkout");

    await runWorkspaceConnect(["github"], {
      workspaceDir,
      getAccessToken: async () => "supa-access",
      relayUrl: RELAY_URL,
      fetchImpl: tokenThenRegistrations([], "drt_fleet"),
    });

    // Workspace pairing wins once it exists.
    const fleet = resolveFleetRelayCredentials({ workspaceDir, cwd: checkoutDir });
    expect(fleet.relayToken).toBe("drt_fleet-1");
    expect(fleet.relayUrl).toBe(RELAY_URL);

    // A workspace with its own pairing never reads the checkout state.
    expect(resolveFleetRelayCredentials({ workspaceDir }).relayToken).toBe("drt_fleet-1");

    // Sanity: single-repo loading still reads the checkout-local path.
    expect(loadRelayState(checkoutDir)?.relayToken).toBe("drt_checkout");
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  test("workspaceRepoSlugs prefers [repos.env].GITHUB_REPO and skips non-GitHub remotes", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"

[[repos]]
name = "explicit"
remote = "git@github.com:wrong/slug.git"
  [repos.env]
  GITHUB_REPO = "acme/actual"

[[repos]]
name = "parsed"
remote = "git@github.com:acme/parsed.git"

[[repos]]
name = "other"
remote = "git@gitlab.com:acme/other.git"
`);
    const bySlug = workspaceRepoSlugs(config);
    expect(bySlug.map((entry) => entry.slug)).toEqual(["acme/actual", "acme/parsed", null]);
  });

  test("single-repo worker connect still writes .devintern-code/relay.json", async () => {
    const projectDir = join(
      tmpdir(),
      `ws-relay-single-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(projectDir, ".devintern-code"), { recursive: true });
    const calls: RecordedCall[] = [];
    try {
      const code = await runWorkerConnect(
        ["github", "--repo", "acme/web"],
        async () => "acme/web",
        {
          workingDir: projectDir,
          relayUrl: RELAY_URL,
          fetchImpl: tokenThenRegistrations(calls, "drt_single"),
          getAccessToken: async () => "supa-access",
        },
      );
      expect(code).toBe(0);
      expect(loadWorkspaceRelayState(projectDir)).toBeNull();
      const saved = JSON.parse(
        readFileSync(join(projectDir, ".devintern-code", "relay.json"), "utf8"),
      ) as { relayToken: string };
      expect(saved.relayToken).toBe("drt_single-1");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
