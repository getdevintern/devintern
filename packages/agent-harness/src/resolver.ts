/**
 * Resolve which harness to use and where the executable lives.
 *
 * Resolution order for harness name:
 *   1. `options.harnessName`
 *   2. `AGENT_HARNESS` environment variable
 *   3. Default to "claude-code" (backward compatible)
 *
 * Resolution order for executable path:
 *   1. `options.cliPath`
 *   2. `AGENT_CLI_PATH` environment variable
 *   3. `<HARNESS_NAME>_CLI_PATH` environment variable (e.g. `CLAUDE_CLI_PATH`, `OPENCODE_CLI_PATH`)
 *   4. `CLAUDE_CLI_PATH` environment variable (backward compatible)
 *   5. Harness `defaultPath`
 */

import { getHarness, listHarnesses } from "./registry.js";
import type { ResolvedHarness } from "./types.js";

export interface HarnessResolutionOptions {
  /** Explicit harness name (e.g. "claude-code"). */
  harnessName?: string;
  /** Explicit CLI path. */
  cliPath?: string;
  /**
   * Optional env-var prefix for harness-specific path lookups.
   * Defaults to the harness name upper-cased with hyphens → underscores.
   */
  envPrefix?: string;
}

/**
 * Resolve which harness to use and the CLI executable path to invoke.
 *
 * Harness name: `options.harnessName` → `AGENT_HARNESS` → `"claude-code"`.
 * Executable path: `options.cliPath` → `AGENT_CLI_PATH` →
 * `{PREFIX}_CLI_PATH` → `CLAUDE_CLI_PATH` → harness `defaultPath`.
 *
 * @param options - Optional overrides for harness name, CLI path, and env prefix.
 * @returns The resolved harness and executable path.
 * @throws {Error} When the harness name is not registered.
 */
export function resolveHarness(options?: HarnessResolutionOptions): ResolvedHarness {
  const env = process.env;

  // 1. Determine harness name
  let harnessName = options?.harnessName;
  if (!harnessName) {
    harnessName = env.AGENT_HARNESS;
  }
  if (!harnessName) {
    harnessName = "claude-code";
  }

  const harness = getHarness(harnessName);
  if (!harness) {
    const available = listHarnesses()
      .map((h) => `"${h.name}"`)
      .join(", ");
    throw new Error(
      `Unknown agent harness: "${harnessName}". ` +
        `Available harnesses: ${available}. ` +
        `Set AGENT_HARNESS or pass harnessName explicitly.`,
    );
  }

  // 2. Determine executable path
  let path = options?.cliPath;
  if (!path) {
    const prefix = options?.envPrefix ?? harness.name.toUpperCase().replace(/-/g, "_");
    path = env.AGENT_CLI_PATH || env[`${prefix}_CLI_PATH`] || env.CLAUDE_CLI_PATH; // backward compatibility
  }
  if (!path) {
    path = harness.defaultPath;
  }

  return { harness, path };
}

/**
 * Find an executable in the system `PATH` (cross-platform).
 *
 * Uses `which` on Unix and `where` on Windows via a synchronous shell lookup.
 *
 * @param command - Command name to search for (e.g. `"claude"`).
 * @returns The first resolved absolute path, or `null` if not found.
 */
