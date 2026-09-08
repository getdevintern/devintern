/**
 * Resolve which harness to use and where the executable lives.
 *
 * Resolution order for harness name:
 *   1. `options.harnessName`
 *   2. `AGENT_HARNESS` environment variable (a comma-separated list uses its
 *      first entry — see `resolveHarnessChain` for full-chain resolution)
 *   3. Default to "claude-code" (backward compatible)
 *
 * Resolution order for executable path:
 *   1. `options.cliPath`
 *   2. `AGENT_CLI_PATH` environment variable
 *   3. `<HARNESS_NAME>_CLI_PATH` environment variable (e.g. `CLAUDE_CLI_PATH`, `OPENCODE_CLI_PATH`)
 *   4. `CLAUDE_CLI_PATH` environment variable (backward compatible)
 *   5. Harness `defaultPath`
 */

import { execSync } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { resolve } from "path";
import { DEFAULT_HARNESS_NAME, getHarness, HARNESS_ALIASES, listHarnesses } from "./registry.js";
import type { AgentHarness, ResolvedHarness } from "./types.js";

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
  /**
   * When false, suppress deprecation warnings for aliased harness names
   * (e.g. `gemini` → `antigravity`). Defaults to true.
   */
  warnDeprecated?: boolean;
}

/**
 * Resolve which harness to use and the CLI executable path to invoke.
 *
 * Harness name: `options.harnessName` → `AGENT_HARNESS` → `"claude-code"`.
 * A comma-separated `AGENT_HARNESS` (e.g. `claude-code,codex`) names a
 * failover chain; this resolver always picks the first (priority) entry so
 * one-shot flows keep behaving as a single-harness run — worker-mode failover
 * across the rest of the chain lives in {@link resolveHarnessChain}.
 * Aliases (e.g. `agy` / deprecated `gemini` → `antigravity`) are applied before
 * registry lookup; deprecated aliases emit a one-line console warning.
 *
 * Executable path when no explicit harness name is given:
 * `options.cliPath` → `AGENT_CLI_PATH` → `{PREFIX}_CLI_PATH` →
 * harness-specific fallbacks (e.g. `AGY_CLI_PATH`, deprecated `GEMINI_CLI_PATH`
 * for Antigravity) → `CLAUDE_CLI_PATH` → harness `defaultPath`.
 *
 * When `options.harnessName` is set (CLI `--harness` or interactive picker),
 * `AGENT_CLI_PATH` is skipped so a previous harness's global path override
 * cannot stick to a newly selected agent. Resolution uses harness-specific
 * env vars / defaults via {@link getHarnessCliCommand} instead.
 *
 * @param options - Optional overrides for harness name, CLI path, and env prefix.
 * @returns The resolved harness and executable path.
 * @throws {Error} When the harness name is not registered.
 */
export function resolveHarness(options?: HarnessResolutionOptions): ResolvedHarness {
  const env = process.env;

  // 1. Determine harness name
  const explicitHarnessName = options?.harnessName;
  let harnessName = explicitHarnessName;
  if (!harnessName) {
    // AGENT_HARNESS may name a comma-separated failover chain; env-driven
    // (non-explicit) resolution always uses the first (priority) entry, kept
    // raw so alias/deprecation warnings still fire for the requested name.
    const firstEntry = env.AGENT_HARNESS?.split(",")[0]?.trim();
    if (firstEntry) {
      harnessName = firstEntry;
    }
  }
  if (!harnessName) {
    harnessName = DEFAULT_HARNESS_NAME;
  }

  const alias = HARNESS_ALIASES[harnessName];
  if (alias?.deprecated && alias.warning && options?.warnDeprecated !== false) {
    console.warn(`⚠️  ${alias.warning}`);
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
    if (explicitHarnessName) {
      // Explicit selection (--harness / interactive picker): honour harness-specific
      // paths only; AGENT_CLI_PATH is reserved for env/default-driven resolution.
      if (options?.envPrefix) {
        const prefix = options.envPrefix;
        path = env[`${prefix}_CLI_PATH`];
        if (!path && harness.name === "claude-code") {
          path = env.CLAUDE_CLI_PATH;
        }
      } else {
        path = getHarnessCliCommand(harness, { warnDeprecated: options?.warnDeprecated });
      }
    } else {
      const prefix = options?.envPrefix ?? harness.name.toUpperCase().replace(/-/g, "_");
      path =
        env.AGENT_CLI_PATH ||
        env[`${prefix}_CLI_PATH`] ||
        // Antigravity: also accept AGY_CLI_PATH (binary name) and legacy GEMINI_CLI_PATH
        (harness.name === "antigravity" ? env.AGY_CLI_PATH : undefined) ||
        (harness.name === "antigravity" && env.GEMINI_CLI_PATH
          ? warnAndMapLegacyGeminiCliPath(env.GEMINI_CLI_PATH, options?.warnDeprecated !== false)
          : undefined) ||
        env.CLAUDE_CLI_PATH; // backward compatibility
    }
  }
  if (!path) {
    path = harness.defaultPath;
  }

  // Never happily path to the retired bare `gemini` binary when using Antigravity.
  if (harness.name === "antigravity" && isRetiredGeminiBinary(path)) {
    if (options?.warnDeprecated !== false) {
      console.warn(
        `⚠️  CLI path "${path}" points at the retired Gemini CLI binary. ` +
          `Using Antigravity default "agy" instead. Set AGENT_CLI_PATH, ` +
          `ANTIGRAVITY_CLI_PATH, or AGY_CLI_PATH if agy is not on PATH.`,
      );
    }
    path = harness.defaultPath;
  }

  return { harness, path };
}

/**
 * True when a path/command name is the deprecated consumer Gemini CLI binary.
 *
 * @param path - Resolved or configured CLI path.
 * @returns Whether the path should not be the happy path for Antigravity runs.
 */
