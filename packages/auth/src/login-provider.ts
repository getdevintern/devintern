import type { LoginMethod, OAuthProvider } from "./types";

export type { LoginMethod, OAuthProvider } from "./types";

const OAUTH_PROVIDERS: OAuthProvider[] = ["github", "google", "x"];

const LOGIN_METHODS: LoginMethod[] = [...OAUTH_PROVIDERS, "email"];

const OAUTH_LABELS: Record<OAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
  x: "X",
};

const LOGIN_LABELS: Record<LoginMethod, string> = {
  ...OAUTH_LABELS,
  email: "Email",
};

export interface ResolvedLogin {
  method: LoginMethod;
  /** Set when method is `email`. */
  email?: string;
}

/**
 * Parse a CLI OAuth provider argument. Accepts `twitter` as an alias for `x`.
 *
 * @param value - Raw provider string from argv.
 * @returns Normalized OAuth provider id.
 * @throws When value is missing or unrecognized.
 */
export function parseOAuthProvider(value: string | undefined): OAuthProvider {
  if (!value) {
    throw new Error("Login provider is required.");
  }

  const normalized = value.toLowerCase();
  if (normalized === "twitter") {
    return "x";
  }
  if (normalized === "github" || normalized === "google" || normalized === "x") {
    return normalized;
  }

  throw new Error(`Unknown login provider "${value}". Use one of: github, google, x, email`);
}

/** Basic email format check for argv parsing and interactive prompts. */
function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Parse a login method string, treating magic-link aliases as `email`. */
function parseLoginMethod(value: string): LoginMethod {
  const normalized = value.toLowerCase();
  if (normalized === "email" || normalized === "magic-link" || normalized === "magiclink") {
    return "email";
  }
  return parseOAuthProvider(value);
}

/**
 * Human-readable login method name for CLI messages.
 *
 * @param method - OAuth provider or `email`.
 * @returns Display label (e.g. "GitHub", "Email").
 */
export function loginMethodLabel(method: LoginMethod): string {
  return LOGIN_LABELS[method];
}

/**
 * Human-readable OAuth provider name for CLI messages.
 *
 * @param provider - OAuth provider id.
 * @returns Display label for the provider.
 * @deprecated Use {@link loginMethodLabel}.
 */
export function oauthProviderLabel(provider: OAuthProvider): string {
  return loginMethodLabel(provider);
}

/** Read one line from stdin (inherits TTY for interactive prompts). */
async function readStdinLine(): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", 'read line && echo "$line"'], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

/**
 * Read login method from CLI argv when explicitly passed.
 *
 * Returns null when the user should be prompted interactively.
 *
 * @param argv - Process argv (e.g. `process.argv`).
 * @returns Resolved login from flags/positional args, or `null` to prompt.
 * @throws When `--email` is passed without an address.
 */
export function extractLoginFromArgv(argv: string[]): ResolvedLogin | null {
  const emailFlagIndex = argv.indexOf("--email");
  if (emailFlagIndex >= 0) {
    const email = argv[emailFlagIndex + 1]?.trim();
    if (!email) {
      throw new Error(
        "--email requires an address (e.g. devintern login --email you@company.com).",
      );
    }
    return { method: "email", email };
  }

  const providerFlagIndex = argv.indexOf("--provider");
  if (providerFlagIndex >= 0) {
    const value = argv[providerFlagIndex + 1];
    if (isEmailAddress(value ?? "")) {
      return { method: "email", email: value };
    }
    return { method: parseLoginMethod(value ?? "") };
  }

  const loginIndex = argv.indexOf("login");
  if (loginIndex >= 0) {
    const next = argv[loginIndex + 1];
    if (next && !next.startsWith("-")) {
      if (isEmailAddress(next)) {
        return { method: "email", email: next };
      }
      const method = parseLoginMethod(next);
      return { method };
    }
  }

  return null;
}

