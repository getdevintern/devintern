/**
 * Auto-update status types shared by main, preload, and renderer.
 *
 * Packaged builds use electron-updater against the GitHub Releases feed.
 * Dev / unpackaged runs stay in the `disabled` phase (no network, no errors).
 */

export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdateDownloadProgress {
  /** 0–100 */
  percent: number;
  transferred: number;
  total: number;
}

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  /** Set when phase is `disabled` because the app is not a packaged install. */
  disabledReason?: "not-packaged";
  availableVersion?: string;
  /** Short release notes / body when the feed provides them. */
  releaseNotes?: string | null;
  download?: UpdateDownloadProgress;
  errorMessage?: string;
  /** True when the user snoozed this available version and the cooldown has not expired. */
  snoozed?: boolean;
}

/** How long "Later" hides the prompt for the same version. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** Delay before the first background check so launch UI is not contending for CPU/network. */
export const UPDATE_INITIAL_CHECK_DELAY_MS = 8_000;

/** Periodic re-check while the app stays open. */
export const UPDATE_PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Whether the UI should surface an update prompt for `availableVersion`.
 * Manual checks bypass snooze; background prompts respect it.
 */
export function shouldPromptForUpdate(input: {
  availableVersion: string;
  snoozedVersion?: string;
  snoozedUntil?: number;
  now: number;
  /** When true (About "Check for updates"), ignore snooze. */
  force?: boolean;
}): boolean {
  if (input.force) return true;
  if (
    input.snoozedVersion === input.availableVersion &&
    input.snoozedUntil !== undefined &&
    input.now < input.snoozedUntil
  ) {
    return false;
  }
  return true;
}

/** Human-readable one-liner for the update prompt / banner. */
export function formatUpdateAvailableMessage(
  availableVersion: string,
  currentVersion: string,
): string {
  return `Version ${availableVersion} is available (you have ${currentVersion}).`;
}
