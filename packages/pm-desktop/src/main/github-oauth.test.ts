import { afterEach, describe, expect, test } from "bun:test";
import {
  GitHubOAuthError,
  isGitHubOAuthAvailable,
  pollForToken,
  refreshOAuthToken,
  requestDeviceCode,
  runDeviceFlow,
  setGitHubOAuthClientIdForTests,
  setGitHubOAuthFetchForTests,
  setGitHubOAuthOpenExternalForTests,
  setGitHubOAuthPollIntervalForTests,
} from "./github-oauth.ts";
import { setGitHubAuthCryptoForTests, setGitHubAuthUserDataDirForTests } from "./github-auth.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("github-oauth", () => {
  let tempDir: string;

  afterEach(async () => {
    setGitHubOAuthClientIdForTests(undefined);
    setGitHubOAuthFetchForTests(undefined);
    setGitHubOAuthOpenExternalForTests(undefined);
    setGitHubOAuthPollIntervalForTests(undefined);
    setGitHubAuthUserDataDirForTests(undefined);
    setGitHubAuthCryptoForTests({});
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("isGitHubOAuthAvailable reflects the configured Client ID", () => {
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    expect(isGitHubOAuthAvailable()).toBe(true);
    setGitHubOAuthClientIdForTests("");
    expect(isGitHubOAuthAvailable()).toBe(false);
  });

  test("requestDeviceCode returns device + user code", async () => {
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    let receivedBody: unknown;
    setGitHubOAuthFetchForTests(async (_url, init) => {
      receivedBody = JSON.parse(init?.body as string);
      return jsonResponse(200, {
        device_code: "dc123",
        user_code: "AB-CDEF",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    });
    const result = await requestDeviceCode();
    expect(result.deviceCode).toBe("dc123");
    expect(result.userCode).toBe("AB-CDEF");
    expect(result.verificationUri).toBe("https://github.com/login/device");
    expect((receivedBody as { client_id: string }).client_id).toBe("Iv23lizCPMPWFM5LO9lK");
  });

  test("requestDeviceCode throws not_configured without a Client ID", async () => {
    setGitHubOAuthClientIdForTests("");
    await expect(requestDeviceCode()).rejects.toMatchObject({ code: "not_configured" });
  });

  test("pollForToken resolves after authorization_pending then success", async () => {
    setGitHubOAuthPollIntervalForTests(10);
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    let calls = 0;
    setGitHubOAuthFetchForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, { error: "authorization_pending" });
      }
      return jsonResponse(200, {
        access_token: "ghu_token",
        refresh_token: "ghr_refresh",
        expires_in: 28800,
        token_type: "bearer",
      });
    });
    const tokens = await pollForToken("dc123", 0, 30, {});
    expect(tokens.accessToken).toBe("ghu_token");
    expect(tokens.refreshToken).toBe("ghr_refresh");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  test("pollForToken surfaces denied on access_denied", async () => {
    setGitHubOAuthPollIntervalForTests(10);
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    setGitHubOAuthFetchForTests(async () =>
      jsonResponse(200, { error: "access_denied", error_description: "user said no" }),
    );
    await expect(pollForToken("dc123", 0, 5, {})).rejects.toMatchObject({ code: "denied" });
  });

  test("pollForToken expires when the deadline passes", async () => {
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    setGitHubOAuthFetchForTests(async () => jsonResponse(200, { error: "authorization_pending" }));
    await expect(pollForToken("dc123", 0, 0, {})).rejects.toMatchObject({ code: "expired" });
  });

  test("pollForToken honours an abort signal", async () => {
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    setGitHubOAuthFetchForTests(async () => jsonResponse(200, { error: "authorization_pending" }));
    const controller = new AbortController();
    const promise = pollForToken("dc123", 60, 120, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  test("refreshOAuthToken exchanges a refresh token for a new access token", async () => {
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    let receivedBody: unknown;
    setGitHubOAuthFetchForTests(async (_url, init) => {
      receivedBody = JSON.parse(init?.body as string);
      return jsonResponse(200, {
        access_token: "ghu_new",
        refresh_token: "ghr_new",
        expires_in: 28800,
      });
    });
    const tokens = await refreshOAuthToken("ghr_old");
    expect(tokens.accessToken).toBe("ghu_new");
    expect(tokens.refreshToken).toBe("ghr_new");
    expect((receivedBody as { refresh_token: string; grant_type: string }).refresh_token).toBe(
      "ghr_old",
    );
    expect((receivedBody as { grant_type: string }).grant_type).toBe("refresh_token");
  });

  test("refreshOAuthToken maps errors to refresh_failed", async () => {
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    setGitHubOAuthFetchForTests(async () =>
      jsonResponse(200, { error: "bad_refresh_token", error_description: "expired" }),
    );
    await expect(refreshOAuthToken("ghr_old")).rejects.toMatchObject({
      code: "refresh_failed",
    });
  });

  test("runDeviceFlow persists tokens and returns login", async () => {
    setGitHubOAuthPollIntervalForTests(10);
    setGitHubOAuthClientIdForTests("Iv23lizCPMPWFM5LO9lK");
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-oauth-flow-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    setGitHubOAuthOpenExternalForTests(async () => {});
    let calls = 0;
    setGitHubOAuthFetchForTests(async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResponse(200, {
          device_code: "dc123",
          user_code: "AB-CDEF",
          verification_uri: "https://github.com/login/device",
          expires_in: 30,
          interval: 0,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        calls += 1;
        return jsonResponse(200, {
          access_token: "ghu_token",
          refresh_token: "ghr_refresh",
          expires_in: 28800,
        });
      }
      if (url.endsWith("/user")) {
        return jsonResponse(200, { login: "dana" });
      }
      return jsonResponse(404, {});
    });
    const tokens = await runDeviceFlow({});
    expect(tokens.accessToken).toBe("ghu_token");
    expect(tokens.login).toBe("dana");
    expect(calls).toBe(1);
  });

  test("runDeviceFlow rejects when not configured", async () => {
    setGitHubOAuthClientIdForTests("");
    await expect(runDeviceFlow({})).rejects.toMatchObject({ code: "not_configured" });
  });

  test("GitHubOAuthError carries a stable code", () => {
    const err = new GitHubOAuthError("expired", "boom");
    expect(err.code).toBe("expired");
    expect(err.message).toBe("boom");
  });
});
