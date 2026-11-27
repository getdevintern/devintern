/**
 * Strict argument parsing for `devintern login` and `devintern worker login`.
 * Every argument is either understood or rejected: an ignored flag (such as a
 * guessed `--no-browser`) would otherwise start a sign-in the caller did not ask for.
 */

import type { LoginMethod, ResolvedLogin } from "@devintern/auth";

import { WORKER_LOGIN_COMMAND } from "./worker-pilot";

/** Parsed `login` arguments. */
export interface LoginArgs {
  /** Sign-in method; prompts when omitted (terminal only). */
  method?: LoginMethod;
  /** Address for email sign-in. */
  email?: string;
  /** Start the sign-in, print the address, and exit without waiting. */
  noWait: boolean;
  /** Finish a `--no-wait` sign-in with the address the browser landed on. */
  complete?: string;
  /** Print one JSON document on stdout. */
  json: boolean;
  /** `worker login` only: do not pair the relay after signing in. */
  noRelay?: boolean;
  help: boolean;
}

export type LoginArgsResult = { ok: true; args: LoginArgs } | { ok: false; error: string };

type Failure = { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parse a method name; `null` when it is not one. */
function parseMethod(value: string): LoginMethod | null {
  const normalized = value.toLowerCase();
  if (normalized === "twitter") return "x";
  if (normalized === "magic-link" || normalized === "magiclink") return "email";
  if (["github", "google", "x", "email"].includes(normalized)) return normalized as LoginMethod;
  return null;
}

/** Extra advice for flags people guess. */
const FLAG_ADVICE: Record<string, string> = {
  "--no-browser":
    "The sign-in address is always printed. To print it and exit without waiting, use --no-wait.",
  "--headless": "To print the sign-in address and exit without waiting, use --no-wait.",
  "--code": "Pass the address the browser landed on with --complete '<address>'.",
};

/** Read flags into `args`; method names and addresses go to `positionals`. */
function readFlags(
  argv: readonly string[],
  commandName: string,
  args: LoginArgs,
  positionals: string[],
): Failure | null {
  const usage = `Run \`${commandName} --help\` for usage.`;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const takeValue = (): string | null => {
      if (eq > 0) return raw.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return null;
      i++;
      return next;
    };
    if (flag === "-h" || flag === "--help") args.help = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--no-wait") args.noWait = true;
    else if (flag === "--no-relay" && commandName.startsWith(WORKER_LOGIN_COMMAND)) {
      args.noRelay = true;
    } else if (flag === "--complete") {
      const value = takeValue()?.trim();
      if (!value) {
        return {
          ok: false,
          error: `--complete needs the address the browser landed on, in quotes: ${commandName} --complete 'http://127.0.0.1:17865/auth/callback?code=...'`,
        };
      }
      args.complete = value;
    } else if (flag === "--provider" || flag === "--email") {
      const value = takeValue();
      if (!value) return { ok: false, error: `${flag} needs a value. ${usage}` };
      if (flag === "--email" && !EMAIL_PATTERN.test(value)) {
        return {
          ok: false,
          error: `--email needs an address (e.g. ${commandName} --email you@company.com).`,
        };
      }
      positionals.push(value);
    } else if (raw.startsWith("-")) {
      const advice = FLAG_ADVICE[flag];
      return {
        ok: false,
        error: `Unknown option for ${commandName}: ${flag}.${advice ? ` ${advice}` : ""} ${usage}`,
      };
    } else {
      positionals.push(raw);
    }
  }
  return null;
}

/** Turn method names and email addresses into `args.method` / `args.email`. */
function applyPositionals(
  positionals: readonly string[],
  commandName: string,
  args: LoginArgs,
): Failure | null {
  for (const value of positionals) {
    const isEmail = EMAIL_PATTERN.test(value);
    const method = isEmail ? "email" : parseMethod(value);
    if (!method) {
      return {
        ok: false,
        error: `Unknown sign-in method "${value}". Use one of: github, google, x, email <address>. Run \`${commandName} --help\` for usage.`,
      };
    }
    if (args.method && args.method !== method) {
      return { ok: false, error: `Two sign-in methods given (${args.method}, ${method}).` };
    }
    if (isEmail) {
      if (args.email && args.email !== value) {
        return { ok: false, error: `Two email addresses given (${args.email}, ${value}).` };
      }
      args.email = value;
    }
    args.method = method;
  }
  return null;
}

/** Reject flag combinations that cannot work. */
function checkCombination(args: LoginArgs, commandName: string): Failure | null {
  if (args.complete !== undefined && (args.method || args.noWait)) {
    return {
      ok: false,
      error: `--complete finishes the sign-in that \`--no-wait\` started; pass it on its own: ${commandName} --complete '<address>'`,
    };
  }
  if (args.noWait && !args.method) {
    return {
      ok: false,
      error: `--no-wait needs a sign-in method: ${commandName} github --no-wait (or google, x, email you@company.com).`,
    };
  }
  if (args.noWait && args.method === "email" && !args.email) {
    return {
      ok: false,
      error: `Email sign-in with --no-wait needs the address: ${commandName} email you@company.com --no-wait`,
    };
  }
  if (args.json && !args.method && args.complete === undefined) {
    return {
      ok: false,
      error: `--json cannot answer the method prompt; pass a method: ${commandName} github --json (or google, x, email you@company.com).`,
    };
  }
  return null;
}

/**
 * Parse the arguments after `login`.
 *
 * @param argv - Arguments after the `login` word (`--workspace` already removed).
 * @param commandName - Command shown in errors (`devintern worker login`).
 * @returns Parsed arguments, or one error message.
 */
export function parseLoginArgs(argv: readonly string[], commandName: string): LoginArgsResult {
  const args: LoginArgs = { noWait: false, json: false, help: false };
  const positionals: string[] = [];
  const failure =
    readFlags(argv, commandName, args, positionals) ??
    applyPositionals(positionals, commandName, args) ??
    (args.help ? null : checkCombination(args, commandName));
  return failure ?? { ok: true, args };
}

/**
 * Parse a `worker init --sign-in` value: `github`, `google`, `x`, or an email address.
 *
 * @param value - The flag value.
 * @returns The sign-in method, or one error message.
 */
export function parseSignInMethod(
  value: string | undefined,
): { ok: true; login: ResolvedLogin } | Failure {
  const usage =
    "--sign-in needs a method: github, google, x, or your email address (for an email link).";
  if (!value || value.startsWith("-") || !value.trim()) return { ok: false, error: usage };
  const parsed = parseLoginArgs([value.trim()], "--sign-in");
  if (!parsed.ok || !parsed.args.method) return { ok: false, error: `${usage} Got "${value}".` };
  if (parsed.args.method !== "email") return { ok: true, login: { method: parsed.args.method } };
  if (!parsed.args.email) {
    return {
      ok: false,
      error: "--sign-in email needs the address instead: --sign-in you@company.com",
    };
  }
  return { ok: true, login: { method: "email", email: parsed.args.email } };
}
