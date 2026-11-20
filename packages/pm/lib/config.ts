/**
 * Configuration management for the CLI
 */

import { join } from "node:path";
import { rename } from "node:fs/promises";
import { pathExists } from "./runtime/fs.js";
import { createDefaultSupabaseAuthConfig } from "@devintern/auth";
import type { SupabaseAuthConfig } from "@devintern/auth";
import {
  parseHarnessList,
  resolveHarness,
  resolveHarnessChainSync,
  resolveExecutablePathStrict,
} from "@devintern/agent-harness";
import type { HarnessChainEntry, ResolvedHarness } from "@devintern/agent-harness";
import { resolveConfigDir } from "@devintern/utils";
import { loadTrackerConfig } from "@devintern/task-trackers";
import type { TrackerConfig, TrackerType } from "@devintern/task-trackers";

export type { TrackerType };

export interface Config extends TrackerConfig {
  /** Primary (first usable) agent harness. */
  agent: ResolvedHarness;
  /**
   * Usage-limit fallbacks after {@link Config.agent}, in priority order, from a
   * comma-separated `AGENT_HARNESS` chain. Empty/absent when `--harness` was
   * given or the chain has a single entry, which disables failover.
   */
  agentFallbacks?: HarnessChainEntry[];
  /**
   * `true` when the configured first `AGENT_HARNESS` entry was dropped
   * (unknown / not installed) and {@link Config.agent} is a later entry taking
   * its place. The engine then treats it like a fallback: its own
   * `<HARNESS>_MODEL`, default effort, and no caller CLI path override.
   */
  agentIsFallback?: boolean;
}

export interface LoadConfigOptions {
  /** Explicit harness name override (e.g. from `--harness`). */
  harnessName?: string;
  /** Explicit CLI path override. */
  cliPath?: string;
  /** Directory to resolve config from (defaults to cwd). */
  baseDir?: string;
  /**
   * Load the DevIntern workspace `.env` as a fallback (CLI only). Desktop
   * callers use the string overload and keep project-scoped lookup.
   */
  workspaceEnvFallback?: boolean;
}

/** Build auth configuration for the CLI's persisted Supabase session. */
export function loadSupabaseConfig(baseDir?: string): SupabaseAuthConfig {
  const configDir = resolveConfigDir({ configDirName: ".devintern-pm", startDir: baseDir });
  return createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json"));
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
 * CLI callers can opt into the DevIntern workspace `.env` fallback; the legacy
 * string overload (pm-desktop) keeps project-scoped lookup.
 *
 * @param optionsOrBaseDir - Optional harness overrides, or a bare base-directory
 *   string (legacy callers such as pm-desktop).
 * @returns Fully resolved {@link Config} for the selected task tracker and agent harness.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export async function loadConfig(optionsOrBaseDir?: LoadConfigOptions | string): Promise<Config> {
  const options =
    typeof optionsOrBaseDir === "string" ? { baseDir: optionsOrBaseDir } : optionsOrBaseDir;
  const trackerConfig = await loadTrackerConfig(".devintern-pm", options?.baseDir, {
    workspaceEnvFallback: options?.workspaceEnvFallback,
  });
  const { agent, agentFallbacks, agentIsFallback } = resolveAgentChain(options);
  // Locate the CLI on PATH and fail fast with an actionable error if missing,
  // instead of surfacing a cryptic spawn error mid-run.
  agent.path = resolveExecutablePathStrict(agent.path, agent.harness.displayName);

  return {
    ...trackerConfig,
    agent,
    agentFallbacks,
    ...(agentIsFallback ? { agentIsFallback } : {}),
  };
}

/**
 * Resolve the primary harness plus usage-limit fallbacks.
 *
 * An explicit harness name disables failover. A single-entry (or unset)
 * `AGENT_HARNESS` resolves exactly like {@link resolveHarness}. A multi-entry
 * chain is resolved by `resolveHarnessChainSync`, whose dropped entries
 * (unknown / not installed) are reported as warnings and never tried; the first
 * usable entry becomes the primary, later ones the fallbacks. When that
 * primary is not the configured first entry it is flagged `agentIsFallback`.
 *
 * @param options - Harness overrides from the caller.
 * @returns The primary harness and its ordered fallbacks.
 */
function resolveAgentChain(options: LoadConfigOptions | undefined): {
  agent: ResolvedHarness;
  agentFallbacks: HarnessChainEntry[];
  agentIsFallback?: boolean;
} {
  const single = (): { agent: ResolvedHarness; agentFallbacks: HarnessChainEntry[] } => ({
    agent: resolveHarness({ harnessName: options?.harnessName, cliPath: options?.cliPath }),
    agentFallbacks: [],
  });
  if (options?.harnessName || parseHarnessList(process.env.AGENT_HARNESS).length < 2) {
    return single();
  }

  // resolveHarness below already emits alias deprecation warnings for the primary.
  const chain = resolveHarnessChainSync({ warnDeprecated: false });
  for (const issue of chain.issues) {
    console.warn(`⚠️  ${issue.message}`);
  }
  const [first, ...rest] = chain.entries;
  if (!first) return single();

  if (first.name === chain.parsed[0]) {
    // Primary is the configured first entry: keep today's resolution
    // (deprecation warnings, AGENT_CLI_PATH / explicit cliPath).
    return { agent: single().agent, agentFallbacks: rest };
  }
  // The configured primary was dropped; the first usable entry takes over.
  // AGENT_CLI_PATH / cliPath target the configured primary, so it keeps its
  // own resolved path (`<HARNESS>_CLI_PATH` or PATH).
  return {
    agent: { harness: first.harness, path: first.path },
    agentFallbacks: rest,
    agentIsFallback: true,
  };
}
