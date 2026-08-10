/**
 * Packaged-app auto-update via electron-updater (GitHub Releases).
 *
 * - No-ops cleanly when `app.isPackaged` is false (dev / electron-vite preview).
 * - Never throws into the main process lifecycle — failures become status snapshots.
 * - Settings live in userData (outside the app bundle), so applying an update
 *   does not wipe project preference, analytics opt-out, etc.
 */

import {
  UPDATE_INITIAL_CHECK_DELAY_MS,
  UPDATE_PERIODIC_CHECK_MS,
  UPDATE_SNOOZE_MS,
  shouldPromptForUpdate,
  type UpdateStatus,
} from "../shared/auto-update.ts";
import { track } from "./analytics.ts";
import { readSettings, updateSettings } from "./settings.ts";

/** Minimal surface of electron-updater's AppUpdater used by this module. */
export type UpdaterReleaseNotes = string | Array<{ version?: string; note?: string }> | null;

export interface UpdaterUpdateInfo {
  version: string;
  releaseNotes?: UpdaterReleaseNotes;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{ updateInfo: UpdaterUpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  // EventEmitter-style; payload types differ per event name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
}

export function normalizeReleaseNotes(notes: UpdaterReleaseNotes | undefined): string | null {
  if (notes == null) return null;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    const text = notes
      .map((entry) => entry.note?.trim())
      .filter((note): note is string => Boolean(note))
      .join("\n");
    return text.length > 0 ? text : null;
  }
  return null;
}

export type UpdateStatusListener = (status: UpdateStatus) => void;

export interface AutoUpdateOptions {
  isPackaged: boolean;
  currentVersion: string;
  /** Injected in production from `electron-updater`; mocked in tests. */
  createUpdater?: () => UpdaterLike;
  now?: () => number;
}

let status: UpdateStatus = {
  phase: "idle",
  currentVersion: "0.0.0",
};
let listeners = new Set<UpdateStatusListener>();
let updater: UpdaterLike | null = null;
let checkInFlight: Promise<void> | null = null;
let downloadInFlight: Promise<UpdateStatus> | null = null;
/**
 * When a check is in flight, whether it should force-clear snooze for event handlers.
 * Manual checks (`silent: false`) set this true so a late `update-available` IIFE cannot
 * re-apply snooze after `checkForUpdates` already forced `snoozed: false`.
 */
let forcePromptForInFlightCheck = false;
/** Bumped at the start of each check so stale `update-available` IIFEs are ignored. */
let checkGeneration = 0;
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let periodicTimer: ReturnType<typeof setInterval> | undefined;
let opts: AutoUpdateOptions | null = null;
/** Last version we announced as available (for analytics dedupe). */
let lastTrackedAvailable: string | undefined;

function emit(): void {
  for (const listener of listeners) {
    try {
      listener(status);
    } catch {
      // Listener failures must not break update flow.
    }
  }
}

function setStatus(patch: Partial<UpdateStatus> & Pick<UpdateStatus, "phase">): void {
  status = {
    ...status,
    ...patch,
    currentVersion: opts?.currentVersion ?? status.currentVersion,
  };
  emit();
}

async function readSnoozed(availableVersion: string, force: boolean): Promise<boolean> {
  if (force) return false;
  const settings = await readSettings();
  return !shouldPromptForUpdate({
    availableVersion,
    snoozedVersion: settings.updateSnoozedVersion,
    snoozedUntil: settings.updateSnoozedUntil,
    now: opts?.now?.() ?? Date.now(),
  });
}

