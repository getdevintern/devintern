/**
 * Quick Capture: an OS-level global shortcut that focuses (or launches) the
 * app and opens a fresh ticket workspace, optionally prefilled from the
 * clipboard.
 *
 * Registration state lives in settings.json (`quickCaptureEnabled` /
 * `quickCaptureShortcut`); the effective accelerator defaults to
 * {@link DEFAULT_QUICK_CAPTURE_ACCELERATOR} when no custom binding is set.
 * Disabled state never holds a global hotkey, and a failed registration
 * (conflict / invalid binding) surfaces through {@link QuickCaptureStatus.error}
 * instead of failing silently.
 *
 * Electron surfaces are injected as ports so the logic stays unit-testable
 * outside a running Electron process (same approach as auto-update.ts).
 */

import { IPC_CHANNELS } from "../shared/ipc-contract.ts";
import {
  isValidAcceleratorShape,
  quickCaptureConflictMessage,
  resolveQuickCaptureAccelerator,
  sanitizeCapturedText,
} from "../shared/quick-capture.ts";
import type {
  QuickCaptureConfig,
  QuickCaptureEvent,
  QuickCaptureStatus,
} from "../shared/quick-capture.ts";
import { track } from "./analytics.ts";
import { readSettings, updateSettings } from "./settings.ts";

