/**
 * GitHub auth storage for managed clones.
 *
 * Supports two methods:
 *  - `oauth`: short-lived user access token (from the DevIntern PM GitHub App
 *    device flow) + refresh token. Refreshed transparently when expired.
 *  - `pat`: a personal access token pasted by the user (advanced fallback).
 *
 * Tokens are encrypted with Electron `safeStorage` when available, otherwise
 * stored as plaintext under userData (dev / unsupported platforms).
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { refreshOAuthToken } from "./github-oauth.ts";

/** Test-only override so unit tests avoid Electron. */
let userDataDirForTests: string | undefined;
let encryptForTests: ((plain: string) => Buffer) | undefined;
let decryptForTests: ((buf: Buffer) => string) | undefined;
let encryptionAvailableForTests: boolean | undefined;
/** Test-only override to avoid network during refresh. */
let refreshForTests:
  | ((refreshToken: string) => Promise<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    }>)
  | undefined;

/** @internal Isolate auth I/O in tests. */
export function setGitHubAuthUserDataDirForTests(dir: string | undefined): void {
  userDataDirForTests = dir;
}

/** @internal Inject crypto for tests (skip Electron safeStorage). */
export function setGitHubAuthCryptoForTests(options: {
  encrypt?: (plain: string) => Buffer;
  decrypt?: (buf: Buffer) => string;
  encryptionAvailable?: boolean;
}): void {
  encryptForTests = options.encrypt;
  decryptForTests = options.decrypt;
  encryptionAvailableForTests = options.encryptionAvailable;
}

/** @internal Inject a refresh implementation for tests. */
export function setGitHubAuthRefreshForTests(
  fn:
    | ((refreshToken: string) => Promise<{
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
      }>)
    | undefined,
): void {
  refreshForTests = fn;
}

async function userDataDir(): Promise<string> {
  if (userDataDirForTests !== undefined) return userDataDirForTests;
  const { app } = await import("electron");
  return app.getPath("userData");
}

async function tokenPath(): Promise<string> {
  return join(await userDataDir(), "github-token.json");
}

/** OAuth token fields stored encrypted as a single JSON blob. */
interface OAuthPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  login?: string;
}

interface StoredPatFile {
  kind: "pat";
  /** base64 ciphertext when encrypted; raw token when not. */
  value: string;
  encrypted: boolean;
}

interface StoredOAuthFile {
  kind: "oauth";
  /** base64 ciphertext of JSON.stringify(OAuthPayload) when encrypted; raw JSON when not. */
  value: string;
  encrypted: boolean;
}

type StoredTokenFile = StoredPatFile | StoredOAuthFile;

/** Legacy files (pre-OAuth) have no `kind` field — treat as a PAT. */
function isLegacyPatFile(raw: unknown): raw is { value: string; encrypted: boolean } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { value?: unknown }).value === "string" &&
    !("kind" in raw)
  );
}

