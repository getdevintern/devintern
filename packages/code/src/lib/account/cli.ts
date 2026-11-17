import { getAuthenticatedUser, login, logout, resolveLogin } from "@devintern/auth";
import { loadSupabaseConfig } from "../cli/bootstrap";
import { hasHelpArg } from "../cli/help";
import { flushAnalytics, trackLoginResult } from "../observability/analytics";

const LOGIN_USAGE = [
  "Usage: devintern login [method] [options]",
  "",
  "Sign in and persist the local auth session.",
  "",
  "Methods:",
  "  github | google | x     OAuth provider (browser sign-in)",
  "  email                   Email sign-in link",
  "",
  "Options:",
  "  --provider <method>     OAuth provider or 'email'",
  "  --email <address>       Sign in with an email address",
  "  -h, --help              Display this help message",
  "",
  "When no method is given, an interactive prompt asks how to sign in.",
].join("\n");

const LOGOUT_USAGE = [
  "Usage: devintern logout",
  "",
  "Clear the local auth session.",
  "",
  "Options:",
  "  -h, --help  Display this help message",
].join("\n");

const WHOAMI_USAGE = [
  "Usage: devintern whoami",
  "",
  "Show the currently authenticated user, if any.",
  "",
  "Options:",
  "  -h, --help  Display this help message",
].join("\n");

/** `devintern login` — sign in and persist the local auth session. */
export async function runLoginCommand(argv: string[], configDir?: string): Promise<never> {
  if (hasHelpArg(argv)) {
    console.log(LOGIN_USAGE);
    process.exit(0);
  }
  try {
    const supabaseConfig = loadSupabaseConfig(configDir);
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
  if (hasHelpArg(process.argv.slice(2))) {
    console.log(LOGOUT_USAGE);
    process.exit(0);
  }
  const supabaseConfig = loadSupabaseConfig();
  await logout(supabaseConfig);
  console.log("✅ Signed out");
  process.exit(0);
}

/** `devintern whoami` — print the currently authenticated user, if any. */
export async function runWhoamiCommand(): Promise<never> {
  if (hasHelpArg(process.argv.slice(2))) {
    console.log(WHOAMI_USAGE);
    process.exit(0);
  }
  const supabaseConfig = loadSupabaseConfig();
  const user = await getAuthenticatedUser(supabaseConfig);
  if (!user) {
    console.log("Not signed in. Run `devintern login`.");
    process.exit(0);
  }
  console.log(`Signed in as ${user.email || user.id}`);
  process.exit(0);
}
