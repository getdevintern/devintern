/**
 * Automatic migration of a checkout's legacy `.devintern-code/` into the
 * workspace, run on the first manual run (or `init`) of a release that keeps
 * configuration in `~/.devintern`. There is no migrate command: a checkout
 * that still has a local `.devintern-code/.env` is registered as a
 * `manual_only` repo (by its `origin`, or by its directory without one) the moment DevIntern starts in it.
 *
 * What moves:
 * - `.devintern-code/.env` becomes `~/.devintern/env/<repo>.env` (the local
 *   file is removed; it is gitignored and now unused).
 * - The local sign-in session and license cache move to `state/code/` when
 *   the workspace has none yet.
 * - Tracker sections of `.devintern-code/settings.json` are copied into
 *   `[trackers]` in `workspace.toml` (the file itself is committed, so it is
 *   left for the team to delete).
 *
 * The checkout's local `queue.db` (manual run history) is left behind.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

import { findProjectRoot } from "@devintern/utils";

import type { ProjectSettings } from "../../types/settings";
import { isWorkerSubprocess } from "../config/config-dir";
import { parseWorkspaceConfig } from "./config";
import type { WorkspaceLogFn } from "./init";
import { findWorkspaceRepoForCheckout } from "./manual-run";
import { resolveWorkspaceDir, workspaceCodeStateDir, workspaceConfigPath } from "./paths";
import { registerManualCheckout } from "./register-checkout";
import { appendTrackerSettings, TRACKER_SETTINGS_NAMES } from "./tracker-settings";

/** Local, gitignored state files moved into `state/code/`. */
const MOVED_STATE_FILES = [".auth-session.json", "license-cache.json"] as const;

/** Outcome of {@link migrateLegacyCheckout}. */
export type CheckoutMigration =
  | { migrated: false }
  | { migrated: true; repoName: string; envPath: string; trackers: string[] };

/**
 * Move the checkout's sign-in session and license cache into the workspace's
 * `state/code/`. A file the workspace already has wins; the local copy is
 * removed either way once the workspace holds one.
 */
export function moveLegacyStateFiles(legacyDir: string, workspaceDir: string): void {
  if (!MOVED_STATE_FILES.some((name) => existsSync(join(legacyDir, name)))) return;
  const stateDir = workspaceCodeStateDir(workspaceDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of MOVED_STATE_FILES) {
    const source = join(legacyDir, name);
    if (!existsSync(source)) continue;
    const target = join(stateDir, name);
    if (!existsSync(target)) {
      try {
        copyFileSync(source, target);
        chmodSync(target, 0o600);
      } catch {
        continue;
      }
    }
    rmSync(source, { force: true });
  }
}

/**
 * Move a legacy checkout's sign-in and license cache into the workspace at
 * CLI startup, so every command (including `login`, `logout`, `whoami`)
 * sees one session. Cheap: only existence checks unless files are present.
 */
export function moveLegacyCheckoutState(cwd: string = process.cwd()): void {
  if (isWorkerSubprocess()) return;
  const legacyDir = join(findProjectRoot({ startDir: cwd }), ".devintern-code");
  try {
    moveLegacyStateFiles(legacyDir, resolveWorkspaceDir());
  } catch {
    // Best effort: the session can still be recreated with `devintern login`.
  }
}

const warnedPipelineFiles = new Set<string>();

/**
 * Copy a checkout's committed `.devintern-code/settings.json` tracker
 * sections into `[trackers]` (new keys only) and warn, once per file, about a
 * pipeline that is no longer read. Used by the worker for every worktree it
 * prepares, so repos that still commit the file keep their status names.
 * Never throws.
 *
 * @returns `tracker/KEY` labels added
 */
export function migrateCommittedTrackerSettings(
  workspaceDir: string,
  checkoutDir: string,
  log: WorkspaceLogFn = console.log,
): string[] {
  const settingsPath = join(checkoutDir, ".devintern-code", "settings.json");
  try {
    const legacy = readLegacySettings(join(checkoutDir, ".devintern-code"));
    if (legacy?.pipeline && !warnedPipelineFiles.has(settingsPath)) {
      warnedPipelineFiles.add(settingsPath);
      log(
        `⚠️  ${settingsPath} defines a pipeline, which is not read; ` +
          "set pipeline_file on the repo's [[repos]] entry instead.",
      );
    }
    const added = migrateTrackerSettings(workspaceDir, legacy);
    if (added.length > 0) {
      log(`📦 Copied tracker status names into workspace.toml: ${added.join(", ")}`);
    }
    return added;
  } catch (error) {
    log(`⚠️  Could not copy tracker settings from ${settingsPath}: ${(error as Error).message}`);
    return [];
  }
}

