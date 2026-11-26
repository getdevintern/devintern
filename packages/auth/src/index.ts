import { createClient } from "@supabase/supabase-js";
import type { Session, User } from "@supabase/supabase-js";
import {
  AUTH_CALLBACK_TIMEOUT_MS,
  createAuthCallbackServer,
  DEFAULT_REMOTE_AUTH_CALLBACK_PORT,
  EMAIL_AUTH_CALLBACK_TIMEOUT_MS,
  parsePastedCallback,
} from "./auth-callback";
import type { AuthCallbackServer } from "./auth-callback";
import { loginMethodLabel, promptForEmail, watchStdinLines } from "./login-provider";
import type { ResolvedLogin, OAuthProvider } from "./login-provider";
import {
  PENDING_LOGIN_TTL_MS,
  PendingLoginError,
  pastedAddressMismatch,
  pendingLoginPath,
  readPendingLogin,
  removePendingLogin,
  writePendingLogin,
} from "./pending-login";
import {
  isRemoteCliSession,
  openBrowser,
  readTextFileIfExists,
  removeFileIfExists,
  resolveAuthCallbackPort,
  writeTextFile,
} from "./runtime";
import type { AuthenticatedUser, SupabaseAuthConfig } from "./types";

export type { AuthenticatedUser, LoginMethod, OAuthProvider, SupabaseAuthConfig } from "./types";
export {
  extractLoginFromArgv,
  extractLoginProviderFromArgv,
  loginMethodLabel,
  oauthProviderLabel,
  parseOAuthProvider,
  promptForEmail,
  promptForLoginMethod,
  promptForOAuthProvider,
  resolveLogin,
  resolveLoginProvider,
  stdinClosedError,
  type ResolvedLogin,
} from "./login-provider";
export {
  AUTH_CALLBACK_TIMEOUT_MS,
  DEFAULT_REMOTE_AUTH_CALLBACK_PORT,
  EMAIL_AUTH_CALLBACK_TIMEOUT_MS,
  createAuthCallbackServer,
  parsePastedCallback,
  type PastedCallback,
} from "./auth-callback";
export { isRemoteCliSession, resolveAuthCallbackPort } from "./runtime";
export {
  PENDING_LOGIN_FILE,
  PENDING_LOGIN_TTL_MS,
  PendingLoginError,
  parsePendingLogin,
  pastedAddressMismatch,
  pendingLoginPath,
  readPendingLogin,
  type PendingLogin,
  type PendingLoginErrorCode,
} from "./pending-login";

export const DEFAULT_SUPABASE_URL = "https://robbzuhuqcgpfevaorux.supabase.co";
export const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_E31lRt1Z8hq3XuJIutiB3g_Y2sSEc5D";

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  user: {
    id: string;
    email: string | null;
    createdAt: string | null;
  };
}

/**
 * Build a {@link SupabaseAuthConfig} using the shared devintern Supabase project defaults.
 *
 * @param sessionFilePath - Absolute path where the CLI session JSON is stored.
 * @returns Supabase auth config with default URL, publishable key, and session path.
 */
export function createDefaultSupabaseAuthConfig(sessionFilePath: string): SupabaseAuthConfig {
  return {
    url: DEFAULT_SUPABASE_URL,
    publishableKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY,
    sessionFilePath,
  };
}

