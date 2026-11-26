import {
  completePendingLogin,
  getAuthenticatedUser,
  login,
  logout,
  PendingLoginError,
  promptForEmail,
  promptForLoginMethod,
  startPendingLogin,
} from "@devintern/auth";
import type {
  AuthenticatedUser,
  ResolvedLogin,
  StartedPendingLogin,
  SupabaseAuthConfig,
} from "@devintern/auth";
import { loadSupabaseConfig } from "../cli/bootstrap";
import { hasHelpArg } from "../cli/help";
import { flushAnalytics, trackLoginResult } from "../observability/analytics";
import { parseLoginArgs } from "./login-args";
import type { LoginArgs } from "./login-args";
import { WORKER_LOGIN_COMMAND, WORKER_PILOT_OFFER } from "./worker-pilot";

/** `schema` of the `login --json` document. */
export const LOGIN_JSON_SCHEMA = "devintern.login";
/** Current `login --json` document version. */
export const LOGIN_JSON_VERSION = 1;

/** Help text for `devintern login` or `devintern worker login`. */
function loginUsage(commandName: string): string {
  const worker = commandName.startsWith(WORKER_LOGIN_COMMAND);
  return [
    `Usage: ${commandName} [method] [options]${worker ? " [--workspace <path>]" : ""}`,
    `       ${commandName} <method> --no-wait [--json]`,
    `       ${commandName} --complete '<address>' [--json]`,
    "",
    worker
      ? `Sign in for the worker workspace (starts your ${WORKER_PILOT_OFFER}).`
      : "Sign in and persist the local auth session.",
    "",
    "Methods:",
    "  github | google | x     OAuth provider (browser sign-in)",
    "  email <address>         Email sign-in link",
    "",
    "Options:",
    "  --provider <method>     OAuth provider or 'email'",
    "  --email <address>       Sign in with an email address",
    "  --no-wait               Print the sign-in address and exit; finish with --complete",
    "  --complete <address>    Finish a --no-wait sign-in with the address the browser",
    "                          landed on (a 127.0.0.1 page that does not load)",
    "  --json                  Print one JSON document on stdout",
    ...(worker ? ["  --workspace <path>      Use this workspace.toml"] : []),
    "  -h, --help              Display this help message",
    "",
    "When no method is given, an interactive prompt asks how to sign in.",
    "If the browser runs on another machine (SSH, a container), paste the address",
    "it ends on into this terminal, or use --no-wait and --complete.",
  ].join("\n");
}

/** JSON summary of a started `--no-wait` sign-in (also embedded by `worker init`). */
export interface PendingSignIn {
  url: string | null;
  method: StartedPendingLogin["method"];
  expiresAt: string;
  /** Command that finishes the sign-in on this host. */
  complete: string;
  /** True when this is the sign-in already waiting (same address), not a new one. */
  reused?: boolean;
}

/**
 * Summarize a started sign-in with the command that finishes it.
 *
 * @param started - Result of `startPendingLogin`.
 * @param commandName - Login command (may include `--workspace <path>`).
 * @returns The `{url, method, expiresAt, complete}` summary.
 */
export function pendingSignInSummary(
  started: StartedPendingLogin,
  commandName: string,
): PendingSignIn {
  return {
    url: started.url,
    method: started.method,
    expiresAt: started.expiresAt,
    complete: `${commandName} --complete '<address>'`,
    ...(started.reused ? { reused: true } : {}),
  };
}

/**
 * Text instructions for a started sign-in.
 *
 * @param signIn - Summary from {@link pendingSignInSummary}.
 * @param email - Where an email link was sent.
 * @returns Lines to print.
 */
export function renderPendingSignIn(signIn: PendingSignIn, email?: string): string[] {
  const first = signIn.url
    ? ["Open this address in a browser on any machine and sign in:", `  ${signIn.url}`]
    : [`Sign-in link sent to ${email ?? "your inbox"}. Open it in a browser on any machine.`];
  return [
    ...(signIn.reused
      ? ["A sign-in started earlier is still waiting; this is the same address, still valid.", ""]
      : []),
    ...first,
    "",
    "The browser then lands on a 127.0.0.1 page that does not load. That is expected.",
    "Copy that page's full address and run this on this host:",
    `  ${signIn.complete}`,
    "",
    `The address works once, only on this host, until ${signIn.expiresAt}.`,
  ];
}

/** Injectable sign-in functions (tests). */
export interface LoginCommandDeps {
  login?: typeof login;
  startPendingLogin?: typeof startPendingLogin;
  completePendingLogin?: typeof completePendingLogin;
  promptForLoginMethod?: typeof promptForLoginMethod;
  promptForEmail?: typeof promptForEmail;
  /** stdout writer for the JSON document. */
  writeStdout?: (text: string) => void;
}

/** Sign-in method from the parsed arguments, prompting when one is missing. */
async function resolveMethod(args: LoginArgs, deps: LoginCommandDeps): Promise<ResolvedLogin> {
  if (!args.method) return (deps.promptForLoginMethod ?? promptForLoginMethod)();
  if (args.method === "email") {
    return {
      method: "email",
      email: args.email ?? (await (deps.promptForEmail ?? promptForEmail)()),
    };
  }
  return { method: args.method };
}

