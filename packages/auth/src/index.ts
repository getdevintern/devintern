import { createClient } from "@supabase/supabase-js";
import type { Session, User } from "@supabase/supabase-js";
import {
  AUTH_CALLBACK_TIMEOUT_MS,
  createAuthCallbackServer,
  EMAIL_AUTH_CALLBACK_TIMEOUT_MS,
} from "./auth-callback";
import type { AuthCallbackServer } from "./auth-callback";
import { loginMethodLabel, promptForEmail, watchStdinLines } from "./login-provider";
import type { ResolvedLogin, OAuthProvider } from "./login-provider";
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
}

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
): () => void {
  return watchStdinLines((line) => {
    if (!line.trim() || callback.submitPastedCallback(line)) return;
    onStatus(
      "That is not the sign-in address. Paste the full address from the browser (it contains `code=`).",
    );
  });
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
      "Open this URL in your laptop browser:",
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
      onStatus(`If the browser does not open, visit:\n${data.url}`);
      try {
        await openUrl(data.url);
      } catch (error) {
        onStatus(
          `Could not open the browser automatically (${(error as Error).message}). Open the URL above.`,
        );
        if (acceptPaste) onStatus(PASTE_CALLBACK_HINT);
      }
    }
    if (acceptPaste) stopPaste = acceptPastedCallbacks(callback, onStatus);
    onStatus("Waiting for authentication callback...");

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
      stopPaste = acceptPastedCallbacks(callback, onStatus);
    } else if (remote) {
      onStatus(
        [
          "Remote shell detected: open the email link on your laptop after tunneling:",
          `  ssh -N -L ${callback.port}:127.0.0.1:${callback.port} user@this-host`,
        ].join("\n"),
      );
    }
    onStatus("Check your email and open the link (waiting up to 10 minutes)...");

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