/** Create a Supabase client configured for CLI PKCE auth (no persisted browser session). */
function createSupabaseClient(config: SupabaseAuthConfig) {
  return createClient(config.url, config.publishableKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Optional hooks for embedding login flows in non-CLI hosts (e.g. Electron).
 *
 * Defaults preserve CLI behavior: system browser + console status messages.
 */
export interface LoginHooks {
  /** Open the sign-in URL (default: system browser). */
  openUrl?: (url: string) => Promise<void>;
  /** Receive human-readable progress messages (default: console.log). */
  onStatus?: (message: string) => void;
  /**
   * Also accept the callback address pasted on stdin, for a browser that
   * cannot reach this host's `127.0.0.1`. Defaults to `true` unless `openUrl`
   * is set (an embedding host owns the browser and has no terminal).
   */
  acceptPastedCallback?: boolean;
  /**
   * Command to sign in later. When set, pressing Enter (or typing `skip`)
   * while waiting for the browser ends the wait with a
   * {@link LoginSkippedError}, so a setup wizard can carry on without
   * sign-in. Reads stdin, so leave it unset in hosts without a terminal.
   */
  skipCommand?: string;
}

/** Thrown by a login whose wait the user skipped (see {@link LoginHooks.skipCommand}). */
export class LoginSkippedError extends Error {
  constructor(message = "Sign-in skipped.") {
    super(message);
    this.name = "LoginSkippedError";
  }
}

/** True when a login ended because the user skipped it. */
export function isLoginSkipped(error: unknown): boolean {
  return error instanceof Error && error.name === "LoginSkippedError";
}

/** Lines that skip the sign-in wait when {@link LoginHooks.skipCommand} is set. */
function isSkipLine(line: string): boolean {
  const answer = line.trim().toLowerCase();
  return answer === "" || answer === "s" || answer === "skip";
}

/** "3 minutes" for a wait in milliseconds. */
function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The sign-in address starts at Supabase, DevIntern's sign-in provider, so
 * its host is not devintern.com; say so wherever the address is shown.
 */
const SIGN_IN_LINK_NOTE = "(DevIntern sign-in, hosted by our sign-in provider Supabase)";

const PASTE_CALLBACK_HINT = [
  "Signing in from another machine? When the browser ends on a 127.0.0.1 page that",
  "does not load, copy that page's full address and paste it here, then press Enter.",
].join("\n");

/** Whether a login should read pasted callback addresses from stdin. */
function acceptsPastedCallback(hooks: LoginHooks | undefined): boolean {
  return hooks?.acceptPastedCallback ?? hooks?.openUrl === undefined;
}

/**
 * Feed callback addresses pasted on stdin to the callback server.
 *
 * @returns Stops reading stdin.
 */
function acceptPastedCallbacks(
  callback: AuthCallbackServer,
  onStatus: (message: string) => void,
  options: { acceptPaste: boolean; skipCommand?: string },
): () => void {
  return watchStdinLines((line) => {
    if (options.skipCommand && isSkipLine(line)) {
      callback.cancel(new LoginSkippedError());
      return;
    }
    if (!options.acceptPaste || !line.trim() || callback.submitPastedCallback(line)) return;
    onStatus(
      "That is not the sign-in address. Paste the full address from the browser (it contains `code=`).",
    );
  });
}

/**
 * Start reading stdin during a sign-in wait (pasted callbacks and the skip
 * key), and print the skip hint.
 *
 * @returns Stops reading stdin.
 */
export function watchLoginInput(
  callback: AuthCallbackServer,
  onStatus: (message: string) => void,
  acceptPaste: boolean,
  skipCommand: string | undefined,
): () => void {
  if (!acceptPaste && !skipCommand) return () => {};
  if (skipCommand) {
    onStatus(`Press Enter to skip and sign in later with \`${skipCommand}\`.`);
  }
  return acceptPastedCallbacks(callback, onStatus, { acceptPaste, skipCommand });
}

/** Read and validate the persisted session file, or `null` if missing or corrupt. */
async function readStoredSession(config: SupabaseAuthConfig): Promise<StoredSession | null> {
  const content = await readTextFileIfExists(config.sessionFilePath);
  if (content === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as StoredSession;
    if (!parsed.accessToken || !parsed.refreshToken) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Write session tokens and user metadata to the configured session file path. */
async function writeStoredSession(
  config: SupabaseAuthConfig,
  session: StoredSession,
): Promise<void> {
  await writeTextFile(config.sessionFilePath, JSON.stringify(session, null, 2));
}

/**
 * Persist a Supabase session to disk and return CLI user info.
 *
 * @param config - Supabase auth configuration.
 * @param session - Active Supabase session from OAuth or magic-link exchange.
 * @param user - Authenticated Supabase user record.
 * @returns Normalized authenticated user with access token.
 */
async function persistAuthenticatedSession(
  config: SupabaseAuthConfig,
  session: Session,
  user: User,
): Promise<AuthenticatedUser> {
  await writeStoredSession(config, {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
    user: {
      id: user.id,
      email: user.email ?? null,
      createdAt: user.created_at ?? null,
    },
  });

  return {
    id: user.id,
    email: user.email ?? null,
    createdAt: user.created_at ?? null,
    accessToken: session.access_token,
  };
}

/**
 * Exchange a PKCE authorization code for a session and persist it locally.
 *
 * @param config - Supabase auth configuration.
 * @param client - Supabase client used for the sign-in flow.
 * @param code - Authorization code from the local callback server.
 * @returns Authenticated user after session persistence.
 * @throws When the code exchange fails or returns no session.
 */
async function exchangeCodeAndPersist(
  config: SupabaseAuthConfig,
  client: ReturnType<typeof createSupabaseClient>,
  code: string,
): Promise<AuthenticatedUser> {
  const { data: exchanged, error: exchangeError } = await client.auth.exchangeCodeForSession(code);
  if (exchangeError || !exchanged.session || !exchanged.user) {
    throw new Error(exchangeError?.message || "Failed to exchange authorization code for session.");
  }
  return persistAuthenticatedSession(config, exchanged.session, exchanged.user);
}

/**
 * Print how to complete browser OAuth when the CLI has no local GUI (SSH/mosh).
 *
 * Pasting the address the laptop browser lands on works everywhere, including
 * mosh. SSH can instead LocalForward the fixed callback port so the laptop
 * browser reaches this process directly.
 */
function printRemoteLoginHints(
  onStatus: (message: string) => void,
  port: number,
  url: string,
  acceptPaste: boolean,
): void {
  const tunnel = `ssh -N -L ${port}:127.0.0.1:${port} user@this-host`;
  onStatus(
    [
      "Remote shell detected (SSH/mosh): a browser on this host will not complete login.",
      "",
      `Open this sign-in link in your laptop browser ${SIGN_IN_LINK_NOTE}:`,
      url,
      "",
      ...(acceptPaste
        ? [
            "The browser then ends on a 127.0.0.1 page that does not load. Copy that page's",
            "full address and paste it here, then press Enter.",
            "",
            "Or tunnel the callback before opening the URL (ssh only; mosh cannot forward ports):",
          ]
        : ["Tunnel the callback before opening the URL (ssh only; mosh cannot forward ports):"]),
      `  ${tunnel}`,
    ].join("\n"),
  );
}

/**
 * Sign in via Supabase OAuth (PKCE) using a local browser callback server.
 *
 * @param config - Supabase auth configuration.
 * @param provider - OAuth provider (`github`, `google`, or `x`).
 * @returns Authenticated user after successful browser sign-in.
 * @throws When OAuth initiation fails, the callback times out, or code exchange fails.
 */
export async function loginWithOAuth(
  config: SupabaseAuthConfig,
  provider: OAuthProvider,
  hooks?: LoginHooks,
): Promise<AuthenticatedUser> {
  const openUrl = hooks?.openUrl ?? openBrowser;
  const onStatus = hooks?.onStatus ?? console.log;
  const acceptPaste = acceptsPastedCallback(hooks);
  const client = createSupabaseClient(config);
  const providerName = loginMethodLabel(provider);
  const remote = isRemoteCliSession();
  const callbackPort = resolveAuthCallbackPort();
  const callback = await createAuthCallbackServer(
    callbackPort === undefined ? {} : { port: callbackPort },
  );

  let stopPaste = () => {};
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: callback.redirectTo,
      },
    });

    if (error) {
      throw new Error(`Could not start ${providerName} login: ${error.message}`);
    }
    if (!data.url) {
      throw new Error("Supabase did not return an OAuth URL.");
    }

    if (remote) {
      printRemoteLoginHints(onStatus, callback.port, data.url, acceptPaste);
    } else {
      onStatus(`Opening ${providerName} login in your browser...`);
      onStatus(`If the browser does not open, visit this link ${SIGN_IN_LINK_NOTE}:\n${data.url}`);
      try {
        await openUrl(data.url);
      } catch (error) {
        onStatus(
          `Could not open the browser automatically (${(error as Error).message}). Open the URL above.`,
        );
        if (acceptPaste) onStatus(PASTE_CALLBACK_HINT);
      }
    }
    stopPaste = watchLoginInput(callback, onStatus, acceptPaste, hooks?.skipCommand);
    onStatus(
      `Waiting for authentication callback (up to ${describeWait(AUTH_CALLBACK_TIMEOUT_MS)})...`,
    );

    const code = await callback.waitForCode(AUTH_CALLBACK_TIMEOUT_MS);
    return await exchangeCodeAndPersist(config, client, code);
  } finally {
    stopPaste();
    callback.stop().catch(() => {});
  }
}

