/**
 * Configuration management for the CLI
 */

import { join } from "node:path";
import { rename } from "node:fs/promises";
import { createDefaultSupabaseAuthConfig, type SupabaseAuthConfig } from "@devintern/auth";
import { resolveConfigDir } from "@devintern/utils";
import {
  resolveHarness,
  resolveExecutablePathStrict,
  type ResolvedHarness,
} from "@devintern/agent-harness";
import { loadTrackerConfig, type TrackerConfig, type TrackerType } from "@devintern/task-trackers";

export type { TrackerType };

export interface Config extends TrackerConfig {
  agent: ResolvedHarness;
  supabase: SupabaseAuthConfig;
}

/**
 * Migrate a legacy `.claude-pm` config directory to `.devintern-pm` in the cwd.
 *
 * No-op when the new directory already exists or the legacy directory is absent.
 *
 * @returns Resolves when migration attempt completes (failures are logged as warnings).
 */
export async function migrateLegacyConfigDir(): Promise<void> {
  const cwd = process.cwd();
  const newDir = join(cwd, ".devintern-pm");
  const oldDir = join(cwd, ".claude-pm");

  const newDirExists = await Bun.file(join(newDir, "."))
    .exists()
    .catch(() => false);
  if (newDirExists) return;

  const oldDirExists = await Bun.file(join(oldDir, "."))
    .exists()
    .catch(() => false);
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
 * Load Supabase auth configuration for CLI login/session storage.
 *
 * @returns Supabase auth config pointing at `.devintern-pm/.auth-session.json`.
 */
export async function loadSupabaseConfig(): Promise<SupabaseAuthConfig> {
  const configDir = resolveConfigDir({ configDirName: ".devintern-pm" });
  return createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json"));
}

/**
 * Load and validate application configuration from environment variables.
 *
 * Reads `.devintern-pm/.env` first, then validates backend-specific required vars.
 *
 * @returns Fully resolved {@link Config} for the selected task tracker and agent harness.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export async function loadConfig(): Promise<Config> {
  const trackerConfig = await loadTrackerConfig(".devintern-pm");
  const agent = resolveHarness();
  // Locate the CLI on PATH and fail fast with an actionable error if missing,
  // instead of surfacing a cryptic spawn error mid-run.
  agent.path = resolveExecutablePathStrict(agent.path, agent.harness.displayName);

  const configDir = resolveConfigDir({ configDirName: ".devintern-pm" });

  return {
    ...trackerConfig,
    agent,
    supabase: createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json")),
  };
}
