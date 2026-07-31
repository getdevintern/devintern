/**
 * Shared detection helpers for sandbox providers.
 *
 * Lives separately from `detect.ts` so providers can import these without
 * creating a cycle (detect.ts → registry.ts → providers → here).
 */

import { spawnSync } from "child_process";
import type { SandboxDetection } from "./types.js";

/**
 * Run a command synchronously and capture its first line of stdout.
 *
 * Used by providers for cheap version/capability probes (`nono --version`,
 * `sbx ls`). A non-zero exit or missing binary returns `null`.
 *
 * @param command - Executable name or path.
 * @param args - Arguments for the probe.
 * @returns Trimmed first output line, or `null` when the probe fails.
 */
export function probeCommand(command: string, args: readonly string[]): string | null {
  // spawnSync + explicit status check rather than execFileSync: Bun's
  // execFileSync does not reliably throw on non-zero exits.
  const result = spawnSync(command, args as string[], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10_000,
    // Bun snapshots the spawn env at startup; pass the live process.env so
    // runtime PATH changes are honored.
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split("\n")[0] ?? null;
}

/**
 * Like {@link probeCommand}, but returns the full stdout instead of the
 * first line — for probes that scan multi-line output (e.g. subcommand
 * lists in `--help`).
 *
 * @param command - Executable name or path.
 * @param args - Arguments for the probe.
 * @returns Trimmed full output, or `null` when the probe fails.
 */
export function probeCommandOutput(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, args as string[], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Shared platform gate: every built-in provider targets macOS/Linux only.
 *
 * @returns A detection failure on Windows, or `null` on supported platforms.
 */
export function unsupportedPlatform(): SandboxDetection | null {
  if (process.platform === "win32") {
    return { available: false, reason: "sandbox providers are supported on macOS and Linux only" };
  }
  return null;
}
