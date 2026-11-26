import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseConnectArgs, runWorkerConnectCommand } from "../src/lib/init/worker-connect";
import type { WorkerConnectCommandDeps } from "../src/lib/init/worker-connect";
import { loadPendingGitHubPairing, loadRelayState } from "../src/lib/relay/connect";

const RELAY_URL = "https://relay.test";
const TOKEN = "sntrys_headless_secret_0123456789";

interface RelayCall {
  url: string;
  action?: string;
}

describe("parseConnectArgs (headless flags)", () => {
  test("parses the GitHub and Sentry flags", () => {
    const parsed = parseConnectArgs([
      "sentry",
      "--org",
      "acme",
      "--project",
      "api,web",
      "--project",
      "worker",
      "--sentry-url",
      "https://de.sentry.io",
      "--query",
      "environment:production",
      "--env-file",
      "/tmp/sentry.env",
      "--yes",
      "--json",
    ]);
    expect(parsed).toMatchObject({
      target: "sentry",
      organization: "acme",
      projects: ["api,web", "worker"],
      sentryUrl: "https://de.sentry.io",
      query: "environment:production",
      envFile: "/tmp/sentry.env",
      yes: true,
      json: true,
    });
    expect(parseConnectArgs(["github", "--no-wait"]).noWait).toBe(true);
    expect(parseConnectArgs(["github", "--status"]).status).toBe(true);
    expect(parseConnectArgs(["github", "--resume"]).status).toBe(true);
  });

  test("never accepts a token as a flag", () => {
    for (const flag of ["--token", "--auth-token", "--sentry-token", "--token=abc"]) {
      expect(parseConnectArgs(["sentry", flag, "abc"]).error).toContain("never accepted as flags");
    }
  });

  test("requires values", () => {
    expect(parseConnectArgs(["sentry", "--org"]).error).toBe("--org requires a value.");
    expect(parseConnectArgs(["sentry", "--env-file", "--yes"]).error).toBe(
      "--env-file requires a value.",
    );
  });
});

