/**
 * Tiny JSON settings store at `<userData>/settings.json`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Settings {
  lastProjectDir?: string;
  /**
   * When true, never show the @devintern/code discovery tip again
   * (persists across sessions and project switches until app data is cleared).
   */
  codeDiscoveryDismissed?: boolean;
  /** Anonymous install id for product analytics (UUID). Created on first use. */
  installId?: string;
  /**
   * When false, anonymous usage analytics are disabled.
   * Omitted / undefined means enabled (default on).
   */
  analyticsEnabled?: boolean;
}

/** Analytics is on unless the user explicitly opted out. */
export function isAnalyticsEnabled(settings: Settings): boolean {
  return settings.analyticsEnabled !== false;
}

/** Test-only override so round-trips use an isolated temp userData directory. */
let userDataDirForTests: string | undefined;

/** @internal Isolate settings I/O in tests. Pass `undefined` to restore Electron's path. */
export function setUserDataDirForTests(dir: string | undefined): void {
  userDataDirForTests = dir;
}

async function settingsPath(): Promise<string> {
  if (userDataDirForTests !== undefined) {
    return join(userDataDirForTests, "settings.json");
  }
  // Lazy so unit tests can override userData without loading Electron.
  const { app } = await import("electron");
  return join(app.getPath("userData"), "settings.json");
}

export async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(await settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

/** Serialize read-modify-write so concurrent patches cannot drop each other's keys. */
let updateChain: Promise<void> = Promise.resolve();

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const run = async (): Promise<void> => {
    const current = await readSettings();
    const next = { ...current, ...patch };
    const path = await settingsPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  };

  // Chain regardless of prior failure so one bad write does not stall later updates.
  const next = updateChain.then(run, run);
  updateChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
