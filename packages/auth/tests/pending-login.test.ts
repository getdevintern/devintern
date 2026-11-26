import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { completePendingLogin, startPendingLogin } from "../src/index";
import {
  PENDING_LOGIN_TTL_MS,
  PendingLoginError,
  parsePendingLogin,
  pastedAddressMismatch,
  pendingLoginPath,
  readPendingLogin,
} from "../src/pending-login";
import type { PendingLogin } from "../src/pending-login";
import type { SupabaseAuthConfig } from "../src/types";

/** Minimal GoTrue stand-in: email OTP and the PKCE token exchange. */
interface FakeRequest {
  path: string;
  body: Record<string, unknown>;
}
let requests: FakeRequest[] = [];
let exchangeOk = true;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push({ path: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/auth/v1/otp") return Response.json({});
      if (url.pathname === "/auth/v1/token") {
        if (!exchangeOk) {
          return Response.json(
            { code: "flow_state_not_found", msg: "invalid flow state, no valid flow state found" },
            { status: 404 },
          );
        }
        return Response.json({
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: {
            id: "user-1",
            aud: "authenticated",
            email: "me@example.com",
            created_at: "2026-01-01T00:00:00Z",
            app_metadata: {},
            user_metadata: {},
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

let dir: string;
let config: SupabaseAuthConfig;

beforeEach(() => {
  requests = [];
  exchangeOk = true;
  dir = mkdtempSync(join(tmpdir(), "auth-pending-"));
  config = {
    url: `http://127.0.0.1:${server.port}`,
    publishableKey: "pk",
    sessionFilePath: join(dir, "state", ".auth-session.json"),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CALLBACK = "http://127.0.0.1:17865/auth/callback";

describe("startPendingLogin", () => {
  test("OAuth: returns the provider URL and saves an owner-only pending file", async () => {
    const started = await startPendingLogin(config, { method: "github" }, { port: 17865 });
    expect(started.method).toBe("github");
    expect(started.redirectTo).toBe(CALLBACK);
    const url = new URL(started.url!);
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("redirect_to")).toBe(CALLBACK);
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    // No network call is needed to build an OAuth URL.
    expect(requests).toEqual([]);

    const path = pendingLoginPath(config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = parsePendingLogin(readFileSync(path, "utf8"))!;
    expect(saved.method).toBe("github");
    expect(saved.redirectTo).toBe(CALLBACK);
    expect(saved.codeVerifier.length).toBeGreaterThan(20);
    // The challenge in the URL is derived from the saved verifier, not the verifier itself.
    expect(url.searchParams.get("code_challenge")).not.toBe(saved.codeVerifier);
    expect(Date.parse(started.expiresAt) - Date.parse(saved.createdAt)).toBe(PENDING_LOGIN_TTL_MS);
  });

  test("email: sends the link with the redirect and has no URL to open", async () => {
    const started = await startPendingLogin(
      config,
      { method: "email", email: "me@example.com" },
      { port: 17865 },
    );
    expect(started.url).toBeNull();
    expect(started.email).toBe("me@example.com");
    const otp = requests.find((r) => r.path.startsWith("/auth/v1/otp"))!;
    expect(otp.path).toContain(`redirect_to=${encodeURIComponent(CALLBACK)}`);
    expect(otp.body.email).toBe("me@example.com");
    expect(typeof otp.body.code_challenge).toBe("string");
  });

  test("email without an address is rejected before anything is saved", async () => {
    await expect(startPendingLogin(config, { method: "email" })).rejects.toThrow("needs the address");
    expect(existsSync(pendingLoginPath(config))).toBe(false);
  });

  test("a new start replaces the earlier pending sign-in", async () => {
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    const first = readFileSync(pendingLoginPath(config), "utf8");
    await startPendingLogin(config, { method: "google" }, { port: 17865 });
    const second = parsePendingLogin(readFileSync(pendingLoginPath(config), "utf8"))!;
    expect(second.method).toBe("google");
    expect(second.codeVerifier).not.toBe(parsePendingLogin(first)!.codeVerifier);
  });
});

describe("completePendingLogin", () => {
  test("exchanges the code with the saved verifier, saves the session, deletes the pending file", async () => {
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    const verifier = parsePendingLogin(readFileSync(pendingLoginPath(config), "utf8"))!.codeVerifier;
    const user = await completePendingLogin(config, `${CALLBACK}?code=abc-123`);
    expect(user).toMatchObject({ id: "user-1", email: "me@example.com" });

    const token = requests.find((r) => r.path.startsWith("/auth/v1/token"))!;
    expect(token.path).toContain("grant_type=pkce");
    expect(token.body).toEqual({ auth_code: "abc-123", code_verifier: verifier });

    const session = JSON.parse(readFileSync(config.sessionFilePath, "utf8"));
    expect(session).toMatchObject({
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      user: { id: "user-1", email: "me@example.com" },
    });
    expect(existsSync(pendingLoginPath(config))).toBe(false);
  });

  test("a bare code= query works too", async () => {
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    await completePendingLogin(config, "code=abc-123");
    expect(existsSync(config.sessionFilePath)).toBe(true);
  });

  test("nothing pending", async () => {
    const error = await completePendingLogin(config, `${CALLBACK}?code=x`, {
      startCommand: "devintern worker login github --no-wait",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PendingLoginError);
    expect((error as PendingLoginError).code).toBe("missing");
    expect((error as Error).message).toContain("devintern worker login github --no-wait");
    expect(requests).toEqual([]);
  });

  test("expired: refused, the file is deleted, and no exchange is attempted", async () => {
    const start = Date.now();
    await startPendingLogin(config, { method: "github" }, { port: 17865, now: () => start });
    const error = await completePendingLogin(config, `${CALLBACK}?code=x`, {
      now: () => start + PENDING_LOGIN_TTL_MS + 1,
    }).catch((e: unknown) => e);
    expect((error as PendingLoginError).code).toBe("expired");
    expect(existsSync(pendingLoginPath(config))).toBe(false);
    expect(requests).toEqual([]);
  });

  test("an address from another sign-in (different port) is refused and the pending file kept", async () => {
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    const error = await completePendingLogin(
      config,
      "http://127.0.0.1:40000/auth/callback?code=x",
    ).catch((e: unknown) => e);
    expect((error as PendingLoginError).code).toBe("mismatch");
    expect((error as Error).message).toContain(CALLBACK);
    expect(existsSync(pendingLoginPath(config))).toBe(true);
    expect(requests).toEqual([]);
  });

  test("text that is not an address is refused and the pending file kept", async () => {
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    const error = await completePendingLogin(config, "hello").catch((e: unknown) => e);
    expect((error as PendingLoginError).code).toBe("bad-address");
    expect(existsSync(pendingLoginPath(config))).toBe(true);
  });

  test("an OAuth error address ends the pending sign-in", async () => {
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    const error = await completePendingLogin(
      config,
      `${CALLBACK}?error=access_denied&error_description=User+denied`,
    ).catch((e: unknown) => e);
    expect((error as PendingLoginError).code).toBe("oauth-error");
    expect((error as Error).message).toContain("User denied");
    expect(existsSync(pendingLoginPath(config))).toBe(false);
  });

  test("a code the server rejects fails cleanly; no session is written", async () => {
    exchangeOk = false;
    await startPendingLogin(config, { method: "github" }, { port: 17865 });
    const error = await completePendingLogin(config, `${CALLBACK}?code=bogus`).catch(
      (e: unknown) => e,
    );
    expect((error as PendingLoginError).code).toBe("exchange-failed");
    expect((error as Error).message).toContain("invalid flow state");
    expect(existsSync(config.sessionFilePath)).toBe(false);
  });
});

describe("readPendingLogin", () => {
  const pending: PendingLogin = {
    version: 1,
    method: "github",
    redirectTo: CALLBACK,
    codeVerifier: "verifier-value",
    createdAt: "2026-11-26T00:00:00.000Z",
    expiresAt: "2026-11-26T00:30:00.000Z",
  };

  test.skipIf(process.platform === "win32")(
    "refuses and deletes a file readable by others",
    async () => {
      const path = join(dir, ".auth-pending.json");
      writeFileSync(path, JSON.stringify(pending));
      chmodSync(path, 0o644);
      const error = await readPendingLogin(path, "x", Date.parse(pending.createdAt)).catch(
        (e: unknown) => e,
      );
      expect((error as PendingLoginError).code).toBe("unsafe");
      expect(existsSync(path)).toBe(false);
    },
  );

  test("refuses and deletes a corrupt file", async () => {
    const path = join(dir, ".auth-pending.json");
    writeFileSync(path, "{not json", { mode: 0o600 });
    const error = await readPendingLogin(path, "x").catch((e: unknown) => e);
    expect((error as PendingLoginError).code).toBe("invalid");
    expect(existsSync(path)).toBe(false);
  });

  test("parsePendingLogin rejects wrong versions and methods", () => {
    expect(parsePendingLogin(JSON.stringify(pending))).toEqual(pending);
    expect(parsePendingLogin(JSON.stringify({ ...pending, version: 2 }))).toBeNull();
    expect(parsePendingLogin(JSON.stringify({ ...pending, method: "facebook" }))).toBeNull();
    expect(parsePendingLogin(JSON.stringify({ ...pending, codeVerifier: "" }))).toBeNull();
  });

  test("pastedAddressMismatch compares origin and path only", () => {
    expect(pastedAddressMismatch(`${CALLBACK}?code=1`, pending)).toBeNull();
    expect(pastedAddressMismatch("code=1", pending)).toBeNull();
    expect(pastedAddressMismatch("http://localhost:17865/auth/callback?code=1", pending)).toContain(
      "not from the sign-in waiting on this host",
    );
    expect(pastedAddressMismatch("http://127.0.0.1:17865/other?code=1", pending)).not.toBeNull();
  });
});