describe("worker connect headless", () => {
  let workspaceDir: string;
  let stdout: string[];
  let stderr: string[];
  let relayCalls: RelayCall[];
  let pairingStatus: { status: number; body: unknown };
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalFetch = globalThis.fetch;
  const savedSentryToken = process.env.SENTRY_AUTH_TOKEN;
  const savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "devintern-connect-headless-"));
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
`,
    );
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    delete process.env.SENTRY_AUTH_TOKEN;
    stdout = [];
    stderr = [];
    relayCalls = [];
    pairingStatus = { status: 200, body: { status: "pending" } };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
    if (savedSentryToken === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = savedSentryToken;
    if (savedWorkspaceDir === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  /** A relay without browser-free verification: it begins a pairing and reports `pairingStatus`. */
  const relayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : null;
    relayCalls.push({ url, action: body?.action });
    if (url.includes("/v1/github/pairings/")) {
      return new Response(JSON.stringify(pairingStatus.body), { status: pairingStatus.status });
    }
    if (body?.action === "issue-token") {
      return Response.json({
        customerId: "user_1",
        licenseSource: "solo-automation",
        relayToken: "drt_headless",
      });
    }
    if (body?.action === "begin-github-pairing") {
      return Response.json({
        customerId: "user_1",
        installUrl: "https://github.com/apps/devintern-ai/installations/new?state=abc",
        pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/pair-123`,
        expiresAt: Date.now() + 600_000,
      });
    }
    return Response.json({ error: "unsupported action: verify-github-repos" }, { status: 400 });
  }) as typeof fetch;

  function run(args: string[], extra: WorkerConnectCommandDeps = {}): Promise<number> {
    return runWorkerConnectCommand(args, {
      workspaceDir,
      cwd: workspaceDir,
      relayUrl: RELAY_URL,
      fetchImpl: relayFetch,
      getAccessToken: async () => "supa-access",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      ...extra,
    });
  }

  function doc(): Record<string, any> {
    expect(stdout).toHaveLength(1);
    return JSON.parse(stdout[0]!);
  }

  describe("github", () => {
    test("--no-wait --json prints the pairing, records it owner-only, and exits 0", async () => {
      const code = await run(["github", "--no-wait", "--json"]);

      expect(code).toBe(0);
      const result = doc();
      expect(result).toMatchObject({
        schema: "devintern.worker-connect",
        version: 1,
        target: "github",
        result: "pending",
        pairing: {
          id: "pair-123",
          state: "pending",
          installUrl: "https://github.com/apps/devintern-ai/installations/new?state=abc",
        },
      });
      expect(Number.isNaN(Date.parse(result.pairing.expiresAt))).toBe(false);
      expect(result.nextSteps).toEqual([
        {
          id: "authorize-github-app",
          message: expect.stringContaining("approves the DevIntern GitHub App"),
          command: "https://github.com/apps/devintern-ai/installations/new?state=abc",
          url: "https://github.com/apps/devintern-ai/installations/new?state=abc",
        },
        {
          id: "check-pairing",
          message: expect.any(String),
          command: expect.stringContaining("github --status --json"),
        },
      ]);
      // Never polled: --no-wait returns right after the relay hands out the pairing.
      expect(relayCalls.some((call) => call.url.includes("/pairings/"))).toBe(false);
      const pending = loadPendingGitHubPairing(workspaceDir);
      expect(pending?.repos).toEqual(["acme/api"]);
      const file = join(workspaceDir, "state", "code", "github-pairing.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    test("--no-wait without --json prints the URL and the follow-up command", async () => {
      const logs: string[] = [];
      console.log = (...values: unknown[]) => logs.push(values.join(" "));

      const code = await run(["github", "--no-wait"]);

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("installations/new?state=abc");
      expect(logs.join("\n")).toContain("devintern worker connect github --status");
      expect(stdout).toEqual([]);
    });

    test("--status reports pending without finishing", async () => {
      await run(["github", "--no-wait", "--json"]);
      stdout.length = 0;

      const code = await run(["github", "--status", "--json"]);

      expect(code).toBe(0);
      expect(doc()).toMatchObject({ target: "github", result: "pending" });
      expect(loadPendingGitHubPairing(workspaceDir)).not.toBeNull();
    });

    test("--status completes local registration when the pairing finished", async () => {
      await run(["github", "--no-wait", "--json"]);
      stdout.length = 0;
      pairingStatus = {
        status: 200,
        body: {
          status: "complete",
          customerId: "user_1",
          licenseSource: "solo-automation",
          repo: "acme/api",
          installationId: 7001,
          repositoryId: 9001,
          registrations: [],
        },
      };

      const code = await run(["github", "--resume", "--json"]);

      expect(code).toBe(0);
      expect(doc()).toMatchObject({ result: "connected", repos: ["acme/api"] });
      expect(loadPendingGitHubPairing(workspaceDir)).toBeNull();
      expect(loadRelayState(workspaceDir)?.githubRepositories).toEqual([
        { repo: "acme/api", installationId: 7001, repositoryId: 9001 },
      ]);
    });

    test("--status reports an expired pairing and forgets it", async () => {
      await run(["github", "--no-wait", "--json"]);
      stdout.length = 0;
      pairingStatus = { status: 404, body: { error: "gone" } };

      const code = await run(["github", "--status", "--json"]);

      expect(code).toBe(1);
      expect(doc()).toMatchObject({ result: "failure", code: "pairing_expired" });
      expect(loadPendingGitHubPairing(workspaceDir)).toBeNull();
    });

    test.each([
      [401, "relay_unauthorized", "worker login"],
      [403, "relay_unauthorized", "worker login"],
      [500, "relay_unavailable", "Retry later"],
      [503, "relay_unavailable", "Retry later"],
    ])("--status reports HTTP %d as a failure, not pending", async (status, code, hint) => {
      await run(["github", "--no-wait", "--json"]);
      stdout.length = 0;
      pairingStatus = { status, body: { error: "relay says no" } };

      const exit = await run(["github", "--status", "--json"]);

      expect(exit).toBe(1);
      expect(doc()).toMatchObject({ result: "failure", code });
      expect(doc().error).toContain(hint);
      expect(doc().error).toContain(`HTTP ${status}`);
      expect(loadPendingGitHubPairing(workspaceDir)).not.toBeNull();
    });

    test("--status pending text explains the App settings page case", async () => {
      await run(["github", "--no-wait", "--json"]);
      const logs: string[] = [];
      console.log = (...values: unknown[]) => logs.push(values.join(" "));

      expect(await run(["github", "--status"])).toBe(0);

      expect(logs.join("\n")).toContain("settings page");
      expect(logs.join("\n")).toContain("devintern worker connect github");
    });

    test("--no-wait prints the --status instruction once", async () => {
      const logs: string[] = [];
      console.log = (...values: unknown[]) => logs.push(values.join(" "));

      await run(["github", "--no-wait"]);

      const mentions = logs.filter((line) => line.includes("connect github --status"));
      expect(mentions).toHaveLength(1);
    });

    test("--status without a recorded pairing says how to start one", async () => {
      const code = await run(["github", "--status", "--json"]);

      expect(code).toBe(1);
      expect(doc()).toMatchObject({ result: "failure", code: "no_pending_pairing" });
      expect(doc().error).toContain("connect github --no-wait");
    });

    test("--status refuses a pairing recorded for a different relay", async () => {
      await run(["github", "--no-wait", "--json"]);
      stdout.length = 0;

      const code = await run(["github", "--status", "--json"], {
        relayUrl: "https://other-relay.test",
      });

      expect(code).toBe(1);
      expect(doc().error).toContain("different relay");
    });

    test("not signed in is action_required with the sign-in command", async () => {
      const code = await run(["github", "--no-wait", "--json"], {
        // Falls through to the real session lookup, which finds no session file.
        getAccessToken: undefined,
      });

      expect(code).toBe(2);
      const result = doc();
      expect(result).toMatchObject({
        schema: "devintern.worker-connect",
        target: "github",
        result: "action_required",
      });
      expect(result.error).toContain("Not authenticated");
      expect(result.code).toBe("not_signed_in");
      expect(result.nextSteps).toEqual([
        {
          id: "sign-in",
          message: expect.stringContaining("Sign in first"),
          // The same form as `worker init` and `worker doctor` print.
          command: expect.stringMatching(
            /^devintern worker login --workspace \S+ github --no-wait --json$/,
          ),
        },
      ]);
      expect(relayCalls).toEqual([]);
    });

    test("--json keeps stdout to the one document", async () => {
      await run(["github", "--no-wait", "--json"]);

      expect(stdout).toHaveLength(1);
      expect(stderr.join("")).toContain("installations/new?state=abc");
      expect(console.log).toBe(originalLog);
    });

    test("rejects flags that do not belong to the target", async () => {
      expect(await run(["github", "--no-wait", "--status", "--json"])).toBe(1);
      expect(doc().error).toContain("cannot be combined");
      stdout.length = 0;
      expect(await run(["linear", "--no-wait", "--json"])).toBe(1);
      expect(doc().error).toContain("--no-wait is only valid for the GitHub");
      stdout.length = 0;
      expect(await run(["github", "--org", "acme", "--json"])).toBe(1);
      expect(doc().error).toContain("--org is only valid for the Sentry");
    });
  });

  describe("other targets", () => {
    test("a tracker target reports connected, or its error, as JSON", async () => {
      let code = await run(["linear", "--json"], { runConnect: async () => 0 });
      expect(code).toBe(0);
      expect(doc()).toMatchObject({ target: "linear", result: "connected" });

      stdout.length = 0;
      code = await run(["linear", "--json"], {
        runConnect: async () => {
          console.error("❌ LINEAR_API_KEY is required.");
          return 1;
        },
      });
      expect(code).toBe(1);
      expect(doc()).toMatchObject({
        target: "linear",
        result: "failure",
        error: "LINEAR_API_KEY is required.",
      });
    });

    test("bare connect with --json aggregates every target", async () => {
      const code = await run(["--json"], {
        runConnect: async (target, deps) => {
          deps.onOutcome?.({ kind: "connected", target, repos: ["acme/api"] });
          return 0;
        },
      });

      expect(code).toBe(0);
      expect(doc()).toMatchObject({
        target: "all",
        result: "connected",
        targets: [{ target: "github", result: "connected", repos: ["acme/api"] }],
      });
    });

    test("an unknown target is a JSON failure", async () => {
      const code = await run(["bogus", "--json"]);

      expect(code).toBe(1);
      expect(doc()).toMatchObject({ result: "failure" });
    });
  });

  describe("sentry (non-interactive)", () => {
    let sentryRequests: string[];
    let sentryStatus: number;

    beforeEach(() => {
      sentryRequests = [];
      sentryStatus = 200;
      globalThis.fetch = (async (input: string | URL | Request) => {
        sentryRequests.push(String(input));
        return sentryStatus === 200
          ? Response.json([])
          : new Response(JSON.stringify({ detail: "Invalid token" }), { status: sentryStatus });
      }) as unknown as typeof fetch;
    });

    function envFile(contents: string, mode = 0o600): string {
      const path = join(workspaceDir, "sentry-input.env");
      writeFileSync(path, contents);
      chmodSync(path, mode);
      return path;
    }

    const flags = ["sentry", "--org", "acme", "--project", "backend", "--json"];

    test("adds a monitor using the token from the environment", async () => {
      const code = await run([...flags, "--query", "environment:production"], {
        env: { SENTRY_AUTH_TOKEN: TOKEN },
      });

      expect(code).toBe(0);
      const result = doc();
      expect(result).toMatchObject({
        target: "sentry",
        result: "connected",
        monitors: [
          {
            id: "sentry-backend",
            organization: "acme",
            project: "backend",
            repo: "api",
            action: "added",
            unresolvedIssues: 0,
            envFile: "env/sentry-backend.env",
          },
        ],
      });
      expect(sentryRequests[0]).toContain("sentry.io");
      const toml = readFileSync(join(workspaceDir, "workspace.toml"), "utf8");
      expect(toml).toContain('project = "backend"');
      expect(toml).toContain('query = "environment:production"');
      const tokenFile = join(workspaceDir, "env", "sentry-backend.env");
      expect(readFileSync(tokenFile, "utf8")).toBe(`SENTRY_AUTH_TOKEN=${TOKEN}\n`);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      // The secret reaches neither stdout nor stderr.
      expect(stdout.join("") + stderr.join("")).not.toContain(TOKEN);
    });

    test("reads the token from a 0600 --env-file and honors --sentry-url", async () => {
      const code = await run(
        [
          ...flags,
          "--sentry-url",
          "https://de.sentry.io/",
          "--env-file",
          envFile(`SENTRY_AUTH_TOKEN=${TOKEN}\n`),
        ],
        { env: {} },
      );

      expect(code).toBe(0);
      expect(sentryRequests[0]).toContain("https://de.sentry.io/");
      expect(readFileSync(join(workspaceDir, "workspace.toml"), "utf8")).toContain(
        'base_url = "https://de.sentry.io"',
      );
    });

    test("refuses an --env-file readable by group or others", async () => {
      const code = await run(
        [...flags, "--env-file", envFile(`SENTRY_AUTH_TOKEN=${TOKEN}\n`, 0o644)],
        {
          env: {},
        },
      );

      expect(code).toBe(1);
      const result = doc();
      expect(result).toMatchObject({ result: "failure", code: "env_file_unreadable" });
      expect(result.error).toContain("chmod 600");
      expect(result.error).not.toContain(TOKEN);
      expect(sentryRequests).toEqual([]);
      expect(existsSync(join(workspaceDir, "env"))).toBe(false);
    });

    test("names the missing token and flags instead of prompting", async () => {
      expect(await run(flags, { env: {} })).toBe(1);
      expect(doc()).toMatchObject({
        code: "missing_token",
        missing: ["SENTRY_AUTH_TOKEN"],
      });

      stdout.length = 0;
      expect(
        await run(["sentry", "--json", "--project", "x"], { env: { SENTRY_AUTH_TOKEN: TOKEN } }),
      ).toBe(1);
      expect(doc()).toMatchObject({ code: "missing_flags", missing: ["--org"] });
    });

    test("an --env-file without the token is reported", async () => {
      const code = await run([...flags, "--env-file", envFile("OTHER=1\n")], { env: {} });

      expect(code).toBe(1);
      expect(doc()).toMatchObject({ code: "missing_token" });
    });

    test("rejects a malformed --sentry-url before any request", async () => {
      const code = await run([...flags, "--sentry-url", "not a url"], {
        env: { SENTRY_AUTH_TOKEN: TOKEN },
      });

      expect(code).toBe(1);
      expect(doc()).toMatchObject({ code: "invalid_sentry_url" });
      expect(sentryRequests).toEqual([]);
    });

    test("a rejected token writes nothing and does not echo the token", async () => {
      sentryStatus = 401;

      const code = await run(flags, { env: { SENTRY_AUTH_TOKEN: TOKEN } });

      expect(code).toBe(1);
      const result = doc();
      expect(result).toMatchObject({ code: "sentry_validation_failed" });
      expect(result.error).toContain("Nothing was written");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(readFileSync(join(workspaceDir, "workspace.toml"), "utf8")).not.toContain(
        "error_monitors",
      );
      expect(existsSync(join(workspaceDir, "env"))).toBe(false);
    });

    test("several projects are validated first, then all added", async () => {
      const code = await run(
        ["sentry", "--org", "acme", "--project", "api,web", "--project", "worker", "--json"],
        { env: { SENTRY_AUTH_TOKEN: TOKEN } },
      );

      expect(code).toBe(0);
      expect(doc().monitors.map((monitor: { id: string }) => monitor.id)).toEqual([
        "sentry-api",
        "sentry-web",
        "sentry-worker",
      ]);
      expect(sentryRequests).toHaveLength(3);
    });

    test("an existing monitor needs --yes, which refreshes its token", async () => {
      expect(await run(flags, { env: { SENTRY_AUTH_TOKEN: TOKEN } })).toBe(0);
      stdout.length = 0;

      expect(await run(flags, { env: { SENTRY_AUTH_TOKEN: "sntrys_rotated_token_999" } })).toBe(1);
      expect(doc()).toMatchObject({ code: "monitor_exists" });
      expect(readFileSync(join(workspaceDir, "env", "sentry-backend.env"), "utf8")).toContain(
        TOKEN,
      );

      stdout.length = 0;
      const code = await run([...flags, "--yes"], {
        env: { SENTRY_AUTH_TOKEN: "sntrys_rotated_token_999" },
      });
      expect(code).toBe(0);
      expect(doc().monitors[0]).toMatchObject({ id: "sentry-backend", action: "updated" });
      const tokenFile = join(workspaceDir, "env", "sentry-backend.env");
      expect(readFileSync(tokenFile, "utf8")).toBe("SENTRY_AUTH_TOKEN=sntrys_rotated_token_999\n");
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const toml = readFileSync(join(workspaceDir, "workspace.toml"), "utf8");
      expect(toml.match(/\[\[error_monitors\]\]/g)).toHaveLength(1);
    });

    test("several repositories need --repo", async () => {
      writeFileSync(
        join(workspaceDir, "workspace.toml"),
        `[defaults]
tracker = "linear"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`,
      );

      expect(await run(flags, { env: { SENTRY_AUTH_TOKEN: TOKEN } })).toBe(1);
      expect(doc()).toMatchObject({ code: "repo_required" });

      stdout.length = 0;
      expect(await run([...flags, "--repo", "web"], { env: { SENTRY_AUTH_TOKEN: TOKEN } })).toBe(0);
      expect(doc().monitors[0].repo).toBe("web");
    });

    test("human mode prints a summary and no token", async () => {
      const logs: string[] = [];
      console.log = (...values: unknown[]) => logs.push(values.join(" "));

      const code = await run(["sentry", "--org", "acme", "--project", "backend"], {
        env: { SENTRY_AUTH_TOKEN: TOKEN },
        validateSentry: async () => 4,
      });

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain('monitor "sentry-backend" added (4 unresolved');
      expect(logs.join("\n")).not.toContain(TOKEN);
      expect(stdout).toEqual([]);
    });

    test("without a terminal and without flags the error points to the flags", async () => {
      const errors: string[] = [];
      console.error = (...values: unknown[]) => errors.push(values.join(" "));

      const code = await run(["sentry"], { env: {} });

      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("worker connect sentry' is interactive");
      expect(errors.join("\n")).toContain("--org <slug> --project <slug>");
      expect(errors.join("\n")).toContain("--env-file");
    });

    test("--json without the required flags lists them", async () => {
      const code = await run(["sentry", "--json"], { env: { SENTRY_AUTH_TOKEN: TOKEN } });

      expect(code).toBe(1);
      expect(doc()).toMatchObject({ code: "missing_flags", missing: ["--org", "--project"] });
    });
  });
});
