/**
 * Tiny JSON settings store at `<userData>/settings.json`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectBinding } from "../shared/project-binding.ts";

export interface Settings {
  lastProjectDir?: string;
  /**
   * Recently opened PM-ready project directories (most recent first).
   * Only paths with both `.git` and `.devintern-pm` are kept; filtered when
   * listed and pruned when recording.
   */
  recentProjectDirs?: string[];
  /**
   * Connected project bindings (managed GitHub clones + unmanaged folder opens).
   * Sidebar identity: `{ remote, localPath, lastFetch, managed }`.
   */
  projectBindings?: ProjectBinding[];
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
  /** Version the user chose "Later" for (paired with {@link updateSnoozedUntil}). */
  updateSnoozedVersion?: string;
  /** Epoch ms until which {@link updateSnoozedVersion} prompts stay hidden. */
  updateSnoozedUntil?: number;
  /**
   * When true, the Quick Capture global shortcut is registered. Default off —
   * an OS-wide hotkey is opt-in.
   */
  quickCaptureEnabled?: boolean;
  /** Custom Quick Capture accelerator; null/undefined uses the platform default. */
  quickCaptureShortcut?: string | null;
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

/**
 * Merge a patch, or derive the next settings from the latest on-disk value inside
 * the same serialize chain (for read-modify-write that must not race).
 */
export async function updateSettings(
  patchOrUpdater: Partial<Settings> | ((current: Settings) => Settings),
): Promise<void> {
  const run = async (): Promise<void> => {
    const current = await readSettings();
    const next =
      typeof patchOrUpdater === "function"
        ? patchOrUpdater(current)
        : { ...current, ...patchOrUpdater };
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