/**
 * Read OAuth provider from CLI argv (email login returns `null`).
 *
 * @param argv - Process argv (e.g. `process.argv`).
 * @returns OAuth provider when argv specifies one, otherwise `null`.
 * @deprecated Use {@link extractLoginFromArgv}.
 */
export function extractLoginProviderFromArgv(argv: string[]): OAuthProvider | null {
  const resolved = extractLoginFromArgv(argv);
  if (!resolved || resolved.method === "email") {
    return resolved?.method === "email" ? null : (resolved as null);
  }
  return resolved.method;
}

/**
 * Prompt for an email address until a valid address is entered.
 *
 * @returns Validated email address.
 */
export async function promptForEmail(): Promise<string> {
  while (true) {
    process.stdout.write("Enter your email: ");
    const email = (await readStdinLine()).trim();
    if (isEmailAddress(email)) {
      return email;
    }
    console.log("Invalid email address. Try again.");
  }
}

/**
 * Prompt the user to pick a sign-in method (for `login` without arguments).
 *
 * @returns Resolved login method and email when email is chosen.
 */
export async function promptForLoginMethod(): Promise<ResolvedLogin> {
  console.log("Select sign-in method (use the same one as on devintern.com):");
  for (const [index, method] of LOGIN_METHODS.entries()) {
    console.log(`  ${index + 1}. ${loginMethodLabel(method)}`);
  }

  while (true) {
    process.stdout.write(`Enter choice [1-${LOGIN_METHODS.length}] or method name: `);

    const answer = (await readStdinLine()).trim();
    const asNumber = Number.parseInt(answer, 10);
    if (asNumber >= 1 && asNumber <= LOGIN_METHODS.length) {
      const method = LOGIN_METHODS[asNumber - 1]!;
      if (method === "email") {
        return { method, email: await promptForEmail() };
      }
      return { method };
    }

    if (isEmailAddress(answer)) {
      return { method: "email", email: answer };
    }

    if (answer) {
      try {
        const method = parseLoginMethod(answer);
        if (method === "email") {
          return { method, email: await promptForEmail() };
        }
        return { method };
      } catch {
        // fall through to retry
      }
    }

    console.log(`Invalid choice. Enter 1-${LOGIN_METHODS.length}, or github/google/x/email.`);
  }
}

/**
 * Prompt the user to pick an OAuth provider.
 *
 * @returns Selected OAuth provider.
 * @throws When the user selects email login instead.
 * @deprecated Use {@link promptForLoginMethod}.
 */
export async function promptForOAuthProvider(): Promise<OAuthProvider> {
  const resolved = await promptForLoginMethod();
  if (resolved.method === "email") {
    throw new Error("Email login selected; use resolveLogin() instead.");
  }
  return resolved.method;
}

/**
 * Resolve login method from argv or an interactive prompt when omitted.
 *
 * Prompts for email when method is email and address was not passed.
 *
 * @param argv - Process argv (e.g. `process.argv`).
 * @returns Resolved login method and optional email.
 * @throws When argv contains invalid provider flags or values.
 */
export async function resolveLogin(argv: string[]): Promise<ResolvedLogin> {
  const fromArgv = extractLoginFromArgv(argv);
  if (fromArgv) {
    if (fromArgv.method === "email" && !fromArgv.email) {
      fromArgv.email = await promptForEmail();
    }
    return fromArgv;
  }
  return promptForLoginMethod();
}

/**
 * Resolve OAuth provider from argv or an interactive prompt when omitted.
 *
 * @param argv - Process argv (e.g. `process.argv`).
 * @returns Selected OAuth provider.
 * @throws When email login is selected or argv is invalid.
 * @deprecated Use {@link resolveLogin}.
 */
export async function resolveLoginProvider(argv: string[]): Promise<OAuthProvider> {
  const resolved = await resolveLogin(argv);
  if (resolved.method === "email") {
    throw new Error("Email login selected; use resolveLogin() instead.");
  }
  return resolved.method;
}
