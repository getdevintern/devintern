import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_WORKSPACE_DIRECTORY = ".devintern";

/**
 * Resolve the shared worker env file used by the read-only tracker smoke.
 *
 * Precedence:
 * 1. `DEVINTERN_ENV_FILE` (explicit path; `~` is expanded)
 * 2. `DEVINTERN_WORKSPACE_DIR/.env`
 * 3. `~/.devintern/.env`
 *
 * A relative explicit path is resolved against the current working directory.
 *
 * @param env - Environment source (defaults to `process.env`)
 * @param home - Home directory used for `~` expansion (defaults to the host home)
 * @returns Absolute path to the workspace env file
 */
export function resolveWorkspaceEnvPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = env.DEVINTERN_ENV_FILE?.trim();
  if (explicit) return expandHome(explicit, home);

  const workspaceDirectory = env.DEVINTERN_WORKSPACE_DIR?.trim();
  const base = workspaceDirectory
    ? expandHome(workspaceDirectory, home)
    : join(home, DEFAULT_WORKSPACE_DIRECTORY);
  return join(base, ".env");
}

/**
 * Parse a dotenv-style file without shell evaluation.
 *
 * The worker `.env` contains unquoted values with spaces (for example
 * `TRELLO_DEFAULT_LIST_NAME=To Do`), so sourcing it through a shell corrupts
 * the value. This parser keeps everything after the first `=` verbatim, strips
 * one pair of matching quotes, ignores comments, and supports an optional
 * `export ` prefix.
 *
 * @param contents - Raw env file contents
 * @returns Parsed key/value pairs
 */
export function parseWorkspaceEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    values[key] = value;
  }

  return values;
}

export interface WorkspaceEnv {
  /** Absolute path that was read. */
  path: string;
  /** Parsed file values. */
  values: Record<string, string>;
}

/**
 * Read and parse a workspace env file.
 *
 * @param path - Env file path (defaults to {@link resolveWorkspaceEnvPath})
 * @returns The path and parsed values
 * @throws When the file does not exist or cannot be read
 */
export function readWorkspaceEnv(path: string = resolveWorkspaceEnvPath()): WorkspaceEnv {
  if (!existsSync(path)) {
    throw new Error(
      `Workspace env file not found: ${path}. Set DEVINTERN_ENV_FILE or DEVINTERN_WORKSPACE_DIR.`,
    );
  }
  return { path, values: parseWorkspaceEnv(readFileSync(path, "utf8")) };
}

/**
 * Merge file values with the process environment.
 *
 * Non-empty process values win so a caller can override one setting without
 * copying the whole file. Empty values fall back to the file.
 *
 * @param values - Parsed workspace env values
 * @param env - Process environment (defaults to `process.env`)
 * @returns Merged environment
 */
export function mergeWorkspaceEnv(
  values: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = { ...values };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim()) merged[key] = value;
  }
  return merged;
}

/**
 * Expand a leading `~` and resolve relative paths against the current working
 * directory.
 *
 * @param value - Path to normalize
 * @param home - Home directory used for `~` expansion (defaults to the host home)
 * @returns Absolute path
 */
export function expandHomePath(value: string, home: string = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function expandHome(value: string, home: string): string {
  return expandHomePath(value, home);
}
