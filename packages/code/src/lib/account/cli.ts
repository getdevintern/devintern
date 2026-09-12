import { getAuthenticatedUser, login, logout, resolveLogin } from "@devintern/auth";
import { loadSupabaseConfig } from "../cli/bootstrap";
import { flushAnalytics, trackLoginResult } from "../observability/analytics";

/** `devintern login` — sign in and persist the local auth session. */
export async function runLoginCommand(argv: string[]): Promise<never> {
  try {
    const supabaseConfig = loadSupabaseConfig();
    const resolved = await resolveLogin(argv);
    const user = await login(supabaseConfig, resolved);
    console.log(`✅ Signed in as ${user.email || user.id}`);
    await trackLoginResult({ outcome: "succeeded", method: resolved.method });
    await flushAnalytics();
    process.exit(0);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    await trackLoginResult({ outcome: "failed" });
    await flushAnalytics();
    process.exit(1);
  }
}

/** `devintern logout` — clear the local auth session. */
export async function runLogoutCommand(): Promise<never> {
  const supabaseConfig = loadSupabaseConfig();
  await logout(supabaseConfig);
  console.log("✅ Signed out");
  process.exit(0);
}

/** `devintern whoami` — print the currently authenticated user, if any. */
export async function runWhoamiCommand(): Promise<never> {
  const supabaseConfig = loadSupabaseConfig();
  const user = await getAuthenticatedUser(supabaseConfig);
  if (!user) {
    console.log("Not signed in. Run `devintern login`.");
    process.exit(0);
  }
  console.log(`Signed in as ${user.email || user.id}`);
  process.exit(0);
}