function wireUpdater(instance: UpdaterLike): void {
  instance.autoDownload = false;
  instance.autoInstallOnAppQuit = true;
  instance.logger = null;

  instance.on("checking-for-update", () => {
    setStatus({ phase: "checking", errorMessage: undefined, download: undefined });
  });

  instance.on("update-available", (info: UpdaterUpdateInfo) => {
    // Capture at event time — the async read below may finish after checkForUpdates
    // has already applied force-clear snooze for a manual check.
    const force = forcePromptForInFlightCheck;
    const generation = checkGeneration;
    void (async () => {
      const snoozed = await readSnoozed(info.version, force);
      // Ignore stale handlers from a previous check (e.g. silent IIFE finishing
      // after a newer manual check already forced snoozed: false).
      if (generation !== checkGeneration) {
        return;
      }
      setStatus({
        phase: "available",
        availableVersion: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        snoozed,
        errorMessage: undefined,
        download: undefined,
      });
      if (!snoozed && lastTrackedAvailable !== info.version) {
        lastTrackedAvailable = info.version;
        void track("update_available", {
          app_version: opts?.currentVersion,
          update_version: info.version,
        });
      }
    })();
  });

  instance.on("update-not-available", () => {
    setStatus({
      phase: "not-available",
      availableVersion: undefined,
      releaseNotes: undefined,
      snoozed: false,
      download: undefined,
      errorMessage: undefined,
    });
  });

  instance.on(
    "download-progress",
    (progress: { percent: number; transferred: number; total: number }) => {
      setStatus({
        phase: "downloading",
        download: {
          percent: Math.min(100, Math.max(0, progress.percent)),
          transferred: progress.transferred,
          total: progress.total,
        },
        errorMessage: undefined,
      });
    },
  );

  instance.on("update-downloaded", (info: UpdaterUpdateInfo) => {
    setStatus({
      phase: "downloaded",
      availableVersion: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      download: { percent: 100, transferred: 0, total: 0 },
      errorMessage: undefined,
      snoozed: false,
    });
    void track("update_downloaded", {
      app_version: opts?.currentVersion,
      update_version: info.version,
    });
  });

  instance.on("error", (error: Error) => {
    // Ignore spurious errors while disabled / before init completes.
    if (!opts?.isPackaged) return;
    const message = error.message || "Update failed";
    setStatus({
      phase: "error",
      errorMessage: message,
      download: undefined,
    });
    void track("update_failed", {
      app_version: opts?.currentVersion,
      ok: false,
    });
  });
}

/**
 * Initialize auto-update. Safe to call once after `app.whenReady()`.
 * Unpacks / `electron-vite dev` stay disabled — no GitHub calls, no error spam.
 */