/** Minimal surface of Electron's globalShortcut used by this module. */
export interface GlobalShortcutLike {
  register(accelerator: string, listener: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Minimal BrowserWindow surface needed to focus and deliver captures. */
export interface QuickCaptureWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: {
    isLoading(): boolean;
    send(channel: string, ...args: unknown[]): void;
    once(event: "did-finish-load" | "did-fail-load", listener: () => void): void;
  };
}

export interface QuickCapturePorts {
  globalShortcut: GlobalShortcutLike;
  /** System clipboard text at invocation time. Never logged or persisted. */
  readClipboardText(): string | undefined | null;
  getWindow(): QuickCaptureWindow | null | undefined;
  /** Used when the app has no live window yet (macOS background, closed window). */
  createWindow?(): QuickCaptureWindow | null | undefined;
  /**
   * Bring the application itself to the foreground (macOS needs
   * `app.focus({ steal: true })`; window.focus() alone does not).
   */
  activateApp?(): void;
}

interface ActivePorts {
  ports: QuickCapturePorts;
  handler: () => void;
}

let active: ActivePorts | null = null;
let registeredShortcut: string | null = null;
let lastError: string | undefined;

/**
 * Wire Electron-backed ports. Called once during app startup. Passing
 * `undefined` detaches and releases any held shortcut.
 */
export function initQuickCapture(ports: QuickCapturePorts | undefined): void {
  if (!ports) {
    disposeQuickCapture();
    active = null;
    return;
  }
  active = { ports, handler: () => invokeQuickCapture() };
  registeredShortcut = null;
  lastError = undefined;
}

function unregisterCurrent(): void {
  if (!active || !registeredShortcut) return;
  active.ports.globalShortcut.unregister(registeredShortcut);
  registeredShortcut = null;
}

function statusSnapshot(enabled: boolean, shortcut: string): QuickCaptureStatus {
  const status: QuickCaptureStatus = {
    enabled,
    shortcut,
    registered: enabled && registeredShortcut === shortcut && !lastError,
  };
  if (lastError) status.error = lastError;
  return status;
}

/**
 * Apply the persisted settings: register/unregister the OS hotkey as needed
 * and report the resulting status (never throws).
 */
export async function syncQuickCaptureRegistration(): Promise<QuickCaptureStatus> {
  const settings = await readSettings();
  const enabled = settings.quickCaptureEnabled === true;
  const shortcut = resolveQuickCaptureAccelerator(settings.quickCaptureShortcut);

  if (!active) {
    return { enabled, shortcut, registered: false };
  }

  if (!enabled) {
    lastError = undefined;
    unregisterCurrent();
    return statusSnapshot(false, shortcut);
  }

  if (!isValidAcceleratorShape(shortcut)) {
    lastError = `${shortcut || "(empty)"} is not a usable shortcut combination. Open Settings → Quick Capture and record a different one.`;
    unregisterCurrent();
    return statusSnapshot(true, shortcut);
  }

  // Idempotent re-apply while healthy.
  if (registeredShortcut === shortcut && !lastError) {
    return statusSnapshot(true, shortcut);
  }

  unregisterCurrent();
  let ok = false;
  try {
    ok = active.ports.globalShortcut.register(shortcut, active.handler);
  } catch (error) {
    ok = false;
    lastError =
      error instanceof Error && error.message
        ? error.message
        : quickCaptureConflictMessage(shortcut);
  }
  if (!ok && !lastError) {
    lastError = quickCaptureConflictMessage(shortcut);
  }
  registeredShortcut = ok ? shortcut : null;
  if (ok) lastError = undefined;
  return statusSnapshot(true, shortcut);
}

/** Persist config then re-apply registration. */
export async function setQuickCaptureSettings(
  config: QuickCaptureConfig,
): Promise<QuickCaptureStatus> {
  const enabled = typeof config?.enabled === "boolean" ? config.enabled : false;
  const shortcut =
    typeof config?.shortcut === "string" && config.shortcut.trim().length > 0
      ? config.shortcut.trim()
      : null;
  await updateSettings((current) => ({
    ...current,
    quickCaptureEnabled: enabled,
    quickCaptureShortcut: shortcut,
  }));
  return syncQuickCaptureRegistration();
}

/** Current registration snapshot without mutating anything. */
export async function getQuickCaptureStatus(): Promise<QuickCaptureStatus> {
  const settings = await readSettings();
  const enabled = settings.quickCaptureEnabled === true;
  const shortcut = resolveQuickCaptureAccelerator(settings.quickCaptureShortcut);
  if (!enabled) {
    return { enabled: false, shortcut, registered: false };
  }
  if (!registeredShortcut && lastError) {
    return { enabled: true, shortcut, registered: false, error: lastError };
  }
  return statusSnapshot(enabled, shortcut);
}

/**
 * Global-shortcut callback: snapshot the clipboard into a capture event and
 * hand it to the focused (or freshly created) window. Clipboard contents are
 * never logged or persisted — they only travel to the renderer composer.
 */
export function invokeQuickCapture(): void {
  if (!active) return;
  const raw = safeReadClipboardText(active.ports);
  const { text, sourceType } = sanitizeCapturedText(raw ?? null);
  const payload: QuickCaptureEvent = { text, sourceType };
  void track("quick_capture_invoked", { source_type: sourceType });
  deliverQuickCapture(payload, {
    getWindow: active.ports.getWindow,
    createWindow: active.ports.createWindow,
    activateApp: active.ports.activateApp,
  });
}

function safeReadClipboardText(ports: QuickCapturePorts): string | null {
  try {
    const value = ports.readClipboardText();
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Tracks webContents that already have a deferred delivery listener. */
const pendingDeferredDeliveries = new WeakSet<object>();

function deliverNow(
  webContents: QuickCaptureWindow["webContents"],
  window: QuickCaptureWindow,
  payload: QuickCaptureEvent,
): void {
  pendingDeferredDeliveries.delete(webContents);
  if (window.isDestroyed()) return;
  webContents.send(IPC_CHANNELS.quickCapture, payload);
}

/**
 * Focus the target window and deliver the capture payload, deferring until
 * the page finishes loading when needed (fresh launch / reload).
 */
export function deliverQuickCapture(
  payload: QuickCaptureEvent,
  deps: {
    getWindow: () => QuickCaptureWindow | null | undefined;
    createWindow?: () => QuickCaptureWindow | null | undefined;
    activateApp?: () => void;
  },
): void {
  let window = deps.getWindow();
  if (!window || window.isDestroyed()) {
    const created = deps.createWindow?.();
    if (!created) return;
    window = created;
  }
  if (window.isDestroyed()) return;

  // Bring the app forward on every platform; restore first when minimized
  // (multiple displays included — focus lands wherever the window lives).
  if (window.isMinimized()) window.restore();
  deps.activateApp?.();
  window.show();
  window.focus();

  const { webContents } = window;
  const settle = () => {
    if (!pendingDeferredDeliveries.has(webContents)) return;
    deliverNow(webContents, window!, payload);
  };
  if (webContents.isLoading()) {
    if (pendingDeferredDeliveries.has(webContents)) return;
    pendingDeferredDeliveries.add(webContents);
    webContents.once("did-finish-load", settle);
    webContents.once("did-fail-load", settle);
    // TOCTOU: load may finish between isLoading() and listener registration.
    if (!window.isDestroyed() && !webContents.isLoading()) {
      settle();
    }
    return;
  }

  deliverNow(webContents, window, payload);
}

/** Release any held OS hotkey. Safe to call repeatedly / before ports exist. */
export function disposeQuickCapture(): void {
  unregisterCurrent();
  lastError = undefined;
}
