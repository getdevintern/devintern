/**
 * GitHub OAuth device flow for the DevIntern PM GitHub App.
 *
 * Public Client ID is baked in at build time (see electron.vite.config.ts).
 * Device flow needs no client secret, so it is safe for an Electron app.
 * Tokens are short-lived (~8h) and refreshable; storage lives in github-auth.ts.
 */

import { validateGitHubToken } from "./github-api.ts";
import { setGitHubOAuthToken } from "./github-auth.ts";

const GITHUB_LOGIN = "https://github.com";
const GITHUB_API = "https://api.github.com";

/** Client ID baked in at build time (empty when not configured). */
export const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID ?? "";

/** Whether the OAuth sign-in path is available (Client ID configured). */
export function isGitHubOAuthAvailable(): boolean {
  return clientId().length > 0;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Test-only override for the Client ID (avoids touching process.env in tests). */
let clientIdForTests: string | undefined;
export function setGitHubOAuthClientIdForTests(id: string | undefined): void {
  clientIdForTests = id;
}
function clientId(): string {
  return clientIdForTests !== undefined ? clientIdForTests : GITHUB_OAUTH_CLIENT_ID;
}

/** Test-only fetch injection so tests never hit the network. */
let fetchForTests: FetchLike | undefined;
export function setGitHubOAuthFetchForTests(fetch: FetchLike | undefined): void {
  fetchForTests = fetch;
}
function fetchImpl(): FetchLike {
  return fetchForTests ?? fetch;
}

/** Test-only override for the openExternal callback. */
let openExternalForTests: ((url: string) => Promise<void>) | undefined;
export function setGitHubOAuthOpenExternalForTests(
  fn: ((url: string) => Promise<void>) | undefined,
): void {
  openExternalForTests = fn;
}
async function openExternal(url: string): Promise<void> {
  if (openExternalForTests) {
    await openExternalForTests(url);
    return;
  }
  const { shell } = await import("electron");
  await shell.openExternal(url);
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Raw GitHub device-code response (snake_case). */
interface DeviceCodeApiResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
}

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  login?: string;
}

/** Error with a stable code for IPC/UI branching. */
export class GitHubOAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Request a device + user code from GitHub. */
export async function requestDeviceCode(
  fetchFn: FetchLike = fetchImpl(),
): Promise<DeviceCodeResponse> {
  const id = clientId();
  if (!id) {
    throw new GitHubOAuthError("not_configured", "GitHub OAuth is not configured.");
  }
  const response = await fetchFn(`${GITHUB_LOGIN}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: id }),
  });
  if (!response.ok) {
    throw new GitHubOAuthError(
      "error",
      `Could not start GitHub sign-in (HTTP ${response.status}). Try again.`,
    );
  }
  const data = (await response.json()) as DeviceCodeApiResponse;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new GitHubOAuthError("error", "GitHub returned an incomplete sign-in response.");
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(data: TokenResponse): OAuthTokenSet {
  if (data.error) {
    throw new GitHubOAuthError(
      data.error === "expired_token" ? "expired" : "denied",
      data.error_description ?? data.error,
    );
  }
  if (!data.access_token) {
    throw new GitHubOAuthError("error", "GitHub did not return an access token.");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  };
}

/** Poll the token endpoint until the user authorizes or the flow expires. */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  options: {
    fetch?: FetchLike;
    signal?: AbortSignal;
    onPrompt?: (prompt: DeviceCodePrompt) => void;
  } = {},
): Promise<OAuthTokenSet> {
  const id = clientId();
  if (!id) {
    throw new GitHubOAuthError("not_configured", "GitHub OAuth is not configured.");
  }
  const fetchFn = options.fetch ?? fetchImpl();
  const deadline = Date.now() + expiresInSeconds * 1000;
  const intervalMs = Math.max(intervalSeconds, 1) * 1000;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new GitHubOAuthError("cancelled", "Sign-in was cancelled.");
    }
    await sleep(intervalMs, options.signal);
    if (options.signal?.aborted) {
      throw new GitHubOAuthError("cancelled", "Sign-in was cancelled.");
    }

    const response = await fetchFn(`${GITHUB_LOGIN}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!response.ok) {
      throw new GitHubOAuthError(
        "error",
        `GitHub sign-in failed (HTTP ${response.status}). Try again.`,
      );
    }
    const data = (await response.json()) as TokenResponse;
    if (data.error === "authorization_pending") {
      continue;
    }
    if (data.error === "slow_down") {
      await sleep(intervalMs, options.signal);
      continue;
    }
    return parseTokenResponse(data);
  }
  throw new GitHubOAuthError("expired", "The sign-in code expired. Try again.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitHubOAuthError("cancelled", "Sign-in was cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new GitHubOAuthError("cancelled", "Sign-in was cancelled."));
      },
      { once: true },
    );
  });
}

/** Refresh an expired user access token using the stored refresh token. */
export async function refreshOAuthToken(
  refreshToken: string,
  fetchFn: FetchLike = fetchImpl(),
): Promise<OAuthTokenSet> {
  const id = clientId();
  if (!id) {
    throw new GitHubOAuthError("not_configured", "GitHub OAuth is not configured.");
  }
  const response = await fetchFn(`${GITHUB_LOGIN}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: id,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new GitHubOAuthError(
      "refresh_failed",
      `Could not refresh GitHub sign-in (HTTP ${response.status}).`,
    );
  }
  const data = (await response.json()) as TokenResponse;
  if (data.error) {
    throw new GitHubOAuthError("refresh_failed", data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new GitHubOAuthError("refresh_failed", "GitHub did not return a refreshed token.");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  };
}

/** Run the full device flow: request code → open browser → poll → persist. */
export async function runDeviceFlow(
  options: {
    signal?: AbortSignal;
    onPrompt?: (prompt: DeviceCodePrompt) => void;
  } = {},
): Promise<OAuthTokenSet> {
  const code = await requestDeviceCode();
  const prompt: DeviceCodePrompt = {
    userCode: code.userCode,
    verificationUri: code.verificationUri,
  };
  await openExternal(code.verificationUri);
  options.onPrompt?.(prompt);
  const tokens = await pollForToken(code.deviceCode, code.interval, code.expiresIn, {
    signal: options.signal,
  });
  const validated = await validateGitHubToken(tokens.accessToken, fetchImpl());
  if (!validated.ok) {
    throw new GitHubOAuthError("error", validated.message);
  }
  const finalTokens: OAuthTokenSet = { ...tokens, login: validated.login };
  await setGitHubOAuthToken(finalTokens);
  return finalTokens;
}

export { GITHUB_API };
