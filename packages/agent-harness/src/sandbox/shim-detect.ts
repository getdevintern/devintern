/**
 * Detect mise shims at a resolved harness path.
 *
 * `mise` installs small wrapper scripts into `~/.local/bin` that run
 * `mise use`/`mise x` before exec'ing the real tool. Under a filesystem
 * sandbox the install step is denied, so the wrapper exits before the agent
 * starts. We only detect and report this; never auto-resolve the real binary
 * and never add mise's directories to the sandbox writable set (that would let
 * an agent mutate its own toolchain).
 */

import { closeSync, openSync, readSync, statSync } from "fs";

import { resolveExecutablePath } from "../resolver.js";

/** First bytes read from a candidate wrapper script. */
const SHIM_READ_BYTES = 1024;
/** Wrapper scripts are tiny; anything larger is not a mise shim. */
const SHIM_MAX_FILE_BYTES = 64 * 1024;

/** Result of inspecting a resolved harness path for a mise shim. */
export interface MiseShimInfo {
  /** Whether the path is a small wrapper script invoking mise. */
  shim: boolean;
  /** Resolved absolute path that was inspected. */
  path: string;
  /** The matching wrapper line, when detected. */
  match?: string;
}

/**
 * Inspect a resolved executable for a mise wrapper script.
 *
 * Reads at most the first 1 KB and only treats a regular file as a shim; real
 * binaries and bare command names are reported as non-shims.
 *
 * @param command - Harness CLI path or command.
 * @param cwd - Base directory for relative paths.
 * @returns Detection result with the matching `mise use`/`mise x` line.
 */
export function detectMiseShim(command: string, cwd: string = process.cwd()): MiseShimInfo {
  const resolved = resolveExecutablePath(command, cwd);
  try {
    const stats = statSync(resolved);
    if (!stats.isFile() || stats.size === 0 || stats.size > SHIM_MAX_FILE_BYTES) {
      return { shim: false, path: resolved };
    }
    const buffer = Buffer.alloc(Math.min(SHIM_READ_BYTES, stats.size));
    const fd = openSync(resolved, "r");
    try {
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytes).toString("utf8");
      const match = head.split(/\r?\n/).find((line) => /\bmise\s+(?:use|x)\b/.test(line));
      return match
        ? { shim: true, path: resolved, match: match.trim() }
        : { shim: false, path: resolved };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { shim: false, path: resolved };
  }
}

/**
 * Environment variable that overrides a harness CLI path.
 *
 * Mirrors resolver behavior: claude-code uses its historical `CLAUDE_CLI_PATH`
 * name; every other harness uses `<HARNESS>_CLI_PATH`.
 *
 * @param harnessName - Canonical harness name (e.g. `grok`, `claude-code`).
 */
export function harnessCliPathEnvKey(harnessName: string): string {
  if (harnessName === "claude-code") return "CLAUDE_CLI_PATH";
  return `${harnessName.toUpperCase().replace(/-/g, "_")}_CLI_PATH`;
}

/**
 * Exact configuration fix for a detected shim.
 *
 * @param harnessName - Canonical harness name (e.g. `grok`).
 * @returns A `<HARNESS>_CLI_PATH` instruction pointing at the real executable.
 */
export function miseShimFixHint(harnessName: string): string {
  return `${harnessCliPathEnvKey(harnessName)}=/path/to/${harnessName}`;
}
