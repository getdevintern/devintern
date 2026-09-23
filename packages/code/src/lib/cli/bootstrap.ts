import { existsSync, renameSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { createDefaultSupabaseAuthConfig } from "@devintern/auth";
import { LicenseCheckError, requireLicense } from "@devintern/license-check";
import type { LicenseCheckResult } from "@devintern/license-check";
import { findEnvFile, maybeOfferCliUpdate, resolveConfigDir } from "@devintern/utils";
import { isAutomatedEnvironment } from "../config/env-detector";
import { isInteractive } from "../init/wizard";
import { flushAnalytics } from "../observability/analytics";
import { initSentryOnce } from "../observability/sentry-init";

// Version is injected at build time via --define flag, or read from package.json in dev
declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0";

let loadedEnvPath: string | null = null;

// Directory of the entrypoint module (`src/` in dev, `dist/` when bundled). The
// package-level `.env` fallback is relative to the entry so the lookup stays
// stable now that environment loading lives outside `src/index.ts`.
let entryDir: string | undefined;

/** Record the entry module's directory for the package-level `.env` fallback. */
export function setEnvironmentEntryDir(dir: string): void {
  entryDir = dir;
}

/** Path of the `.env` file loaded by the most recent {@link loadEnvironment}. */
export function getLoadedEnvPath(): string | null {
  return loadedEnvPath;
}

/**
 * Load environment variables from standard locations or a custom file.
 *
 * Searches upward from the current working directory for the nearest
 * `.devintern-code/.env`, then plain `.env`. Falls back to home directory
 * and package directory if no project config is found.
 *
 * @param envFile - Optional explicit `.env` path (exits on missing file)
 * @returns Path to the loaded .env file, or `null` if none was found
 */
export function loadEnvironment(envFile?: string): string | null {
  loadedEnvPath = loadEnvironmentInner(envFile);
  // Sentry reads SENTRY_DISABLED from process.env, so initialize only after .env
  // loading has had its chance to populate it.
  initSentryOnce(`code@${VERSION}`);
  return loadedEnvPath;
}

function loadEnvironmentInner(envFile?: string): string | null {
  // If user specified a custom env file, use that first
  if (envFile) {
    const customEnvPath = resolve(envFile);
    if (existsSync(customEnvPath)) {
      config({ path: customEnvPath });
      console.log(`📁 Loaded environment from custom file: ${customEnvPath}`);
      return customEnvPath;
    }
    console.error(`❌ Specified .env file not found: ${customEnvPath}`);
    process.exit(1);
  }

  // Otherwise, search upward from cwd for the nearest .env file
  const envPath = findEnvFile({ configDirName: ".devintern-code" });

  if (envPath) {
    config({ path: envPath });
    return envPath;
  }

  // Final fallback: home directory and package directory
  const fallbackPaths = [
    resolve(process.env.HOME || "~", ".env"),
    resolve(entryDir ?? dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  ];

  for (const fallbackPath of fallbackPaths) {
    if (existsSync(fallbackPath)) {
      config({ path: fallbackPath });
      return fallbackPath;
    }
  }

  return null;
}

/** Build Supabase auth config pointing at the project session file. */
export function loadSupabaseConfig() {
  const configDir = resolveConfigDir({ configDirName: ".devintern-code" });
  return createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json"));
}

/**
 * Enforce a license result inside the CLI. `requireLicense` throws a
 * `LicenseCheckError` on failure (library code must never kill the host
 * process); the CLI converts that into its standard failed-check exit code 1
 * after the failure details were already printed to stderr. The exit flushes
 * pending analytics so events captured earlier in the run (e.g. `cli_run`)
 * are not dropped.
 */
export async function enforceLicenseOrExit(result: LicenseCheckResult): Promise<void> {
  try {
    requireLicense(result);
  } catch (error) {
    if (error instanceof LicenseCheckError) await flushAnalyticsAndExit(1);
    throw error;
  }
}

/** Flush pending analytics, then exit with `exitCode`. */
export async function flushAnalyticsAndExit(exitCode: number): Promise<never> {
  await flushAnalytics();
  process.exit(exitCode);
}

/**
 * Check npm for a newer global `@getdevintern/code` and offer/apply an update.
 * Non-interactive sessions skip install by default (see `@devintern/utils`).
 */
export async function checkForCliUpdate(): Promise<void> {
  await maybeOfferCliUpdate({
    packageName: "@getdevintern/code",
    binName: "devintern",
    currentVersion: VERSION,
    isInteractive: isInteractive(process.argv, process.stdin) && !isAutomatedEnvironment(),
    noUpdateEnv: "DEVINTERN_NO_UPDATE",
    autoUpdateEnv: "DEVINTERN_AUTO_UPDATE",
  });
}

/**
 * Rename legacy `.claude-intern` project config to `.devintern-code` once.
 */
export function migrateLegacyConfigDir(): void {
  const cwd = process.cwd();
  const newDir = resolve(cwd, ".devintern-code");
  const oldDir = resolve(cwd, ".claude-intern");

  if (existsSync(newDir)) return;
  if (existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      console.log(`ℹ️  Migrated legacy config directory: .claude-intern → .devintern-code`);
    } catch (error) {
      console.warn(
        `⚠️  Failed to migrate legacy config directory .claude-intern: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
