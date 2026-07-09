import { createClient } from "@supabase/supabase-js";
import type { SupabaseAuthConfig } from "./types";

/** Supabase client authenticated with a bearer access token for REST calls. */
function createAuthenticatedClient(config: SupabaseAuthConfig, accessToken: string) {
  return createClient(config.url, config.publishableKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

/**
 * Records the start of a user's trial on first successful CLI auth.
 *
 * Idempotent — safe to call on every login.
 *
 * @param config - Supabase auth configuration.
 * @param userId - Supabase user id.
 * @param accessToken - User access token for authenticated REST calls.
 * @throws When the insert fails for reasons other than duplicate key (`23505`).
 */
export async function startUserTrial(
  config: SupabaseAuthConfig,
  userId: string,
  accessToken: string,
): Promise<void> {
  const client = createAuthenticatedClient(config, accessToken);
  const { error } = await client.from("user_trials").insert({ user_id: userId });

  if (error && error.code !== "23505") {
    throw new Error(`Failed to start trial: ${error.message}`);
  }
}

/**
 * Fetch the ISO timestamp when the user's trial started.
 *
 * @param config - Supabase auth configuration.
 * @param accessToken - User access token for authenticated REST calls.
 * @returns Trial start timestamp, or `null` when no trial row exists or the query fails.
 */
export async function getUserTrialStartedAt(
  config: SupabaseAuthConfig,
  accessToken: string,
): Promise<string | null> {
  const client = createAuthenticatedClient(config, accessToken);
  const { data, error } = await client.from("user_trials").select("started_at").maybeSingle();

  if (error) {
    return null;
  }

  return data?.started_at ?? null;
}
