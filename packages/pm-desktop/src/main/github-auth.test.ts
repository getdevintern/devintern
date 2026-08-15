import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGitHubToken,
  getGitHubAuthStatus,
  getGitHubToken,
  hasGitHubToken,
  setGitHubAuthCryptoForTests,
  setGitHubAuthRefreshForTests,
  setGitHubAuthUserDataDirForTests,
  setGitHubOAuthToken,
  setGitHubToken,
} from "./github-auth.ts";

describe("github-auth", () => {
  let tempDir: string;

  afterEach(async () => {
    setGitHubAuthUserDataDirForTests(undefined);
    setGitHubAuthCryptoForTests({});
    setGitHubAuthRefreshForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("round-trips a plaintext token when encryption is unavailable", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    expect(await hasGitHubToken()).toBe(false);
    await setGitHubToken("ghp_test_token");
    expect(await hasGitHubToken()).toBe(true);
    expect(await getGitHubToken()).toBe("ghp_test_token");
    await clearGitHubToken();
    expect(await hasGitHubToken()).toBe(false);
  });

  test("round-trips an encrypted token", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({
      encryptionAvailable: true,
      encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
      decrypt: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
    });

    await setGitHubToken("github_pat_x");
    expect(await getGitHubToken()).toBe("github_pat_x");
  });

  test("rejects empty tokens", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    await expect(setGitHubToken("   ")).rejects.toThrow(/empty/);
  });

  test("writes github-token.json with mode 0o600", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    await setGitHubToken("ghp_perm");
    const mode = (await stat(join(tempDir, "github-token.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("getGitHubAuthStatus reports plaintext vs encrypted storage for PAT", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-status-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    expect(await getGitHubAuthStatus()).toEqual({
      connected: false,
      encryptionAvailable: false,
    });

    await setGitHubToken("ghp_plain");
    expect(await getGitHubAuthStatus()).toEqual({
      connected: true,
      method: "pat",
      encryptionAvailable: false,
      tokenEncrypted: false,
    });

    await clearGitHubToken();
    setGitHubAuthCryptoForTests({
      encryptionAvailable: true,
      encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
      decrypt: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
    });
    await setGitHubToken("ghp_enc");
    expect(await getGitHubAuthStatus()).toEqual({
      connected: true,
      method: "pat",
      encryptionAvailable: true,
      tokenEncrypted: true,
    });
  });

  test("round-trips an OAuth token set", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-oauth-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    await setGitHubOAuthToken({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      expiresAt: Date.now() + 600_000,
      login: "dana",
    });
    expect(await getGitHubToken()).toBe("ghu_access");
    expect(await getGitHubAuthStatus()).toEqual({
      connected: true,
      method: "oauth",
      login: "dana",
      encryptionAvailable: false,
      tokenEncrypted: false,
    });
  });

  test("refreshes an expired OAuth token transparently on read", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-refresh-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    await setGitHubOAuthToken({
      accessToken: "ghu_old",
      refreshToken: "ghr_refresh",
      expiresAt: Date.now() - 1_000,
      login: "dana",
    });
    setGitHubAuthRefreshForTests(async () => ({
      accessToken: "ghu_new",
      refreshToken: "ghr_refresh2",
      expiresAt: Date.now() + 60_000,
    }));
    expect(await getGitHubToken()).toBe("ghu_new");
    // A second read reuses the refreshed token (no second refresh call).
    expect(await getGitHubToken()).toBe("ghu_new");
    expect(await getGitHubAuthStatus()).toMatchObject({
      connected: true,
      method: "oauth",
      login: "dana",
    });
  });

  test("returns null when refresh fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-refresh-fail-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    await setGitHubOAuthToken({
      accessToken: "ghu_old",
      refreshToken: "ghr_refresh",
      expiresAt: Date.now() - 1_000,
      login: "dana",
    });
    setGitHubAuthRefreshForTests(async () => {
      throw new Error("refresh denied");
    });
    expect(await getGitHubToken()).toBeNull();
    expect(await getGitHubAuthStatus()).toEqual({
      connected: false,
      encryptionAvailable: false,
    });
  });

  test("clear removes both PAT and OAuth tokens", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-gh-auth-clear-"));
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    await setGitHubOAuthToken({ accessToken: "ghu_access", login: "dana" });
    expect(await hasGitHubToken()).toBe(true);
    await clearGitHubToken();
    expect(await hasGitHubToken()).toBe(false);
  });
});
