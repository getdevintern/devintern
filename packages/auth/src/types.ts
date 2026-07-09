/** Supabase OAuth providers supported for CLI browser login. */
export type OAuthProvider = "github" | "google" | "x";

/** CLI sign-in methods (OAuth providers or email magic link). */
export type LoginMethod = OAuthProvider | "email";

export interface SupabaseAuthConfig {
  url: string;
  publishableKey: string;
  sessionFilePath: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  createdAt: string | null;
  /** Current Supabase access token — use to authenticate to devintern.com APIs. */
  accessToken: string;
}
