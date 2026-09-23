import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import {
  checkForUpdates,
  dismissUpdateError,
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
  snoozeUpdate,
  subscribeUpdateStatus,
} from "../auto-update.ts";
import { handle } from "./register.ts";

/** Auto-update IPC handlers plus the status broadcast subscription. */
export function registerUpdateIpcHandlers(): void {
  handle(IPC_CHANNELS.getUpdateStatus, async () => getUpdateStatus());

  handle(IPC_CHANNELS.checkForUpdates, async () => checkForUpdates({ silent: false }));

  handle(IPC_CHANNELS.downloadUpdate, async () => downloadUpdate());

  handle(IPC_CHANNELS.installUpdate, async () => installUpdate());

  handle(IPC_CHANNELS.snoozeUpdate, async () => snoozeUpdate());

  handle(IPC_CHANNELS.dismissUpdateError, async () => dismissUpdateError());

  // Push status changes to all renderer windows (progress, available, errors).
  subscribeUpdateStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.updateStatus, status);
      }
    }
  });
}
