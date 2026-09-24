import { BrowserWindow, app, clipboard, globalShortcut } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import type { QuickCaptureConfig } from "../../shared/ipc-contract.ts";
import {
  getQuickCaptureStatus,
  initQuickCapture,
  setQuickCaptureSettings,
} from "../quick-capture.ts";
import { handle } from "./register.ts";

/** Quick Capture status/settings handlers and shortcut port wiring. */
export function registerQuickCaptureIpcHandlers(options?: {
  /** Window factory for Quick Capture when no live window exists yet. */
  createWindow?: () => BrowserWindow;
}): void {
  // Quick Capture ports: the global shortcut may fire while no window exists
  // (macOS background, closed window), so main owns creation + focus.
  initQuickCapture({
    globalShortcut,
    readClipboardText: () => clipboard.readText(),
    getWindow: () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()),
    createWindow: options?.createWindow,
    activateApp: () => app.focus({ steal: true }),
  });

  handle(IPC_CHANNELS.getQuickCaptureStatus, async () => {
    return getQuickCaptureStatus();
  });

  handle(IPC_CHANNELS.setQuickCaptureSettings, async (_event, config: QuickCaptureConfig) => {
    if (!config || typeof config !== "object") {
      throw Object.assign(new Error("Invalid Quick Capture settings."), { code: "invalid_input" });
    }
    if (typeof config.enabled !== "boolean") {
      throw Object.assign(new Error("Invalid Quick Capture settings."), { code: "invalid_input" });
    }
    return setQuickCaptureSettings(config);
  });
}