/** Whether legacy settings carry tracker project sections (or the Jira map). */
function hasTrackerSections(settings: ProjectSettings | null): boolean {
  if (!settings) return false;
  return (
    Boolean(settings.projects) ||
    TRACKER_SETTINGS_NAMES.some((name) => Object.keys(settings[name]?.projects ?? {}).length > 0)
  );
}

/** Read `settings.json`, or null when missing or unreadable. */
export function readLegacySettings(configDir: string): ProjectSettings | null {
  const path = join(configDir, "settings.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProjectSettings;
  } catch {
    return null;
  }
}

/**
 * Copy a legacy settings file's tracker sections into `workspace.toml`.
 *
 * @returns `tracker/KEY` labels added; empty when nothing was missing
 */
export function migrateTrackerSettings(
  workspaceDir: string,
  settings: ProjectSettings | null,
): string[] {
  if (!settings) return [];
  const configPath = workspaceConfigPath(workspaceDir);
  return appendTrackerSettings(workspaceDir, settings, (text) =>
    parseWorkspaceConfig(text, configPath),
  );
}

/**
 * Register a legacy checkout in the workspace, once.
 *
 * Skipped in worker task subprocesses, without a local `.devintern-code/.env`,
 * or when the checkout is already registered.
 * Failures are reported and leave the legacy setup working.
 *
 * @param cwd - Directory the CLI started in (any depth inside the checkout)
 * @param log - Status messages
 */
export async function migrateLegacyCheckout(
  cwd: string = process.cwd(),
  log: WorkspaceLogFn = console.log,
): Promise<CheckoutMigration> {
  if (isWorkerSubprocess()) return { migrated: false };
  const projectRoot = findProjectRoot({ startDir: cwd });
  const legacyDir = join(projectRoot, ".devintern-code");
  const legacyEnv = join(legacyDir, ".env");
  // Sign-in and license cache move even for a checkout that is not registered.
  moveLegacyStateFiles(legacyDir, resolveWorkspaceDir());
  const legacySettings = readLegacySettings(legacyDir);
  const hasEnv = existsSync(legacyEnv);
  // Committed tracker settings alone also register the checkout, so their
  // status names are not lost now that settings.json is no longer read.
  if (!hasEnv && !hasTrackerSections(legacySettings)) return { migrated: false };
  if (await findWorkspaceRepoForCheckout({ cwd: projectRoot })) return { migrated: false };

  let envContent = "";
  if (hasEnv) {
    try {
      envContent = readFileSync(legacyEnv, "utf8");
    } catch {
      return { migrated: false };
    }
  }

  const quiet: WorkspaceLogFn = () => {};
  let registered;
  try {
    registered = await registerManualCheckout(projectRoot, envContent, quiet);
  } catch (error) {
    log(`⚠️  Could not move ${legacyDir} into ~/.devintern: ${(error as Error).message}`);
    return { migrated: false };
  }
  if (!registered.ok) {
    log(`⚠️  Could not move ${legacyDir} into ~/.devintern: ${registered.error}`);
    return { migrated: false };
  }

  moveLegacyStateFiles(legacyDir, registered.workspaceDir);

  let trackers: string[] = [];
  try {
    trackers = migrateTrackerSettings(registered.workspaceDir, legacySettings);
  } catch (error) {
    log(`⚠️  Could not copy tracker settings into workspace.toml: ${(error as Error).message}`);
  }

  if (legacySettings?.pipeline) {
    log(
      `⚠️  ${join(legacyDir, "settings.json")} defines a pipeline, which is no longer read. ` +
        "Move it to a workspace pipeline_file (see the pipelines docs).",
    );
  }

  // The env content now lives in the workspace; the local copy is unused.
  rmSync(legacyEnv, { force: true });

  log(
    `📦 Moved this repository's DevIntern settings to ~/.devintern (repo "${registered.repoName}").`,
  );
  log(`   Settings: ${registered.envPath}`);
  if (trackers.length > 0)
    log(`   Tracker status names copied to [trackers]: ${trackers.join(", ")}`);
  if (existsSync(join(legacyDir, "settings.json")) || existsSync(join(legacyDir, ".env.example"))) {
    log(
      `   ${legacyDir} still has committed files (settings.json, .env.example); you can remove them.`,
    );
  }
  return {
    migrated: true,
    repoName: registered.repoName,
    envPath: registered.envPath,
    trackers,
  };
}