export function findInPath(command: string): string | null {
  try {
    const { execSync } = require("child_process");
    const isWindows = process.platform === "win32";
    const whichCommand = isWindows ? "where" : "which";
    const result = execSync(`${whichCommand} ${command}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    return result.trim().split("\n")[0];
  } catch {
    return null;
  }
}

/**
 * Resolve a command string to an absolute executable path when possible.
 *
 * Tries, in order: absolute path as-is, relative path under `cwd`, then `PATH`
 * lookup via {@link findInPath}. Falls back to the original `command` if unresolved.
 *
 * @param command - Executable name or path (absolute, relative, or PATH lookup).
 * @param cwd - Working directory for relative path resolution. Defaults to `process.cwd()`.
 * @returns The resolved absolute path, or `command` unchanged if not found.
 */
export function resolveExecutablePath(command: string, cwd: string = process.cwd()): string {
  // Absolute path
  if (command.startsWith("/") || command.includes(":")) {
    return command;
  }

  // Relative path
  if (command.includes("/") || command.includes("\\")) {
    const { resolve } = require("path");
    const { existsSync } = require("fs");
    const resolved = resolve(cwd, command);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  // Look in PATH
  const fromPath = findInPath(command);
  if (fromPath) {
    return fromPath;
  }

  return command;
}

/** Options for {@link resolveExecutablePathWithRetry}. */
export interface ResolveWithRetryOptions {
  /** Working directory for relative-path resolution. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Number of resolution attempts before giving up. Defaults to
   * `AGENT_SPAWN_ENOENT_RETRIES` (env) or `5`.
   */
  retries?: number;
  /**
   * Base backoff in ms between attempts; doubles each attempt. Defaults to
   * `AGENT_SPAWN_ENOENT_BACKOFF_MS` (env) or `1000`.
   */
  backoffMs?: number;
  /** Human-readable CLI name for log messages. Defaults to `command`. */
  displayName?: string;
}

/**
 * Resolve an executable path, waiting through a transient absence.
 *
 * The agent CLI (e.g. `claude`) is normally a symlink that an auto-updater
 * rewrites in place. During that swap there is a brief window where the path
 * does not exist, so a spawn issued at that instant fails with `spawn ENOENT`.
 * This helper re-resolves the command and polls for its existence with
 * exponential backoff, riding out the swap before the caller spawns.
 *
 * Re-resolving each attempt (not just re-checking the same path) also covers
 * the case where the update relocates the install or a bare PATH command
 * resolves to a different absolute path once the new version lands.
 *
 * If the executable never appears within the retry budget, the best-effort
 * resolved path is returned anyway so the caller's own `spawn` surfaces the
 * real error (rather than this helper throwing a different one).
 *
 * @param command - Executable name or path (absolute, relative, or PATH lookup).
 * @param options - Retry/backoff tuning and a display name for logs.
 * @returns The resolved path once it exists, or the best-effort path on timeout.
 */
export async function resolveExecutablePathWithRetry(
  command: string,
  options: ResolveWithRetryOptions = {},
): Promise<string> {
  const { existsSync } = require("fs");
  const cwd = options.cwd ?? process.cwd();
  const displayName = options.displayName ?? command;
  const retries = options.retries ?? parseInt(process.env.AGENT_SPAWN_ENOENT_RETRIES || "5", 10);
  const backoffMs =
    options.backoffMs ?? parseInt(process.env.AGENT_SPAWN_ENOENT_BACKOFF_MS || "1000", 10);

  let resolved = resolveExecutablePath(command, cwd);
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (existsSync(resolved)) {
      return resolved;
    }
    const delayMs = backoffMs * 2 ** (attempt - 1);
    console.warn(
      `⚠️  ${displayName} CLI not found at "${resolved}" (likely mid auto-update). ` +
        `Retrying in ${delayMs}ms (attempt ${attempt}/${retries})...`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
    // Re-resolve: the install may have moved, or PATH now points at the new version.
    resolved = resolveExecutablePath(command, cwd);
  }

  return resolved;
}

/**
 * Resolve a harness executable path and fail fast with an actionable error
 * when a bare command cannot be located on the system `PATH`.
 *
 * Behaves like {@link resolveExecutablePath}, but instead of silently falling
 * back to the bare command name (which only surfaces later as a cryptic
 * `spawn ENOENT`), it throws immediately telling the user the CLI is not
 * installed / not on PATH and how to point at it.
 *
 * Absolute and relative paths are returned as-is (the same as
 * {@link resolveExecutablePath}) since the user explicitly chose them.
 *
 * @param command - Executable name or path for the harness CLI.
 * @param harnessDisplayName - Human-readable harness name for the error message.
 * @param cwd - Working directory for relative path resolution.
 * @returns The resolved absolute path.
 * @throws {Error} When a bare command is not found on PATH.
 */
export function resolveExecutablePathStrict(
  command: string,
  harnessDisplayName: string,
  cwd: string = process.cwd(),
): string {
  const resolved = resolveExecutablePath(command, cwd);

  // A bare command (no path separators, not absolute) that resolved to itself
  // means the PATH lookup failed — the CLI is not installed or not on PATH.
  const isBareCommand =
    !command.startsWith("/") &&
    !command.includes(":") &&
    !command.includes("/") &&
    !command.includes("\\");

  if (isBareCommand && resolved === command) {
    throw new Error(
      `${harnessDisplayName} CLI not found: "${command}" is not on your PATH. ` +
        `Install it and make sure it is on your PATH, or set AGENT_CLI_PATH ` +
        `(or <HARNESS>_CLI_PATH) to the command name or full path of the executable.`,
    );
  }

  return resolved;
}
