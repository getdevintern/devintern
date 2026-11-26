/**
 * Shared wording for the Worker Pilot sign-in, so `worker init` (both modes),
 * `worker doctor`, and `worker login` say the same thing.
 */

import { homedir } from "os";
import { join, resolve } from "path";

/** Sign-in command for the worker workspace. */
export const WORKER_LOGIN_COMMAND = "devintern worker login";

/** Quote a value for a POSIX shell when it needs it. */
export function shellQuote(value: string): string {
  return /^[\w./@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `devintern worker login` for a workspace, with `--workspace <path>` when it
 * is not the default `~/.devintern/workspace.toml`, so a command printed here
 * works in another shell that lacks `DEVINTERN_WORKSPACE_DIR`.
 *
 * @param configPath - The workspace's `workspace.toml`.
 * @param home - Home directory (tests).
 * @returns The login command for that workspace.
 */
export function workerLoginCommandFor(configPath: string, home: string = homedir()): string {
  const absolute = resolve(configPath);
  if (absolute === join(home, ".devintern", "workspace.toml")) return WORKER_LOGIN_COMMAND;
  return `${WORKER_LOGIN_COMMAND} --workspace ${shellQuote(absolute)}`;
}

/**
 * ` --workspace <path>` for worker commands that take it (`login`, `connect`,
 * `doctor`), or empty for the default `~/.devintern/workspace.toml`.
 */
export function workspaceFlagFor(configPath: string, home: string = homedir()): string {
  return workerLoginCommandFor(configPath, home).slice(WORKER_LOGIN_COMMAND.length);
}

/**
 * `DEVINTERN_WORKSPACE_DIR=<dir> ` for commands without `--workspace`
 * (`worker service`, `worker init`), or empty for the default `~/.devintern`.
 */
export function workspaceEnvPrefixFor(workspaceDir: string, home: string = homedir()): string {
  const absolute = resolve(workspaceDir);
  if (absolute === join(home, ".devintern")) return "";
  return `DEVINTERN_WORKSPACE_DIR=${shellQuote(absolute)} `;
}

/** What signing in gets you. */
export const WORKER_PILOT_OFFER = "14-day free Worker Pilot, no card required";

/** Entitlement row and next-step text when nobody is signed in yet. */
export const WORKER_PILOT_NOT_STARTED = `Not started: sign in to begin your ${WORKER_PILOT_OFFER}`;

/** Methods other than GitHub, for "or ..." hints. */
export const OTHER_LOGIN_METHODS = "google, x, or email you@company.com";

/**
 * Concrete sign-in command with a method, for hints and next steps.
 *
 * @param loginCommand - Base command (may include `--workspace <path>`).
 * @returns For example `devintern worker login github`.
 */
export function signInCommand(loginCommand: string = WORKER_LOGIN_COMMAND): string {
  return `${loginCommand} github`;
}

/** Hint for the entitlement row when sign-in is the next step. */
export function signInHint(loginCommand: string = WORKER_LOGIN_COMMAND): string {
  return (
    `Run \`${signInCommand(loginCommand)}\` (or ${OTHER_LOGIN_METHODS}). Without a terminal: ` +
    `\`${signInCommand(loginCommand)} --no-wait\`. A paid LICENSE_KEY in the workspace .env works instead`
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Describe an active Worker Pilot's end, e.g. `ends 2026-12-10 (14 days left)`.
 *
 * @param endsAt - Server-provided expiry (ISO 8601).
 * @param now - Current time in ms.
 * @returns Readable end date, or `null` when `endsAt` is not a date.
 */
export function describePilotEnd(
  endsAt: string | undefined,
  now: number = Date.now(),
): string | null {
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (!Number.isFinite(end)) return null;
  const days = Math.max(0, Math.ceil((end - now) / DAY_MS));
  const date = new Date(end).toISOString().slice(0, 10);
  return `ends ${date} (${days === 1 ? "1 day" : `${days} days`} left)`;
}