export function initAutoUpdate(options: AutoUpdateOptions): UpdateStatus {
  opts = options;
  status = {
    phase: options.isPackaged ? "idle" : "disabled",
    currentVersion: options.currentVersion,
    disabledReason: options.isPackaged ? undefined : "not-packaged",
  };

  if (!options.isPackaged) {
    emit();
    return status;
  }

  if (!options.createUpdater) {
    setStatus({
      phase: "error",
      errorMessage: "Updater is not configured.",
    });
    return status;
  }

  try {
    updater = options.createUpdater();
    wireUpdater(updater);
  } catch (error) {
    setStatus({
      phase: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return status;
  }

  emit();
  return status;
}

/** Start delayed + periodic background checks (packaged only). */
export function startAutoUpdateChecks(): void {
  stopAutoUpdateChecks();
  if (!opts?.isPackaged || !updater) return;

  initialTimer = setTimeout(() => {
    void checkForUpdates({ silent: true });
  }, UPDATE_INITIAL_CHECK_DELAY_MS);

  periodicTimer = setInterval(() => {
    void checkForUpdates({ silent: true });
  }, UPDATE_PERIODIC_CHECK_MS);
  // Unref so these timers do not keep the process alive alone in tests / quit.
  initialTimer.unref?.();
  periodicTimer.unref?.();
}

export function stopAutoUpdateChecks(): void {
  if (initialTimer !== undefined) clearTimeout(initialTimer);
  if (periodicTimer !== undefined) clearInterval(periodicTimer);
  initialTimer = undefined;
  periodicTimer = undefined;
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function subscribeUpdateStatus(listener: UpdateStatusListener): () => void {
  listeners.add(listener);
  listener(status);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Check the release feed. Concurrent calls coalesce onto one in-flight check.
 * @param silent When true (background), snoozed versions stay quiet and network
 *               failures do not surface as error toasts. Manual checks pass `silent: false`.
 */
export async function checkForUpdates(options?: { silent?: boolean }): Promise<UpdateStatus> {
  if (!opts?.isPackaged || !updater) {
    return status;
  }

  if (checkInFlight) {
    await checkInFlight;
    return status;
  }

  const silent = options?.silent === true;
  checkGeneration += 1;
  forcePromptForInFlightCheck = !silent;

  checkInFlight = (async () => {
    try {
      setStatus({ phase: "checking", errorMessage: undefined });
      const result = await updater!.checkForUpdates();

      if (result?.updateInfo?.version) {
        const snoozed = await readSnoozed(result.updateInfo.version, !silent);
        // Events may have already set phase; re-assert with snooze semantics.
        if (status.phase === "checking" || status.phase === "available") {
          setStatus({
            phase: "available",
            availableVersion: result.updateInfo.version,
            releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
            snoozed,
            errorMessage: undefined,
          });
        }
      } else if (status.phase === "checking") {
        setStatus({ phase: "not-available" });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not check for updates. Try again when you are online.";

      if (silent) {
        // Keep a known update offer; otherwise return to idle without alarming the user.
        if (status.phase === "available" || status.phase === "downloaded") {
          return;
        }
        setStatus({ phase: "idle", errorMessage: undefined });
        return;
      }

      setStatus({
        phase: "error",
        errorMessage: message || "Could not check for updates. Try again when you are online.",
        download: undefined,
      });
      void track("update_failed", { app_version: opts?.currentVersion, ok: false });
    }
  })();

  try {
    await checkInFlight;
  } finally {
    checkInFlight = null;
    forcePromptForInFlightCheck = false;
  }
  return status;
}

/** Begin downloading the available update (user chose Install). */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!opts?.isPackaged || !updater) {
    return status;
  }
  if (status.phase === "downloaded") {
    return status;
  }
  if (status.phase === "downloading" || downloadInFlight) {
    return downloadInFlight ?? status;
  }
  if (status.phase !== "available" && status.phase !== "error") {
    setStatus({
      phase: "error",
      errorMessage: "No update is available to download.",
    });
    return status;
  }

  downloadInFlight = (async () => {
    try {
      setStatus({
        phase: "downloading",
        download: { percent: 0, transferred: 0, total: 0 },
        errorMessage: undefined,
        snoozed: false,
      });
      await updater!.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({
        phase: "error",
        errorMessage: message || "Download failed. You can retry or dismiss.",
        download: undefined,
      });
      void track("update_failed", { app_version: opts?.currentVersion, ok: false });
    }
    return status;
  })();

  try {
    return await downloadInFlight;
  } finally {
    downloadInFlight = null;
  }
}

/**
 * Quit and install the downloaded update.
 * Electron-updater replaces app files under the install prefix; userData
 * (settings.json) is preserved outside that tree.
 */
export function installUpdate(): UpdateStatus {
  if (!opts?.isPackaged || !updater) {
    return status;
  }
  if (status.phase !== "downloaded") {
    setStatus({
      phase: "error",
      errorMessage: "Update is not ready to install yet.",
    });
    return status;
  }

  void track("update_applied", {
    app_version: opts.currentVersion,
    update_version: status.availableVersion,
  });

  // isSilent=false, isForceRunAfter=true → relaunch after install.
  updater.quitAndInstall(false, true);
  return status;
}

/** "Later" — hide prompts for this version until the snooze window elapses. */
export async function snoozeUpdate(): Promise<UpdateStatus> {
  const version = status.availableVersion;
  if (!version) return status;
  const until = (opts?.now?.() ?? Date.now()) + UPDATE_SNOOZE_MS;
  await updateSettings({
    updateSnoozedVersion: version,
    updateSnoozedUntil: until,
  });
  setStatus({ snoozed: true, phase: status.phase });
  return status;
}

/** Clear a recoverable error back to idle / available. */
export function dismissUpdateError(): UpdateStatus {
  if (status.phase !== "error") return status;
  setStatus({
    phase: status.availableVersion ? "available" : "idle",
    errorMessage: undefined,
    download: undefined,
  });
  return status;
}

/** @internal Reset module state between tests. */
export function resetAutoUpdateForTests(): void {
  stopAutoUpdateChecks();
  status = { phase: "idle", currentVersion: "0.0.0" };
  listeners = new Set();
  updater = null;
  checkInFlight = null;
  downloadInFlight = null;
  forcePromptForInFlightCheck = false;
  checkGeneration = 0;
  opts = null;
  lastTrackedAvailable = undefined;
}
