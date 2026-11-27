import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { PendingLoginError } from "@devintern/auth";
import type { StartedPendingLogin, SupabaseAuthConfig } from "@devintern/auth";

import { executeLogin, pendingSignInSummary } from "../src/lib/account/cli";
import { parseLoginArgs } from "../src/lib/account/login-args";
import { describePilotEnd, workerLoginCommandFor } from "../src/lib/account/worker-pilot";

const CMD = "devintern worker login";

describe("parseLoginArgs", () => {
  test("methods, aliases, and email addresses", () => {
    expect(parseLoginArgs(["github"], CMD)).toMatchObject({ ok: true, args: { method: "github" } });
    expect(parseLoginArgs(["twitter"], CMD)).toMatchObject({ ok: true, args: { method: "x" } });
    expect(parseLoginArgs(["email", "me@acme.test"], CMD)).toMatchObject({
      ok: true,
      args: { method: "email", email: "me@acme.test" },
    });
    expect(parseLoginArgs(["me@acme.test"], CMD)).toMatchObject({
      ok: true,
      args: { method: "email", email: "me@acme.test" },
    });
    expect(parseLoginArgs(["--provider", "google"], CMD)).toMatchObject({
      ok: true,
      args: { method: "google" },
    });
    expect(parseLoginArgs(["--email=me@acme.test"], CMD)).toMatchObject({
      ok: true,
      args: { method: "email", email: "me@acme.test" },
    });
    expect(parseLoginArgs([], CMD)).toEqual({
      ok: true,
      args: { noWait: false, json: false, help: false },
    });
  });

  test("--no-relay is a worker login option only", () => {
    expect(parseLoginArgs(["--complete", "code=abc", "--no-relay"], CMD)).toMatchObject({
      ok: true,
      args: { complete: "code=abc", noRelay: true },
    });
    expect(parseLoginArgs(["github", "--no-relay"], "devintern login")).toMatchObject({
      ok: false,
    });
  });

  test("--no-wait, --complete, and --json", () => {
    expect(parseLoginArgs(["github", "--no-wait", "--json"], CMD)).toMatchObject({
      ok: true,
      args: { method: "github", noWait: true, json: true },
    });
    const address = "http://127.0.0.1:17865/auth/callback?code=abc";
    expect(parseLoginArgs(["--complete", address], CMD)).toMatchObject({
      ok: true,
      args: { complete: address },
    });
    expect(parseLoginArgs([`--complete=${address}`, "--json"], CMD)).toMatchObject({
      ok: true,
      args: { complete: address, json: true },
    });
  });

  test("unknown flags are rejected, with advice for guessed ones", () => {
    const noBrowser = parseLoginArgs(["github", "--no-browser"], CMD);
    expect(noBrowser.ok).toBe(false);
    if (!noBrowser.ok) {
      expect(noBrowser.error).toContain("Unknown option for devintern worker login: --no-browser");
      expect(noBrowser.error).toContain("--no-wait");
    }
    const other = parseLoginArgs(["--frobnicate=1"], CMD);
    expect(other).toMatchObject({ ok: false });
    if (!other.ok) expect(other.error).toContain("--frobnicate");
  });

  test.each([
    [["facebook"], 'Unknown sign-in method "facebook"'],
    [["github", "google"], "Two sign-in methods"],
    [["--no-wait"], "--no-wait needs a sign-in method"],
    [["email", "--no-wait"], "needs the address"],
    [["--complete"], "--complete needs the address"],
    [["github", "--complete", "code=1"], "pass it on its own"],
    [["--json"], "--json cannot answer the method prompt"],
    [["--email", "nope"], "--email needs an address"],
  ])("rejects %j", (argv, message) => {
    const parsed = parseLoginArgs(argv, CMD);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  test("--help is accepted with anything else", () => {
    expect(parseLoginArgs(["--no-wait", "--help"], CMD)).toMatchObject({
      ok: true,
      args: { help: true },
    });
  });
});

describe("executeLogin", () => {
  let dir: string;
  let config: SupabaseAuthConfig;
  let stdout: string[];
  let logs: string[];
  let errors: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "login-command-"));
    config = {
      url: "http://127.0.0.1:1",
      publishableKey: "pk",
      sessionFilePath: join(dir, "s.json"),
    };
    stdout = [];
    logs = [];
    errors = [];
    logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(" "));
    });
    errorSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const started: StartedPendingLogin = {
    method: "github",
    url: "https://x.supabase.co/auth/v1/authorize?provider=github",
    redirectTo: "http://127.0.0.1:17865/auth/callback",
    expiresAt: "2026-11-26T12:30:00.000Z",
  };
  const writeStdout = (text: string) => {
    stdout.push(text);
  };
  const user = {
    id: "user-1",
    email: "me@acme.test",
    createdAt: null,
    accessToken: "secret-access",
  };

  test("--no-wait --json prints {url, method, expiresAt, complete} and exits 0", async () => {
    const calls: unknown[] = [];
    const code = await executeLogin(
      { method: "github", noWait: true, json: true, help: false },
      config,
      CMD,
      {
        writeStdout,
        startPendingLogin: async (cfg, resolved) => {
          calls.push([cfg, resolved]);
          return started;
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([[config, { method: "github" }]]);
    const doc = JSON.parse(stdout.join(""));
    expect(doc).toEqual({
      schema: "devintern.login",
      version: 1,
      result: "pending",
      url: started.url,
      method: "github",
      expiresAt: started.expiresAt,
      complete: `${CMD} --complete '<address>'`,
    });
  });

  test("--no-wait text names the URL and the complete command", async () => {
    const code = await executeLogin(
      { method: "github", noWait: true, json: false, help: false },
      config,
      CMD,
      { writeStdout, startPendingLogin: async () => started },
    );
    expect(code).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain(started.url!);
    expect(text).toContain(`${CMD} --complete '<address>'`);
    expect(text).toContain("works once, only on this host");
  });

  test("--complete --json reports the user without tokens", async () => {
    const seen: string[] = [];
    const code = await executeLogin(
      { complete: "code=abc", noWait: false, json: true, help: false },
      config,
      CMD,
      {
        writeStdout,
        completePendingLogin: async (_cfg, address, options) => {
          seen.push(address, options?.startCommand ?? "");
          return user;
        },
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["code=abc", `${CMD} github --no-wait`]);
    const text = stdout.join("");
    expect(JSON.parse(text)).toEqual({
      schema: "devintern.login",
      version: 1,
      result: "signed_in",
      user: { id: "user-1", email: "me@acme.test" },
    });
    expect(text).not.toContain("secret-access");
  });

  test("--complete text mentions the Worker Pilot for the worker command", async () => {
    await executeLogin(
      { complete: "code=abc", noWait: false, json: false, help: false },
      config,
      CMD,
      {
        writeStdout,
        completePendingLogin: async () => user,
      },
    );
    expect(logs.join("\n")).toContain("✅ Signed in as me@acme.test");
    expect(logs.join("\n")).toContain("14-day free Worker Pilot, no card required");
  });

  test("worker login: --complete runs the follow-up and adds its fields to the JSON", async () => {
    const contexts: unknown[] = [];
    const code = await executeLogin(
      { complete: "code=abc", noWait: false, json: true, noRelay: true, help: false },
      config,
      CMD,
      {
        writeStdout,
        completePendingLogin: async () => user,
        afterSignIn: async (ctx) => {
          contexts.push(ctx);
          return { relay: { result: "skipped", code: "no_relay" } };
        },
      },
    );
    expect(code).toBe(0);
    expect(contexts).toEqual([{ json: true, noRelay: true, signedIn: true }]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      result: "signed_in",
      user: { id: "user-1" },
      relay: { result: "skipped", code: "no_relay" },
    });
  });

  test("worker login: a failing follow-up never fails the sign-in", async () => {
    const code = await executeLogin(
      { complete: "code=abc", noWait: false, json: true, help: false },
      config,
      CMD,
      {
        writeStdout,
        completePendingLogin: async () => user,
        afterSignIn: async () => {
          throw new Error("relay down");
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      result: "signed_in",
      followUpError: "relay down",
    });
  });

  test("worker login --no-wait: an existing session pairs the relay, the new sign-in still starts", async () => {
    const contexts: unknown[] = [];
    const code = await executeLogin(
      { method: "github", noWait: true, json: true, help: false },
      config,
      CMD,
      {
        writeStdout,
        startPendingLogin: async () => started,
        currentUser: async () => user,
        afterSignIn: async (ctx) => {
          contexts.push(ctx);
          return { relay: { result: "connected" } };
        },
      },
    );
    expect(code).toBe(0);
    expect(contexts).toEqual([{ json: true, noRelay: false, signedIn: false }]);
    const doc = JSON.parse(stdout.join(""));
    expect(doc).toMatchObject({
      result: "pending",
      url: started.url,
      signedInAs: { id: "user-1", email: "me@acme.test" },
      relay: { result: "connected" },
    });
  });

  test("worker login --no-wait without a session does not run the follow-up", async () => {
    let ran = false;
    await executeLogin({ method: "github", noWait: true, json: true, help: false }, config, CMD, {
      writeStdout,
      startPendingLogin: async () => started,
      currentUser: async () => null,
      afterSignIn: async () => {
        ran = true;
        return {};
      },
    });
    expect(ran).toBe(false);
    expect(JSON.parse(stdout.join("")).relay).toBeUndefined();
  });

  test("a pending-login error becomes a JSON failure with its code, exit 1", async () => {
    const code = await executeLogin(
      { complete: "code=abc", noWait: false, json: true, help: false },
      config,
      CMD,
      {
        writeStdout,
        completePendingLogin: async () => {
          throw new PendingLoginError("expired", "The pending sign-in expired.");
        },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema: "devintern.login",
      version: 1,
      result: "failure",
      error: "The pending sign-in expired.",
      code: "expired",
    });
  });

  test("text errors go to stderr", async () => {
    const code = await executeLogin(
      { method: "github", noWait: false, json: false, help: false },
      config,
      CMD,
      {
        writeStdout,
        login: async () => {
          throw new Error("Timed out waiting for sign-in callback.");
        },
      },
    );
    expect(code).toBe(1);
    expect(errors).toEqual(["❌ Timed out waiting for sign-in callback."]);
    expect(stdout).toEqual([]);
  });
});

describe("worker-pilot helpers", () => {
  test("workerLoginCommandFor adds --workspace only for a non-default workspace", () => {
    expect(workerLoginCommandFor("/home/me/.devintern/workspace.toml", "/home/me")).toBe(CMD);
    expect(workerLoginCommandFor("/srv/ws/workspace.toml", "/home/me")).toBe(
      `${CMD} --workspace /srv/ws/workspace.toml`,
    );
    expect(workerLoginCommandFor("/srv/my ws/workspace.toml", "/home/me")).toBe(
      `${CMD} --workspace '/srv/my ws/workspace.toml'`,
    );
  });

  test("describePilotEnd", () => {
    const now = Date.parse("2026-11-26T00:00:00Z");
    expect(describePilotEnd("2026-11-27T00:00:00Z", now)).toBe("ends 2026-11-27 (1 day left)");
    expect(describePilotEnd("nope", now)).toBeNull();
    expect(describePilotEnd(undefined, now)).toBeNull();
  });

  test("pendingSignInSummary", () => {
    expect(
      pendingSignInSummary(
        { method: "email", email: "me@acme.test", url: null, redirectTo: "r", expiresAt: "e" },
        CMD,
      ),
    ).toEqual({
      url: null,
      method: "email",
      expiresAt: "e",
      complete: `${CMD} --complete '<address>'`,
    });
  });
});
