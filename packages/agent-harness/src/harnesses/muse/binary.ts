/**
 * Muse CLI binary detection and version probing.
 */

import { execFileSync } from "child_process";
import { accessSync, constants } from "fs";
import { resolveExecutablePathStrict } from "../../resolver.js";

export class MuseBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuseBinaryError";
  }
}

/**
 * Verify the Muse CLI exists and is executable before launch.
 *
 * @param command - Executable name or path.
 * @param cwd - Working directory for relative resolution.
 * @returns Resolved absolute path.
 * @throws {MuseBinaryError} when missing or non-executable.
 */
export function assertMuseBinaryAvailable(command: string, cwd: string = process.cwd()): string {
  try {
    const resolved = resolveExecutablePathStrict(command, "Muse Code", cwd);
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Muse Code CLI not found")) {
      throw new MuseBinaryError(error.message);
    }
    throw new MuseBinaryError(
      `Muse Code CLI not found at: ${command}. ` +
        `Install Muse Code and ensure it is on your PATH, or set MUSE_CLI_PATH / AGENT_CLI_PATH.`,
    );
  }
}

/**
 * Probe Muse CLI version for diagnostics (best-effort).
 *
 * @param resolvedPath - Absolute path to muse binary.
 * @returns Version string or undefined when probing fails.
 */
export function probeMuseCliVersion(resolvedPath: string): string | undefined {
  const flags = ["--version", "-V", "version"];
  for (const flag of flags) {
    try {
      const output = execFileSync(resolvedPath, [flag], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
      if (output) {
        return output.split("\n")[0]?.trim();
      }
    } catch {
      // Try next flag shape.
    }
  }
  return undefined;
}