function signedInDoc(user: AuthenticatedUser) {
  return {
    schema: LOGIN_JSON_SCHEMA,
    version: LOGIN_JSON_VERSION,
    result: "signed_in" as const,
    user: { id: user.id, email: user.email },
  };
}

/**
 * Run a parsed `login` command and report the result.
 *
 * @param args - Parsed arguments.
 * @param config - Supabase auth configuration for the session file.
 * @param commandName - Command shown in messages (may include `--workspace <path>`).
 * @param deps - Injectable sign-in functions.
 * @returns Process exit code.
 */
export async function executeLogin(
  args: LoginArgs,
  config: SupabaseAuthConfig,
  commandName: string,
  deps: LoginCommandDeps = {},
): Promise<number> {
  const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  const worker = commandName.startsWith(WORKER_LOGIN_COMMAND);
  const startCommand = `${commandName} github --no-wait`;
  let method: string | undefined = args.method;
  try {
    if (args.complete !== undefined) {
      const user = await (deps.completePendingLogin ?? completePendingLogin)(
        config,
        args.complete,
        { startCommand },
      );
      reportSignedIn(user, args.json, worker, writeStdout);
      await trackLoginResult({ outcome: "succeeded" });
      return 0;
    }
    const resolved = await resolveMethod(args, deps);
    method = resolved.method;
    if (args.noWait) {
      const started = await (deps.startPendingLogin ?? startPendingLogin)(config, resolved);
      if (args.json) {
        writeStdout(
          `${JSON.stringify(
            {
              schema: LOGIN_JSON_SCHEMA,
              version: LOGIN_JSON_VERSION,
              result: "pending",
              ...pendingSignInSummary(started, commandName),
            },
            null,
            2,
          )}\n`,
        );
      } else {
        console.log(
          renderPendingSignIn(pendingSignInSummary(started, commandName), started.email).join("\n"),
        );
      }
      return 0;
    }
    const user = await (deps.login ?? login)(config, resolved);
    reportSignedIn(user, args.json, worker, writeStdout);
    await trackLoginResult({ outcome: "succeeded", method: resolved.method });
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    const noTerminal = (error as Error).name === "AbortError";
    const hint = noTerminal
      ? `No terminal to answer the prompt. Pass it as arguments: \`${commandName} github\` ` +
        `(or google, x) or \`${commandName} email you@company.com\`.`
      : undefined;
    if (args.json) {
      writeStdout(
        `${JSON.stringify(
          {
            schema: LOGIN_JSON_SCHEMA,
            version: LOGIN_JSON_VERSION,
            result: "failure",
            error: hint ? `${message} ${hint}` : message,
            ...(error instanceof PendingLoginError ? { code: error.code } : {}),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`❌ ${message}`);
      if (hint) console.error(`   ${hint}`);
    }
    await trackLoginResult({ outcome: "failed", method });
    return 1;
  }
}

function reportSignedIn(
  user: AuthenticatedUser,
  json: boolean,
  worker: boolean,
  writeStdout: (text: string) => void,
): void {
  if (json) {
    writeStdout(`${JSON.stringify(signedInDoc(user), null, 2)}\n`);
    return;
  }
  console.log(`✅ Signed in as ${user.email || user.id}`);
  if (worker) {
    console.log(
      `   Your ${WORKER_PILOT_OFFER} starts when the worker first starts. Check with \`devintern worker doctor\`.`,
    );
  }
}

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

/**
 * `devintern login` — sign in and persist the local auth session.
 *
 * @param argv - Process-style argv (`["devintern", "login", ...]`).
 * @param configDir - State directory that receives the session file.
 * @param commandName - Command shown in hints (`devintern worker login` for workers).
 */
export async function runLoginCommand(
  argv: string[],
  configDir?: string,
  commandName = "devintern login",
): Promise<never> {
  const loginIndex = argv.indexOf("login");
  const rest = loginIndex >= 0 ? argv.slice(loginIndex + 1) : [];
  const parsed = parseLoginArgs(rest, commandName);
  if (!parsed.ok) {
    if (rest.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema: LOGIN_JSON_SCHEMA,
            version: LOGIN_JSON_VERSION,
            result: "failure",
            error: parsed.error,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`❌ ${parsed.error}`);
    }
    process.exit(1);
  }
  if (parsed.args.help) {
    console.log(loginUsage(commandName));
    process.exit(0);
  }
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  if (parsed.args.json) {
    // stdout carries only the JSON document; progress messages go to stderr.
    const toStderr = (...parts: unknown[]) => console.error(...parts);
    console.log = toStderr;
    console.info = toStderr;
    console.warn = toStderr;
  }
  const code = await executeLogin(parsed.args, loadSupabaseConfig(configDir), commandName, {
    writeStdout: (text) => {
      stdoutWrite(text);
    },
  });
  await flushAnalytics();
  process.exit(code);
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
