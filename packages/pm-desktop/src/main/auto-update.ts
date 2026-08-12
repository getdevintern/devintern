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
} from "../shared/auto-update.ts";
import type { UpdateStatus } from "../shared/auto-update.ts";
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

/**
 * Resolve `autoUpdater` from an `electron-updater` module namespace.
 *
 * electron-updater is CommonJS and exposes `autoUpdater` via a getter. ESM
 * interop (and `const { autoUpdater } = await import(...)`) often yields
 * `undefined`, which then fails at `instance.autoDownload = …` with
 * "Cannot set properties of undefined". Prefer reading from the default
 * export namespace — see electron-builder#7976.
 */
export function resolveElectronAutoUpdater(mod: unknown): UpdaterLike {
  if (mod == null || typeof mod !== "object") {
    throw new Error("electron-updater module did not load.");
  }
  const record = mod as Record<string, unknown>;
  const candidates = [record.autoUpdater];
  const def = record.default;
  if (def != null && typeof def === "object") {
    candidates.push((def as Record<string, unknown>).autoUpdater);
  }
  for (const candidate of candidates) {
    if (candidate != null && typeof candidate === "object") {
      return candidate as UpdaterLike;
    }
  }
  throw new Error(
    "electron-updater autoUpdater is unavailable (ESM/CJS interop). See electron-builder#7976.",
  );
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
/**
 * Phase (and available version) captured BEFORE a check flips status to "checking".
 * The `update-available` handler reads these (guarded by `checkGeneration`) to suppress
 * a transient "available" flicker when a periodic re-check fires for a version we are
 * already downloading or have already staged — without this, the handler sees
 * status.phase === "checking" and regresses to "available" until the post-await
 * re-assertion restores the real phase.
 */
let preCheckPhase: UpdateStatus["phase"] = "idle";
let preCheckAvailableVersion: string | undefined;
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

/**
 * Keep `autoInstallOnAppQuit` in sync with the snooze state of the currently
 * available version. When the user snoozed, a downloaded update must NOT be
 * applied on the next normal quit — otherwise "Later" is purely cosmetic.
 * Re-evaluated on every snooze read and when snooze expires (next check).
 */
function applyAutoInstallOnAppQuit(snoozed: boolean): void {
  if (!updater) return;
  updater.autoInstallOnAppQuit = !snoozed;
}

function wireUpdater(instance: UpdaterLike): void {
  // Auto-download so a found update is fetched in the background without
  // requiring the user to click anything. The notifier banner still gates
  // when to surface progress / restart prompts (and respects snooze).
  // autoInstallOnAppQuit applies a downloaded update on the next normal quit
  // — the safest "hands-off" install path because the user chose to leave.
  // It is gated on snooze: when the user clicked "Later" for the available
  // version, we must NOT silently install on quit — that would make the
  // snooze cosmetic. Re-evaluated on every snooze read (checkForUpdates,
  // update-available, snoozeUpdate) and when snooze expires (next check).
  instance.autoDownload = true;
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
      // Don't regress from a downloaded or downloading state: a periodic
      // re-check of the same feed fires `update-available` again, but we
      // already have the payload staged (or are actively fetching it) and
      // only need a restart — surfacing "available" again would lose that
      // progress and re-prompt the user to download what they already have.
      // Use the pre-check phase (captured before status was flipped to
      // "checking") so the guard still fires during a periodic re-check;
      // fall back to the live phase for events fired outside a check.
      const wasDownloadingOrDownloaded =
        (preCheckPhase === "downloaded" || preCheckPhase === "downloading") &&
        preCheckAvailableVersion === info.version;
      const isDownloadingOrDownloaded =
        (status.phase === "downloaded" || status.phase === "downloading") &&
        status.availableVersion === info.version;
      // Even when skipping a phase regression to "available", still keep
      // autoInstallOnAppQuit and status.snoozed in sync — otherwise a
      // periodic re-check while downloading/downloaded never clears an
      // expired snooze (and the ready banner stays hidden).
      applyAutoInstallOnAppQuit(snoozed);
      if (wasDownloadingOrDownloaded || isDownloadingOrDownloaded) {
        if (status.snoozed !== snoozed) {
          setStatus({ phase: status.phase, snoozed });
        }
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
    // Ready-to-install clears snooze so the restart banner reappears, and
    // re-enables install-on-quit so a downloaded update still applies on the
    // next normal quit if the user ignores the banner (docs: applied on quit).
    applyAutoInstallOnAppQuit(false);
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
    const instance = options.createUpdater();
    if (instance == null || typeof instance !== "object") {
      throw new Error("Updater factory returned no instance.");
    }
    updater = instance;
    wireUpdater(instance);
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

  const suppressAutoDownload = status.phase === "downloaded" || status.phase === "downloading";
  checkInFlight = (async () => {
    // Capture before we clobber phase → "checking": if the feed still points
    // at a version we already have staged (downloaded) or are actively
    // fetching (downloading), we must not regress to "available" (a periodic
    // re-check would otherwise re-prompt the user and lose in-flight progress).
    // Declared outside try so silent catch can restore a wiped downloading UI.
    const previouslyDownloaded =
      status.phase === "downloaded" ? status.availableVersion : undefined;
    const previouslyDownloading =
      status.phase === "downloading" ? status.availableVersion : undefined;
    const previousDownloadProgress = status.download;
    try {
      // Suppress electron-updater's internal auto-download during this check
      // when a download is already in flight or already staged — otherwise
      // `checkForUpdates()` fires `update-available` and starts a DUPLICATE
      // download for the same version. Restored in the finally below.
      if (suppressAutoDownload) {
        updater!.autoDownload = false;
      }
      preCheckPhase = status.phase;
      preCheckAvailableVersion = status.availableVersion;
      setStatus({ phase: "checking", errorMessage: undefined });
      const result = await updater!.checkForUpdates();

      if (result?.updateInfo?.version) {
        const snoozed = await readSnoozed(result.updateInfo.version, !silent);
        applyAutoInstallOnAppQuit(snoozed);
        if (previouslyDownloaded && previouslyDownloaded === result.updateInfo.version) {
          // Re-assert the downloaded state (the update-available event fired
          // during the check may have flipped us to "available"). Always
          // re-evaluate snooze so an expired window clears here too.
          setStatus({
            phase: "downloaded",
            availableVersion: result.updateInfo.version,
            releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
            download: { percent: 100, transferred: 0, total: 0 },
            errorMessage: undefined,
            snoozed,
          });
          return;
        }
        if (previouslyDownloading && previouslyDownloading === result.updateInfo.version) {
          // Re-assert the in-flight download state — the update-available
          // event during the check flipped us to "available", but the
          // auto-download is already running and we must preserve its progress.
          setStatus({
            phase: "downloading",
            availableVersion: result.updateInfo.version,
            releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
            download: previousDownloadProgress ?? {
              percent: 0,
              transferred: 0,
              total: 0,
            },
            errorMessage: undefined,
            snoozed,
          });
          return;
        }
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
        // Keep a known update offer or in-flight download; otherwise return
        // to idle without alarming the user. Preserve downloading too —
        // checking-for-update cleared progress, but electron-updater may
        // still be fetching, and a network blip on the check must not wipe UI.
        if (
          status.phase === "available" ||
          status.phase === "downloaded" ||
          status.phase === "downloading"
        ) {
          return;
        }
        if (previouslyDownloading) {
          setStatus({
            phase: "downloading",
            availableVersion: previouslyDownloading,
            download: previousDownloadProgress,
            errorMessage: undefined,
          });
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
    } finally {
      if (suppressAutoDownload) {
        updater!.autoDownload = true;
      }
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
  applyAutoInstallOnAppQuit(true);
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
  preCheckPhase = "idle";
  preCheckAvailableVersion = undefined;
  opts = null;
  lastTrackedAvailable = undefined;
}
