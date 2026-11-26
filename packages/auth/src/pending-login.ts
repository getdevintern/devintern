/**
 * Pending two-step sign-in (`login --no-wait`, then `login --complete`).
 *
 * The first step starts the PKCE flow and saves what the second step needs to
 * finish it on the same host: the code verifier, the method, and the redirect
 * address. The file is owner-only (0600) and expires; the verifier never
 * leaves this host, so the code the browser lands with is useless elsewhere.
 */

import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readTextFileIfExists } from "./runtime";
import type { LoginMethod, SupabaseAuthConfig } from "./types";

/** File name of the pending sign-in, next to the session file. */
export const PENDING_LOGIN_FILE = ".auth-pending.json";

/** How long a started sign-in can be completed. */
export const PENDING_LOGIN_TTL_MS = 30 * 60_000;

const PENDING_LOGIN_VERSION = 1;

const LOGIN_METHODS: readonly LoginMethod[] = ["github", "google", "x", "email"];

/** Saved state of a sign-in started with `--no-wait`. */
export interface PendingLogin {
  version: typeof PENDING_LOGIN_VERSION;
  method: LoginMethod;
  /** Address the sign-in link was sent to (email only). */
  email?: string;
  /** Redirect address the browser lands on (`http://127.0.0.1:<port>/auth/callback`). */
  redirectTo: string;
  /** Sign-in address that was shown (OAuth only), so a repeated start can show it again. */
  url?: string;
  /** Supabase storage value for the PKCE code verifier. */
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
}

/** Why a pending sign-in cannot be completed. */
export type PendingLoginErrorCode =
  | "missing"
  | "expired"
  | "unsafe"
  | "invalid"
  | "bad-address"
  | "mismatch"
  | "oauth-error"
  | "exchange-failed";

/** Error from {@link readPendingLogin} or completing a pending sign-in. */
export class PendingLoginError extends Error {
  readonly code: PendingLoginErrorCode;

  constructor(code: PendingLoginErrorCode, message: string) {
    super(message);
    this.name = "PendingLoginError";
    this.code = code;
  }
}

/**
 * Path of the pending sign-in for a session file.
 *
 * @param config - Supabase auth configuration (its session file sets the directory).
 * @returns Absolute path of the pending sign-in file.
 */
export function pendingLoginPath(config: SupabaseAuthConfig): string {
  return join(dirname(config.sessionFilePath), PENDING_LOGIN_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoginMethod(value: unknown): value is LoginMethod {
  return typeof value === "string" && (LOGIN_METHODS as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Parse the pending sign-in file contents.
 *
 * @param text - File contents.
 * @returns The pending sign-in, or `null` when the contents are not one.
 */
export function parsePendingLogin(text: string): PendingLogin | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== PENDING_LOGIN_VERSION) return null;
  const { method, email, redirectTo, url, codeVerifier, createdAt, expiresAt } = raw;
  if (
    !isLoginMethod(method) ||
    typeof redirectTo !== "string" ||
    !redirectTo ||
    typeof codeVerifier !== "string" ||
    !codeVerifier ||
    !isTimestamp(createdAt) ||
    !isTimestamp(expiresAt) ||
    (email !== undefined && typeof email !== "string") ||
    (url !== undefined && typeof url !== "string")
  ) {
    return null;
  }
  return {
    version: PENDING_LOGIN_VERSION,
    method,
    ...(email ? { email } : {}),
    redirectTo,
    ...(url ? { url } : {}),
    codeVerifier,
    createdAt,
    expiresAt,
  };
}

/**
 * Save a pending sign-in, owner-only (0600), replacing any earlier one.
 *
 * @param path - Pending sign-in file path.
 * @param pending - State to save.
 */
export async function writePendingLogin(path: string, pending: PendingLogin): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Remove first: `mode` applies only when the file is created.
  await rm(path, { force: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(pending, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

/**
 * Delete the pending sign-in. No-op when there is none.
 *
 * @param path - Pending sign-in file path.
 */
export async function removePendingLogin(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Load a pending sign-in that can still be completed.
 *
 * @param path - Pending sign-in file path.
 * @param startCommand - Command shown in errors to start over.
 * @param now - Current time in ms (tests).
 * @returns The pending sign-in.
 * @throws {PendingLoginError} When it is missing, readable by others, unreadable, or expired.
 *   An expired or unreadable file is deleted.
 */
export async function readPendingLogin(
  path: string,
  startCommand: string,
  now: number = Date.now(),
): Promise<PendingLogin> {
  const text = await readTextFileIfExists(path);
  if (text === null) {
    throw new PendingLoginError(
      "missing",
      `No sign-in is waiting to be completed on this host. Start one with \`${startCommand}\`.`,
    );
  }
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      await removePendingLogin(path);
      throw new PendingLoginError(
        "unsafe",
        `The pending sign-in at ${path} was readable by other users (mode ${mode.toString(8).padStart(4, "0")}), so it was deleted. Start again with \`${startCommand}\`.`,
      );
    }
  }
  const pending = parsePendingLogin(text);
  if (!pending) {
    await removePendingLogin(path);
    throw new PendingLoginError(
      "invalid",
      `The pending sign-in at ${path} is unreadable, so it was deleted. Start again with \`${startCommand}\`.`,
    );
  }
  if (Date.parse(pending.expiresAt) <= now) {
    await removePendingLogin(path);
    throw new PendingLoginError(
      "expired",
      `The pending sign-in expired at ${pending.expiresAt}. Start again with \`${startCommand}\`.`,
    );
  }
  return pending;
}

/**
 * Check that a pasted address belongs to this pending sign-in: a full address
 * must point at the same `127.0.0.1` port and path the sign-in redirected to.
 * A bare query string (`code=...`) is accepted as is.
 *
 * @param input - Pasted text.
 * @param pending - The pending sign-in.
 * @returns An error message, or `null` when the address matches.
 */
export function pastedAddressMismatch(input: string, pending: PendingLogin): string | null {
  const text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  let pasted: URL;
  let expected: URL;
  try {
    pasted = new URL(text);
    expected = new URL(pending.redirectTo);
  } catch {
    return null;
  }
  if (pasted.origin === expected.origin && pasted.pathname === expected.pathname) return null;
  return (
    `That address (${pasted.origin}${pasted.pathname}) is not from the sign-in waiting on this host, ` +
    `which ends on ${pending.redirectTo}. Paste the address from the latest sign-in link.`
  );
}
