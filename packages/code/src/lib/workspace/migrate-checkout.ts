/**
 * Automatic migration of a checkout's legacy `.devintern-code/` into the
 * workspace, run on the first manual run (or `init`) of a release that keeps
 * configuration in `~/.devintern`. There is no migrate command: a checkout
 * that still has a local `.devintern-code/.env` and a recognised `origin` is
 * registered as a `manual_only` repo the moment DevIntern starts in it.
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
import { workspaceCodeStateDir, workspaceConfigPath } from "./paths";
import { readRegistrableOrigin, registerManualCheckout } from "./register-checkout";
import { appendTrackerSettings } from "./tracker-settings";

/** Local, gitignored state files moved into `state/code/`. */
const MOVED_STATE_FILES = [".auth-session.json", "license-cache.json"] as const;

/** Outcome of {@link migrateLegacyCheckout}. */
export type CheckoutMigration =
  | { migrated: false }
  | { migrated: true; repoName: string; envPath: string; trackers: string[] };

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
 * without a recognised `origin`, or when the checkout is already registered.
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
  if (!existsSync(legacyEnv)) return { migrated: false };
  if (!(await readRegistrableOrigin(projectRoot))) return { migrated: false };
  if (await findWorkspaceRepoForCheckout({ cwd: projectRoot })) return { migrated: false };

  let envContent: string;
  try {
    envContent = readFileSync(legacyEnv, "utf8");
  } catch {
    return { migrated: false };
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

  const stateDir = workspaceCodeStateDir(registered.workspaceDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of MOVED_STATE_FILES) {
    const source = join(legacyDir, name);
    const target = join(stateDir, name);
    if (existsSync(source) && !existsSync(target)) {
      try {
        copyFileSync(source, target);
        chmodSync(target, 0o600);
      } catch {
        continue;
      }
    }
    if (existsSync(target)) rmSync(source, { force: true });
  }

  let trackers: string[] = [];
  try {
    trackers = migrateTrackerSettings(registered.workspaceDir, readLegacySettings(legacyDir));
  } catch (error) {
    log(`⚠️  Could not copy tracker settings into workspace.toml: ${(error as Error).message}`);
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
