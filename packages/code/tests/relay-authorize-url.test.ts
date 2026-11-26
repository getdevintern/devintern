import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildTargetDocument } from "../src/lib/init/worker-connect-json";
import {
  loadPendingGitHubPairing,
  parseAuthorizeUrl,
  startGitHubRepoPairing,
} from "../src/lib/relay/github-pairing";
import type { PendingGitHubPairing } from "../src/lib/relay/github-pairing";
import { connectRelayTarget } from "../src/lib/relay/connect";

const RELAY_URL = "http://relay.test";
const INSTALL_URL = "https://github.com/apps/devintern-ai/installations/new?state=abc";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize?client_id=x&state=abc";

describe("GitHub pairing authorizeUrl", () => {
  let dir: string;
  let logs: string[];
  const originalLog = console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-authorize-"));
    logs = [];
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
  });
  afterEach(() => {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  });

  function relay(extra: Record<string, unknown>, unverifiedReason?: string): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "issue-token") {
        return Response.json({
          customerId: "user_1",
          licenseSource: "solo-automation",
          relayToken: "drt_x",
        });
      }
      if (body.action === "verify-github-repos") {
        if (!unverifiedReason) {
          return Response.json(
            { error: "unsupported action: verify-github-repos" },
            { status: 400 },
          );
        }
        return Response.json({
          customerId: "user_1",
          licenseSource: "solo-automation",
          registrations: [],
          repositories: [],
          unverified: [{ repo: "acme/api", reason: unverifiedReason }],
        });
      }
      return Response.json({
        customerId: "user_1",
        installUrl: INSTALL_URL,
        pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/p1`,
        expiresAt: Date.now() + 600_000,
        ...extra,
      });
    }) as typeof fetch;
  }

  async function begin(extra: Record<string, unknown>, reason?: string) {
    const start = await startGitHubRepoPairing({
      repos: ["acme/api"],
      accessToken: "supa",
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: relay(extra, reason),
    });
    if (start.kind !== "pending") throw new Error("expected pending");
    return start.pairing;
  }

  async function connectText(extra: Record<string, unknown>, noWait: boolean) {
    // Blocking mode polls until the pairing expires; the poll answer is a
    // relay error that stops the loop after the URLs were printed.
    const fetchImpl = relay(extra);
    await connectRelayTarget("github", {
      repos: ["acme/api"],
      workingDir: dir,
      relayUrl: RELAY_URL,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes("/pairings/")
          ? new Response("{}", { status: 401 })
          : fetchImpl(input, init)) as typeof fetch,
      getAccessToken: async () => "supa",
      noWait,
      sleep: async () => {},
    } as Parameters<typeof connectRelayTarget>[1]);
    return logs.join("\n");
  }

  test("parseAuthorizeUrl accepts github.com https only", () => {
    expect(parseAuthorizeUrl(AUTHORIZE_URL)).toBe(AUTHORIZE_URL);
    expect(parseAuthorizeUrl("http://github.com/login")).toBeUndefined();
    expect(parseAuthorizeUrl("https://evil.example/github.com")).toBeUndefined();
    expect(parseAuthorizeUrl("https://notgithub.com/x")).toBeUndefined();
    expect(parseAuthorizeUrl("not a url")).toBeUndefined();
    expect(parseAuthorizeUrl(42)).toBeUndefined();
  });

  test("older relay: neither field, behaviour unchanged", async () => {
    const pairing = await begin({});
    expect(pairing.authorizeUrl).toBeUndefined();
    expect(pairing.appInstalled).toBeUndefined();
    const text = await connectText({}, true);
    expect(text).toContain(INSTALL_URL);
    expect(text).not.toContain("authorize it");
    expect(text).not.toContain("open this to finish");
  });

  test("invalid authorizeUrl is ignored along with appInstalled", async () => {
    const pairing = await begin({ authorizeUrl: "https://evil.example/x", appInstalled: true });
    expect(pairing.authorizeUrl).toBeUndefined();
    expect(pairing.appInstalled).toBeUndefined();
  });

  test("pending pairing round-trips through the saved file", async () => {
    const pairing = await begin({ authorizeUrl: AUTHORIZE_URL, appInstalled: false });
    const loaded = loadPendingGitHubPairing(dir);
    expect(loaded).toEqual(pairing);
    expect(loaded?.authorizeUrl).toBe(AUTHORIZE_URL);
    expect(loaded?.appInstalled).toBe(false);
  });

  for (const noWait of [true, false]) {
    describe(noWait ? "--no-wait text" : "blocking text", () => {
      test("appInstalled true leads with the authorize step", async () => {
        const text = await connectText({ authorizeUrl: AUTHORIZE_URL, appInstalled: true }, noWait);
        expect(text).toContain(
          "The DevIntern App is already installed on acme. Authorize it to link this worker:",
        );
        expect(text).toContain("To change which repositories it can access:");
        expect(text.indexOf(AUTHORIZE_URL)).toBeLessThan(text.indexOf(INSTALL_URL));
      });

      test("appInstalled unknown shows the install URL plus a fallback line", async () => {
        const text = await connectText({ authorizeUrl: AUTHORIZE_URL }, noWait);
        expect(text.indexOf(INSTALL_URL)).toBeLessThan(text.indexOf(AUTHORIZE_URL));
        expect(text).toContain(
          "If GitHub shows the App's settings page instead of an install, open this to finish:",
        );
        expect(text).not.toContain("already installed");
      });

      test("appInstalled false behaves like unknown", async () => {
        const text = await connectText(
          { authorizeUrl: AUTHORIZE_URL, appInstalled: false },
          noWait,
        );
        expect(text).toContain("open this to finish");
        expect(text).not.toContain("already installed");
      });
    });
  }

  test("logs why authorizing links an unpaired installation", async () => {
    await begin({ authorizeUrl: AUTHORIZE_URL }, "not_paired_or_installed");
    expect(logs.join("\n")).toContain(
      "acme/api: the App installation isn't linked to this account yet; authorizing once links it.",
    );
    logs.length = 0;
    await begin({}, "not_installed");
    expect(logs.join("\n")).not.toContain("isn't linked");
  });

  describe("--json", () => {
    function doc(pairing: PendingGitHubPairing) {
      return buildTargetDocument({
        target: "github",
        exitCode: 0,
        outcomes: [{ kind: "pending", target: "github", pairing }],
        errorLines: [],
        workspaceSuffix: "",
      });
    }
    const base: PendingGitHubPairing = {
      id: "p1",
      installUrl: INSTALL_URL,
      pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/p1`,
      expiresAt: Date.now() + 600_000,
      repos: ["acme/api"],
      relayUrl: RELAY_URL,
    };

    test("appInstalled true: authorize step uses authorizeUrl", () => {
      const result = doc({ ...base, authorizeUrl: AUTHORIZE_URL, appInstalled: true });
      expect(result.pairing).toMatchObject({
        installUrl: INSTALL_URL,
        authorizeUrl: AUTHORIZE_URL,
        appInstalled: true,
      });
      expect(result.nextSteps?.[0]).toMatchObject({
        id: "authorize-github-app",
        command: AUTHORIZE_URL,
        url: AUTHORIZE_URL,
      });
    });

    test("appInstalled absent: authorize step keeps the install URL", () => {
      const result = doc({ ...base, authorizeUrl: AUTHORIZE_URL });
      expect(result.pairing?.authorizeUrl).toBe(AUTHORIZE_URL);
      expect(result.pairing).not.toHaveProperty("appInstalled");
      expect(result.nextSteps?.[0]).toMatchObject({
        id: "authorize-github-app",
        command: INSTALL_URL,
        url: INSTALL_URL,
      });
    });

    test("no authorizeUrl: shape is unchanged", () => {
      const result = doc(base);
      expect(result.pairing).not.toHaveProperty("authorizeUrl");
      expect(result.pairing).not.toHaveProperty("appInstalled");
      expect(result.nextSteps?.[0]).toMatchObject({
        id: "authorize-github-app",
        command: INSTALL_URL,
        url: INSTALL_URL,
      });
    });
  });
});