/**
 * Sign in via email magic link (PKCE). Sends a link to the user's inbox;
 * clicking it completes auth through the local callback server.
 *
 * @param config - Supabase auth configuration.
 * @param email - Optional email address; prompts interactively when omitted.
 * @returns Authenticated user after the magic link is opened.
 * @throws When email is missing, OTP send fails, the callback times out, or code exchange fails.
 */
export async function loginWithEmail(
  config: SupabaseAuthConfig,
  email?: string,
  hooks?: LoginHooks,
): Promise<AuthenticatedUser> {
  const onStatus = hooks?.onStatus ?? console.log;
  const address = email?.trim() || (await promptForEmail());
  if (!address) {
    throw new Error("Email is required.");
  }

  const acceptPaste = acceptsPastedCallback(hooks);
  const client = createSupabaseClient(config);
  const remote = isRemoteCliSession();
  const callbackPort = resolveAuthCallbackPort();
  const callback = await createAuthCallbackServer(
    callbackPort === undefined ? {} : { port: callbackPort },
  );

  let stopPaste = () => {};
  try {
    const { error } = await client.auth.signInWithOtp({
      email: address,
      options: {
        emailRedirectTo: callback.redirectTo,
      },
    });

    if (error) {
      throw new Error(`Could not send sign-in email: ${error.message}`);
    }

    onStatus(`Sign-in link sent to ${address}.`);
    if (acceptPaste) {
      onStatus(
        [
          "Opening the link on another device or over SSH? It ends on a 127.0.0.1 page that",
          "does not load. Copy that page's full address and paste it here, then press Enter.",
        ].join("\n"),
      );
    } else if (remote) {
      onStatus(
        [
          "Remote shell detected: open the email link on your laptop after tunneling:",
          `  ssh -N -L ${callback.port}:127.0.0.1:${callback.port} user@this-host`,
        ].join("\n"),
      );
    }
    stopPaste = watchLoginInput(callback, onStatus, acceptPaste, hooks?.skipCommand);
    onStatus(
      `Check your email and open the link (waiting up to ${describeWait(EMAIL_AUTH_CALLBACK_TIMEOUT_MS)})...`,
    );

    const code = await callback.waitForCode(EMAIL_AUTH_CALLBACK_TIMEOUT_MS);
    return await exchangeCodeAndPersist(config, client, code);
  } finally {
    stopPaste();
    callback.stop().catch(() => {});
  }
}