function isRetiredGeminiBinary(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base === "gemini" || base === "gemini.exe";
}

/**
 * Map legacy `GEMINI_CLI_PATH` for Antigravity resolution with a deprecation warning.
 *
 * Bare `gemini` paths are discarded so we do not spawn a dead binary; custom
 * install paths are kept with a warning (enterprise holdouts may still have a
 * usable binary outside DevIntern's recommended path).
 *
 * @param geminiCliPath - Value of `GEMINI_CLI_PATH`.
 * @param warn - Whether to print a deprecation warning.
 * @returns Path to use, or `undefined` to fall through to the next candidate.
 */
function warnAndMapLegacyGeminiCliPath(geminiCliPath: string, warn: boolean): string | undefined {
  if (warn) {
    console.warn(
      "⚠️  GEMINI_CLI_PATH is deprecated. Prefer AGENT_CLI_PATH, ANTIGRAVITY_CLI_PATH, or AGY_CLI_PATH " +
        "pointing at the Antigravity CLI binary (agy).",
    );
  }
  if (isRetiredGeminiBinary(geminiCliPath)) {
    return undefined;
  }
  return geminiCliPath;
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
    const isWindows = process.platform === "win32";
    const whichCommand = isWindows ? "where" : "which";
    const result = execSync(`${whichCommand} ${command}`, {
      encoding: "utf8",
      stdio: "pipe",
      // Bun's execSync snapshots the spawn env at startup; pass the live
      // process.env so runtime PATH changes are honored.
      env: process.env,
    });
    return result.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/** Options for {@link getHarnessCliCommand} and {@link isHarnessInstalled}. */
export interface HarnessInstallOptions {
  /** When true, also honour `AGENT_CLI_PATH` for this harness. */
  includeGlobalCliPath?: boolean;
  /**
   * When false, suppress deprecation warnings for legacy path env vars
   * (e.g. `GEMINI_CLI_PATH`). Defaults to true.
   */
  warnDeprecated?: boolean;
}

/**
 * Resolve the CLI command or path to probe for a harness.
 *
 * Uses harness-specific env vars (`OPENCODE_CLI_PATH`, etc.), Antigravity
 * fallbacks (`AGY_CLI_PATH`, legacy `GEMINI_CLI_PATH`), `CLAUDE_CLI_PATH`
 * for claude-code, then `defaultPath`. Optionally includes `AGENT_CLI_PATH`
 * when checking the active harness.
 *
 * @param harness - Registered harness to resolve a probe target for.
 * @param options - Whether to include the global `AGENT_CLI_PATH` override.
 * @returns Command name or path to check for availability.
 */
export function getHarnessCliCommand(
  harness: AgentHarness,
  options?: HarnessInstallOptions,
): string {
  const env = process.env;

  if (options?.includeGlobalCliPath && env.AGENT_CLI_PATH) {
    return env.AGENT_CLI_PATH;
  }

  const prefix = harness.name.toUpperCase().replace(/-/g, "_");
  const harnessSpecific = env[`${prefix}_CLI_PATH`];
  if (harnessSpecific) {
    return harnessSpecific;
  }

  if (harness.name === "antigravity") {
    if (env.AGY_CLI_PATH) {
      return env.AGY_CLI_PATH;
    }
    if (env.GEMINI_CLI_PATH) {
      const mapped = warnAndMapLegacyGeminiCliPath(
        env.GEMINI_CLI_PATH,
        options?.warnDeprecated !== false,
      );
      if (mapped) {
        return mapped;
      }
    }
  }

  if (harness.name === "claude-code" && env.CLAUDE_CLI_PATH) {
    return env.CLAUDE_CLI_PATH;
  }

  return harness.defaultPath;
}

/**
 * Whether a CLI command or path points at an executable that exists or is on PATH.
 *
 * @param command - Executable name or path (absolute, relative, or PATH lookup).
 * @param cwd - Working directory for relative path resolution.
 * @returns `true` when the command resolves to an existing executable.
 */
export function isHarnessCliAvailable(command: string, cwd: string = process.cwd()): boolean {
  const resolved = resolveExecutablePath(command, cwd);

  const isBareCommand =
    !command.startsWith("/") &&
    !command.includes(":") &&
    !command.includes("/") &&
    !command.includes("\\");

  if (isBareCommand) {
    return resolved !== command;
  }

  try {
    accessSync(resolved, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the given harness CLI is installed and reachable on this machine.
 *
 * @param harness - Registered harness to check.
 * @param options - Whether to include the global `AGENT_CLI_PATH` override.
 * @returns `true` when the harness CLI can be invoked.
 */
export function isHarnessInstalled(
  harness: AgentHarness,
  options?: HarnessInstallOptions,
): boolean {
  const command = getHarnessCliCommand(harness, options);
  return isHarnessCliAvailable(command);
}

/** Options for {@link listInstalledHarnesses}. */
export interface ListInstalledHarnessesOptions {
  /** Honour `AGENT_CLI_PATH` when checking this harness (typically the active one). */
  currentHarnessName?: string;
}

/**
 * Return registered harnesses whose CLIs are installed on this machine.
 *
 * Probes each harness via `which` / `where` (or env/path overrides) so UI
 * pickers only show agents the user can actually run.
 *
 * @param options - Optional active harness name for `AGENT_CLI_PATH` lookup.
 * @returns Harnesses with a resolvable CLI on the current machine.
 */
export function listInstalledHarnesses(options?: ListInstalledHarnessesOptions): AgentHarness[] {
  return listHarnesses().filter((h) =>
    isHarnessInstalled(h, {
      includeGlobalCliPath: h.name === options?.currentHarnessName,
    }),
  );
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
