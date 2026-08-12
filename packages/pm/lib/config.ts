/**
 * Configuration management for the CLI
 */

import { join } from "node:path";
import { rename } from "node:fs/promises";
import { pathExists } from "./runtime/fs.js";
import { resolveHarness, resolveExecutablePathStrict } from "@devintern/agent-harness";
import type { ResolvedHarness } from "@devintern/agent-harness";
import { loadTrackerConfig } from "@devintern/task-trackers";
import type { TrackerConfig, TrackerType } from "@devintern/task-trackers";

export type { TrackerType };

export interface Config extends TrackerConfig {
  agent: ResolvedHarness;
}

export interface LoadConfigOptions {
  /** Explicit harness name override (e.g. from `--harness`). */
  harnessName?: string;
  /** Explicit CLI path override. */
  cliPath?: string;
  /** Directory to resolve config from (defaults to cwd). */
  baseDir?: string;
}

/**
 * Migrate a legacy `.claude-pm` config directory to `.devintern-pm` in the cwd.
 *
 * No-op when the new directory already exists or the legacy directory is absent.
 *
 * @param baseDir - Directory containing the config dirs (defaults to cwd).
 * @returns Resolves when migration attempt completes (failures are logged as warnings).
 */
export async function migrateLegacyConfigDir(baseDir: string = process.cwd()): Promise<void> {
  const newDir = join(baseDir, ".devintern-pm");
  const oldDir = join(baseDir, ".claude-pm");

  const newDirExists = await pathExists(newDir).catch(() => false);
  if (newDirExists) return;

  const oldDirExists = await pathExists(oldDir).catch(() => false);
  if (oldDirExists) {
    try {
      await rename(oldDir, newDir);
      console.log(`ℹ️  Migrated legacy config directory: .claude-pm → .devintern-pm`);
    } catch (error) {
      console.warn(
        `⚠️  Failed to migrate legacy config directory .claude-pm: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

/**
 * Load and validate application configuration from environment variables.
 *
 * Reads `.devintern-pm/.env` first, then validates backend-specific required vars.
 *
 * @param optionsOrBaseDir - Optional harness overrides, or a bare base-directory
 *   string (legacy callers such as pm-desktop).
 * @returns Fully resolved {@link Config} for the selected task tracker and agent harness.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export async function loadConfig(optionsOrBaseDir?: LoadConfigOptions | string): Promise<Config> {
  const options =
    typeof optionsOrBaseDir === "string" ? { baseDir: optionsOrBaseDir } : optionsOrBaseDir;
  const trackerConfig = await loadTrackerConfig(".devintern-pm", options?.baseDir);
  const agent = resolveHarness({
    harnessName: options?.harnessName,
    cliPath: options?.cliPath,
  });
  // Locate the CLI on PATH and fail fast with an actionable error if missing,
  // instead of surfacing a cryptic spawn error mid-run.
  agent.path = resolveExecutablePathStrict(agent.path, agent.harness.displayName);

  return {
    ...trackerConfig,
    agent,
  };
}