/**
 * Sign in using the resolved CLI login method (OAuth or email).
 *
 * @param config - Supabase auth configuration.
 * @param resolved - Login method and optional email from argv or prompts.
 * @returns Authenticated user after sign-in completes.
 * @throws When the chosen login flow fails.
 */
export async function login(
  config: SupabaseAuthConfig,
  resolved: ResolvedLogin,
  hooks?: LoginHooks,
): Promise<AuthenticatedUser> {
  if (resolved.method === "email") {
    return loginWithEmail(config, resolved.email, hooks);
  }
  return loginWithOAuth(config, resolved.method, hooks);
}

/** Supabase storage key for the two-step sign-in client (its verifier is `<key>-code-verifier`). */
const PENDING_STORAGE_KEY = "devintern-cli-auth";
const PENDING_VERIFIER_KEY = `${PENDING_STORAGE_KEY}-code-verifier`;

/**
 * Supabase client whose auth storage is a plain map, so the PKCE code
 * verifier can be saved after starting a sign-in and restored to finish it in
 * another process. Nothing else is persisted.
 */
function createPkceClientWithStorage(config: SupabaseAuthConfig, items: Map<string, string>) {
  return createClient(config.url, config.publishableKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      // Custom storage applies only with persistSession; it is in memory.
      persistSession: true,
      storageKey: PENDING_STORAGE_KEY,
      storage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => {
          items.set(key, value);
        },
        removeItem: (key: string) => {
          items.delete(key);
        },
      },
      detectSessionInUrl: false,
    },
  });
}