async function isEncryptionAvailable(): Promise<boolean> {
  if (encryptionAvailableForTests !== undefined) return encryptionAvailableForTests;
  try {
    const { safeStorage } = await import("electron");
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Whether Electron safeStorage can encrypt newly stored tokens. */
export async function isGitHubTokenEncryptionAvailable(): Promise<boolean> {
  return isEncryptionAvailable();
}

/** Auth method surfaced to the UI. */
export type GitHubAuthMethod = "oauth" | "pat";

/**
 * Auth status for Settings / Connect — never includes the secret.
 * When connected, `tokenEncrypted` reflects the on-disk file (may differ from
 * current `encryptionAvailable` if the platform changed).
 */
export interface GitHubAuthStatus {
  connected: boolean;
  /** Which method is stored, when connected. */
  method?: GitHubAuthMethod;
  /** GitHub login, when known (OAuth validation or PAT validation on set). */
  login?: string;
  /** Whether Electron safeStorage encryption is available right now. */
  encryptionAvailable: boolean;
  /**
   * When connected: whether the on-disk token file uses encryption
   * (false = plaintext fallback under userData).
   */
  tokenEncrypted?: boolean;
}

export async function getGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  const encryptionAvailable = await isEncryptionAvailable();
  try {
    const raw = await readFile(await tokenPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    // Legacy files (pre-OAuth) have no `kind` field — treat as a PAT.
    if (isLegacyPatFile(parsed)) {
      const token = await decrypt({ value: parsed.value, encrypted: parsed.encrypted === true });
      const trimmed = token?.trim() ?? "";
      if (trimmed.length === 0) {
        return { connected: false, encryptionAvailable };
      }
      return {
        connected: true,
        method: "pat",
        encryptionAvailable,
        tokenEncrypted: parsed.encrypted === true,
      };
    }
    const file = parsed as StoredTokenFile;
    if (file.kind === "pat") {
      const token = await decrypt({ value: file.value, encrypted: file.encrypted === true });
      const trimmed = token?.trim() ?? "";
      if (trimmed.length === 0) {
        return { connected: false, encryptionAvailable };
      }
      return {
        connected: true,
        method: "pat",
        encryptionAvailable,
        tokenEncrypted: file.encrypted === true,
      };
    }
    if (file.kind === "oauth") {
      const payload = await decryptOAuth({ value: file.value, encrypted: file.encrypted === true });
      if (!payload) {
        return { connected: false, encryptionAvailable };
      }
      return {
        connected: true,
        method: "oauth",
        login: payload.login,
        encryptionAvailable,
        tokenEncrypted: file.encrypted === true,
      };
    }
    return { connected: false, encryptionAvailable };
  } catch {
    return { connected: false, encryptionAvailable };
  }
}

async function encrypt(plain: string): Promise<{ value: string; encrypted: boolean }> {
  if (encryptForTests) {
    return { value: encryptForTests(plain).toString("base64"), encrypted: true };
  }
  if (await isEncryptionAvailable()) {
    const { safeStorage } = await import("electron");
    return {
      value: safeStorage.encryptString(plain).toString("base64"),
      encrypted: true,
    };
  }
  return { value: plain, encrypted: false };
}

async function decrypt(stored: { value: string; encrypted: boolean }): Promise<string | null> {
  try {
    if (!stored.encrypted) return stored.value;
    if (decryptForTests) {
      return decryptForTests(Buffer.from(stored.value, "base64"));
    }
    const { safeStorage } = await import("electron");
    return safeStorage.decryptString(Buffer.from(stored.value, "base64"));
  } catch {
    return null;
  }
}

async function decryptOAuth(stored: {
  value: string;
  encrypted: boolean;
}): Promise<OAuthPayload | null> {
  const text = await decrypt(stored);
  if (!text) return null;
  try {
    return JSON.parse(text) as OAuthPayload;
  } catch {
    return null;
  }
}

/** Whether a non-empty GitHub token is stored. Never returns the secret. */
export async function hasGitHubToken(): Promise<boolean> {
  const token = await getGitHubToken();
  return Boolean(token);
}

/** Refresh window: refresh tokens expiring within this many ms. */
const REFRESH_BUFFER_MS = 60_000;

async function readStoredFile(): Promise<StoredTokenFile | null> {
  try {
    const raw = await readFile(await tokenPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isLegacyPatFile(parsed)) {
      return { kind: "pat", value: parsed.value, encrypted: parsed.encrypted === true };
    }
    const file = parsed as StoredTokenFile;
    if (file.kind === "pat" || file.kind === "oauth") {
      return file;
    }
    return null;
  } catch {
    return null;
  }
}

async function persist(file: StoredTokenFile): Promise<void> {
  const path = await tokenPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Read the stored access token, refreshing OAuth tokens that are expired or
 * about to expire. Returns null when missing / undecryptable / refresh failed.
 */
export async function getGitHubToken(): Promise<string | null> {
  const file = await readStoredFile();
  if (!file) return null;
  if (file.kind === "pat") {
    const token = await decrypt({ value: file.value, encrypted: file.encrypted });
    const trimmed = token?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  }
  const payload = await decryptOAuth({ value: file.value, encrypted: file.encrypted });
  if (!payload) return null;
  const trimmed = payload.accessToken?.trim() ?? "";
  if (trimmed.length === 0) return null;
  // Refresh only when we have a refresh token and the access token is stale.
  if (
    payload.refreshToken &&
    payload.expiresAt &&
    payload.expiresAt - Date.now() < REFRESH_BUFFER_MS
  ) {
    try {
      const refreshed = refreshForTests
        ? await refreshForTests(payload.refreshToken)
        : await refreshOAuthToken(payload.refreshToken);
      const next: OAuthPayload = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? payload.refreshToken,
        expiresAt: refreshed.expiresAt,
        login: payload.login,
      };
      const stored = await encrypt(JSON.stringify(next));
      await persist({ kind: "oauth", ...stored });
      return next.accessToken.trim() || null;
    } catch {
      // Refresh failed — surface as no token so callers get auth_required.
      return null;
    }
  }
  return trimmed;
}

/** Persist a PAT (overwrites any previous token). */
export async function setGitHubToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("GitHub token cannot be empty.");
  }
  const stored = await encrypt(trimmed);
  await persist({ kind: "pat", ...stored });
}

/** Persist an OAuth token set (overwrites any previous token). */
export async function setGitHubOAuthToken(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  login?: string;
}): Promise<void> {
  const trimmed = tokens.accessToken.trim();
  if (!trimmed) {
    throw new Error("GitHub access token cannot be empty.");
  }
  const payload: OAuthPayload = {
    accessToken: trimmed,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    login: tokens.login,
  };
  const stored = await encrypt(JSON.stringify(payload));
  await persist({ kind: "oauth", ...stored });
}

/** Remove the stored token (PAT or OAuth). */
export async function clearGitHubToken(): Promise<void> {
  try {
    await rm(await tokenPath(), { force: true });
  } catch {
    // ignore
  }
}
