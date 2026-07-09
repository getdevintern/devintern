import { dirname } from "node:path";
import { createClient, type Session, type User } from "@supabase/supabase-js";
import {
  AUTH_CALLBACK_TIMEOUT_MS,
  createAuthCallbackServer,
  EMAIL_AUTH_CALLBACK_TIMEOUT_MS,
} from "./auth-callback";
import {
  loginMethodLabel,
  promptForEmail,
  type ResolvedLogin,
  resolveLogin,
  type OAuthProvider,
} from "./login-provider";
import type { AuthenticatedUser, LoginMethod, SupabaseAuthConfig } from "./types";

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
  type ResolvedLogin,
} from "./login-provider";
export {
  AUTH_CALLBACK_TIMEOUT_MS,
  EMAIL_AUTH_CALLBACK_TIMEOUT_MS,
  createAuthCallbackServer,
} from "./auth-callback";

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

/** Open a URL in the system default browser (macOS, Windows, or Linux). */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const proc = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** Read and validate the persisted session file, or `null` if missing or corrupt. */
async function readStoredSession(config: SupabaseAuthConfig): Promise<StoredSession | null> {
  const file = Bun.file(config.sessionFilePath);
  if (!(await file.exists())) {
    return null;
  }

  try {
    const parsed = JSON.parse(await file.text()) as StoredSession;
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
  const sessionDir = dirname(config.sessionFilePath);
  await Bun.$`mkdir -p ${sessionDir}`;
  await Bun.write(config.sessionFilePath, JSON.stringify(session, null, 2));
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
): Promise<AuthenticatedUser> {
  const client = createSupabaseClient(config);
  const providerName = loginMethodLabel(provider);
  const callback = createAuthCallbackServer();

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

    console.log(`Opening ${providerName} login in your browser...`);
    await openBrowser(data.url);
    console.log("Waiting for authentication callback...");

    const code = await callback.waitForCode(AUTH_CALLBACK_TIMEOUT_MS);
    return exchangeCodeAndPersist(config, client, code);
  } finally {
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
): Promise<AuthenticatedUser> {
  const address = email?.trim() || (await promptForEmail());
  if (!address) {
    throw new Error("Email is required.");
  }

  const client = createSupabaseClient(config);
  const callback = createAuthCallbackServer();

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

    console.log(`Sign-in link sent to ${address}.`);
    console.log("Check your email and open the link (waiting up to 10 minutes)...");

    const code = await callback.waitForCode(EMAIL_AUTH_CALLBACK_TIMEOUT_MS);
    return exchangeCodeAndPersist(config, client, code);
  } finally {
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
): Promise<AuthenticatedUser> {
  if (resolved.method === "email") {
    return loginWithEmail(config, resolved.email);
  }
  return loginWithOAuth(config, resolved.method);
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
  await Bun.$`rm -f ${config.sessionFilePath}`;
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