/** A sign-in started with {@link startPendingLogin}. */
export interface StartedPendingLogin {
  method: ResolvedLogin["method"];
  /** Set for email sign-in: where the link was sent. */
  email?: string;
  /** Address to open in a browser; `null` for email (the link is in the inbox). */
  url: string | null;
  /** Address the browser lands on after sign-in. */
  redirectTo: string;
  /** When the pending sign-in stops being accepted (ISO 8601). */
  expiresAt: string;
}

/** Options for {@link startPendingLogin} and {@link completePendingLogin}. */
export interface PendingLoginOptions {
  /** Callback port in the redirect address (default: `DEVINTERN_AUTH_CALLBACK_PORT` or 17865). */
  port?: number;
  /** Current time in ms (tests). */
  now?: () => number;
  /** Command shown in errors to start a sign-in again. */
  startCommand?: string;
}

/**
 * Start a sign-in without waiting for it: build the sign-in address (or send
 * the email link), save the PKCE verifier to an owner-only pending file next
 * to the session file, and return. {@link completePendingLogin} finishes it
 * with the address the browser lands on. No local server is started; the
 * browser's `127.0.0.1` page will not load, and that is expected.
 *
 * @param config - Supabase auth configuration.
 * @param resolved - Login method (email needs the address).
 * @param options - Port and clock overrides.
 * @returns The address to open and the expiry.
 * @throws When the email address is missing or Supabase rejects the request.
 */
