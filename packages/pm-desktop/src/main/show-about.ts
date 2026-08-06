/**
 * About-menu delivery helpers (injectable for unit tests).
 *
 * Defers `showAbout` until the target window finishes loading, with at most
 * one deferred delivery queued per webContents.
 */

import { IPC_CHANNELS } from "../shared/ipc-contract.ts";

/** Minimal window surface needed to deliver show-about. */
export interface ShowAboutWindow {
  isDestroyed(): boolean;
  webContents: {
    isLoading(): boolean;
    send(channel: string, ...args: unknown[]): void;
    once(event: "did-finish-load" | "did-fail-load", listener: () => void): void;
  };
}

export interface NotifyShowAboutDeps {
  getFocusedWindow: () => ShowAboutWindow | null;
  getAllWindows: () => ShowAboutWindow[];
  createWindow?: () => ShowAboutWindow;
}

/** Tracks webContents that already have a deferred deliver listener. */
const pendingDeferredShowAbout = new WeakSet<object>();

function deliverNow(window: ShowAboutWindow): void {
  pendingDeferredShowAbout.delete(window.webContents);
  if (!window.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.showAbout);
  }
}

/** Send show-about to a window, deferring until load completes if needed. */
export function sendShowAbout(window: ShowAboutWindow): void {
  const { webContents } = window;

  if (webContents.isLoading()) {
    if (pendingDeferredShowAbout.has(webContents)) {
      return;
    }
    pendingDeferredShowAbout.add(webContents);
    const onSettled = () => {
      // Skip if an immediate send already cleared the pending flag
      // (load finished between clicks before this listener ran).
      if (!pendingDeferredShowAbout.has(webContents)) {
        return;
      }
      deliverNow(window);
    };
    webContents.once("did-finish-load", onSettled);
    webContents.once("did-fail-load", onSettled);
    // TOCTOU: load may finish between isLoading() and listener registration.
    if (!window.isDestroyed() && !webContents.isLoading()) {
      deliverNow(window);
    }
    return;
  }

  deliverNow(window);
}

/** Send show-about to the focused window, or the first live window if none is focused. */
export function notifyShowAbout(deps: NotifyShowAboutDeps): void {
  const focused = deps.getFocusedWindow();
  let window =
    focused && !focused.isDestroyed()
      ? focused
      : deps.getAllWindows().find((candidate) => !candidate.isDestroyed());

  if (!window) {
    if (!deps.createWindow) return;
    window = deps.createWindow();
  }

  sendShowAbout(window);
}
