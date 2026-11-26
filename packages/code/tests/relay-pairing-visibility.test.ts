import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  connectGitHubRepo,
  describeGitHubPairingFailure,
  loadPendingGitHubPairing,
  pollGitHubPairing,
  savePendingGitHubPairing,
} from "../src/lib/relay/github-pairing";
import type { PendingGitHubPairing } from "../src/lib/relay/github-pairing";
import { relayReadinessCheck } from "../src/lib/observability/relay-readiness";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { relayConfigDir } from "../src/lib/relay/state";

const RELAY_URL = "http://relay.test";

describe("pairing status visibility", () => {
  let dir: string;
  const originalLog = console.log;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-visibility-"));
    logs = [];
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
  });
  afterEach(() => {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  });

  const pairing: PendingGitHubPairing = {
    id: "p1",
    installUrl: "https://github.com/apps/devintern-ai/installations/new?state=x",
    pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/p1`,
    expiresAt: Date.now() + 600_000,
    repos: ["acme/api"],
    relayUrl: RELAY_URL,
  };

  function poll(response: () => Response) {
    return pollGitHubPairing({
      pairing,
      accessToken: "supa-access",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: (async () => response()) as unknown as typeof fetch,
    });
  }

  test("200 pending stays pending; 404 is expired", async () => {
    expect(await poll(() => Response.json({ status: "pending" }))).toEqual({ kind: "pending" });
    expect(await poll(() => new Response("gone", { status: 404 }))).toEqual({ kind: "expired" });
  });

  test.each([
    [401, "relay_unauthorized"],
    [403, "relay_unauthorized"],
    [409, "relay_rejected"],
    [429, "relay_unavailable"],
    [500, "relay_unavailable"],
    [503, "relay_unavailable"],
  ])("HTTP %d is a failure (%s), not pending", async (status, code) => {
    const result = await poll(() => Response.json({ error: "nope" }, { status }));
    expect(result).toEqual({ kind: "failure", code, status, detail: "nope" } as typeof result);
  });

  test("the error body is bounded and redacted", async () => {
    const secret = "ghp_" + "a".repeat(30);
    const result = await poll(
      () => new Response(`boom ${secret} ${"x".repeat(1000)}`, { status: 500 }),
    );
    if (result.kind !== "failure") throw new Error("expected failure");
    expect(result.detail).not.toContain(secret);
    expect(result.detail.length).toBeLessThanOrEqual(210);
  });

  test("failure messages carry the next step", () => {
    const unauthorized = describeGitHubPairingFailure({
      kind: "failure",
      code: "relay_unauthorized",
      status: 401,
      detail: "",
    });
    expect(unauthorized).toContain("devintern worker login <method> --no-wait");
    const down = describeGitHubPairingFailure({
      kind: "failure",
      code: "relay_unavailable",
      status: 503,
      detail: "",
    });
    expect(down).toContain("Retry later");
  });

  describe("blocking connect loop", () => {
    function relayFetch(statuses: Array<number | "complete">, verify: number = 400) {
      let polls = 0;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/pairings/")) {
          const next = statuses[Math.min(polls++, statuses.length - 1)]!;
          if (next === "complete") {
            return Response.json({
              status: "complete",
              customerId: "user_1",
              licenseSource: "solo-automation",
              registrations: [],
              repositories: [{ repo: "acme/api", installationId: 1, repositoryId: 2 }],
            });
          }
          return new Response("{}", { status: next });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
        if (body.action === "issue-token") {
          return Response.json({
            customerId: "user_1",
            licenseSource: "solo-automation",
            relayToken: "drt_x",
          });
        }
        if (body.action === "verify-github-repos") {
          return verify === 400
            ? Response.json({ error: "unsupported action: verify-github-repos" }, { status: 400 })
            : new Response("{}", { status: verify });
        }
        return Response.json({
          customerId: "user_1",
          installUrl: pairing.installUrl,
          pairingStatusUrl: pairing.pairingStatusUrl,
          expiresAt: Date.now() + 600_000,
        });
      }) as typeof fetch;
      return { fetchImpl, polls: () => polls };
    }

    const run = (fetchImpl: typeof fetch) =>
      connectGitHubRepo({
        repos: ["acme/api"],
        accessToken: "supa-access",
        workingDir: dir,
        relayUrl: RELAY_URL,
        fetchImpl,
        sleep: async () => {},
      });

    test("keeps retrying transient 500s within the timeout", async () => {
      const relay = relayFetch([500, 500, "complete"]);
      const state = await run(relay.fetchImpl);
      expect(state.githubRepositories?.[0]?.repo).toBe("acme/api");
      expect(relay.polls()).toBe(3);
    });

    test("stops on 401 and keeps the pairing for a later --status", async () => {
      const relay = relayFetch([401]);
      await expect(run(relay.fetchImpl)).rejects.toThrow(/session/i);
      expect(relay.polls()).toBe(1);
      expect(loadPendingGitHubPairing(dir)).not.toBeNull();
    });

    test("logs why a browser is needed when verification is unsupported (400)", async () => {
      await run(relayFetch(["complete"]).fetchImpl);
      expect(logs.join("\n")).toContain("cannot verify GitHub repositories without a browser");
    });

    test("logs why a browser is needed when the relay is not configured (503)", async () => {
      await run(relayFetch(["complete"], 503).fetchImpl);
      expect(logs.join("\n")).toContain("cannot verify GitHub repositories without a browser");
    });
  });

  describe("doctor Relay row", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "linear"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`);

    function writeRelayState(repos: string[]): void {
      mkdirSync(relayConfigDir(dir), { recursive: true });
      writeFileSync(
        join(relayConfigDir(dir), "relay.json"),
        JSON.stringify({
          relayUrl: RELAY_URL,
          customerId: "user_1",
          connectedAt: new Date().toISOString(),
          relayToken: "drt_x",
          registrations: [],
          githubRepositories: repos.map((repo, i) => ({
            repo,
            installationId: 1,
            repositoryId: i + 1,
          })),
        }),
      );
    }

    test("not configured is a passing polling-only row", () => {
      const check = relayReadinessCheck(dir, config);
      expect(check).toMatchObject({ id: "relay", label: "Relay", status: "ok" });
      expect(check.detail).toContain("polling only");
    });

    test("paired lists the repo count and relay URL", () => {
      writeRelayState(["acme/api", "acme/web"]);
      const check = relayReadinessCheck(dir, config);
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("2 GitHub repositories");
      expect(check.detail).toContain(RELAY_URL);
    });

    test("pending pairing warns with the status command", () => {
      savePendingGitHubPairing(pairing, dir);
      const check = relayReadinessCheck(dir, config);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("pairing pending since");
      expect(check.hint).toContain("devintern worker connect github --status");
    });

    test("configured repos the relay does not cover warn", () => {
      writeRelayState(["acme/api"]);
      const check = relayReadinessCheck(dir, config);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("acme/web");
      expect(check.detail).not.toContain("acme/api");
    });
  });
});