export async function startPendingLogin(
  config: SupabaseAuthConfig,
  resolved: ResolvedLogin,
  options: PendingLoginOptions = {},
): Promise<StartedPendingLogin> {
  const port =
    options.port ?? resolveAuthCallbackPort(process.env, true) ?? DEFAULT_REMOTE_AUTH_CALLBACK_PORT;
  const redirectTo = `http://127.0.0.1:${port}/auth/callback`;
  const items = new Map<string, string>();
  const client = createPkceClientWithStorage(config, items);
  let url: string | null = null;
  let email: string | undefined;
  if (resolved.method === "email") {
    email = resolved.email?.trim();
    if (!email) {
      throw new Error("Email sign-in needs the address, for example `email you@company.com`.");
    }
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw new Error(`Could not send sign-in email: ${error.message}`);
  } else {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: resolved.method,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) {
      throw new Error(
        `Could not start ${loginMethodLabel(resolved.method)} login: ${error.message}`,
      );
    }
    if (!data.url) throw new Error("Supabase did not return an OAuth URL.");
    url = data.url;
  }
  // Supabase stores JSON-encoded values; keep the plain verifier on disk.
  const stored = items.get(PENDING_VERIFIER_KEY);
  const codeVerifier = stored ? (JSON.parse(stored) as unknown) : undefined;
  if (typeof codeVerifier !== "string" || !codeVerifier) {
    throw new Error("Supabase did not create a PKCE code verifier.");
  }
  const now = options.now?.() ?? Date.now();
  const expiresAt = new Date(now + PENDING_LOGIN_TTL_MS).toISOString();
  await writePendingLogin(pendingLoginPath(config), {
    version: 1,
    method: resolved.method,
    ...(email ? { email } : {}),
    redirectTo,
    codeVerifier,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { method: resolved.method, ...(email ? { email } : {}), url, redirectTo, expiresAt };
}

/**
 * Finish a sign-in started with {@link startPendingLogin}: exchange the code
 * in the pasted address with the saved verifier, save the session exactly as
 * an interactive login does, and delete the pending file.
 *
 * @param config - Supabase auth configuration.
 * @param address - The address the browser landed on (or its `code=...` query).
 * @param options - Clock and command overrides.
 * @returns The signed-in user.
 * @throws {PendingLoginError} When nothing is pending, it expired, the address
 *   is not a sign-in address or belongs to another sign-in, or the exchange fails.
 */
export async function completePendingLogin(
  config: SupabaseAuthConfig,
  address: string,
  options: PendingLoginOptions = {},
): Promise<AuthenticatedUser> {
  const startCommand = options.startCommand ?? "devintern login github --no-wait";
  const path = pendingLoginPath(config);
  const pending = await readPendingLogin(path, startCommand, options.now?.() ?? Date.now());
  const parsed = parsePastedCallback(address);
  if (!parsed) {
    throw new PendingLoginError(
      "bad-address",
      "That is not a sign-in address. Pass the full address the browser landed on " +
        "(a 127.0.0.1 page that does not load; it contains `code=`).",
    );
  }
  if ("error" in parsed) {
    await removePendingLogin(path);
    throw new PendingLoginError(
      "oauth-error",
      `Sign-in was not completed: ${parsed.error}. Start again with \`${startCommand}\`.`,
    );
  }
  const mismatch = pastedAddressMismatch(address, pending);
  if (mismatch) throw new PendingLoginError("mismatch", mismatch);

  const items = new Map([[PENDING_VERIFIER_KEY, JSON.stringify(pending.codeVerifier)]]);
  const client = createPkceClientWithStorage(config, items);
  const { data, error } = await client.auth.exchangeCodeForSession(parsed.code);
  if (error || !data.session || !data.user) {
    // Keep the pending file: a mistyped code can be retried until it expires.
    throw new PendingLoginError(
      "exchange-failed",
      `Sign-in failed: ${error?.message || "no session was returned"}. The address works once, ` +
        "only on the host that started the sign-in, and only for a few minutes. " +
        `If it keeps failing, start again with \`${startCommand}\`.`,
    );
  }
  const user = await persistAuthenticatedSession(config, data.session, data.user);
  await removePendingLogin(path);
  return user;
}

/**
 * Sign in with GitHub OAuth.
 *
 * @param config - Supabase auth configuration.
 * @returns Authenticated user after GitHub sign-in.
 * @deprecated Use {@link loginWithOAuth} with `provider: "github"`.
 */
export async function loginWithGitHub(config: SupabaseAuthConfig): Promise<AuthenticatedUser> {
  return loginWithOAuth(config, "github");
}

/**
 * Sign out the current user and remove the local session file.
 *
 * No-op when no session file exists.
 *
 * @param config - Supabase auth configuration.
 */
export async function logout(config: SupabaseAuthConfig): Promise<void> {
  const stored = await readStoredSession(config);
  if (!stored) {
    return;
  }

  const client = createSupabaseClient(config);
  await client.auth.setSession({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
  });
  await client.auth.signOut();
  await removeFileIfExists(config.sessionFilePath);
}

/**
 * Load the stored session, refresh it with Supabase, and return the current user.
 *
 * @param config - Supabase auth configuration.
 * @returns Authenticated user, or `null` when no valid session is on disk.
 */
export async function getAuthenticatedUser(
  config: SupabaseAuthConfig,
): Promise<AuthenticatedUser | null> {
  const stored = await readStoredSession(config);
  if (!stored) {
    return null;
  }

  const client = createSupabaseClient(config);
  const { data: sessionData, error: sessionError } = await client.auth.setSession({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
  });

  if (sessionError || !sessionData.session) {
    return null;
  }

  const currentSession = sessionData.session;
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    return null;
  }

  await writeStoredSession(config, {
    accessToken: currentSession.access_token,
    refreshToken: currentSession.refresh_token,
    expiresAt: currentSession.expires_at ?? null,
    user: {
      id: userData.user.id,
      email: userData.user.email ?? null,
      createdAt: userData.user.created_at ?? null,
    },
  });

  return {
    id: userData.user.id,
    email: userData.user.email ?? null,
    createdAt: userData.user.created_at ?? null,
    accessToken: currentSession.access_token,
  };
}

/**
 * Return the authenticated user or fail with a login hint.
 *
 * @param config - Supabase auth configuration.
 * @param loginCommand - CLI command shown in the error when not signed in.
 * @returns Authenticated user.
 * @throws When no valid session exists.
 */
export async function requireAuthenticatedUser(
  config: SupabaseAuthConfig,
  loginCommand: string,
): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser(config);
  if (!user) {
    throw new Error(`Not authenticated. Run \`${loginCommand}\` first.`);
  }
  return user;
}
