/**
 * IPC handlers: thin adapters between the renderer and the pm engine.
 *
 * Domain handlers live under `./ipc/`; this module wires them together so
 * `main/index.ts` keeps a single `registerIpcHandlers` entry point.
 */

import type { BrowserWindow } from "electron";
import { registerAgentIpcHandlers } from "./ipc/agent.ts";
import { registerAppIpcHandlers } from "./ipc/app.ts";
import { registerDialogIpcHandlers } from "./ipc/dialogs.ts";
import { registerGitHubIpcHandlers } from "./ipc/github.ts";
import { registerProjectIpcHandlers } from "./ipc/projects.ts";
import { registerQuickCaptureIpcHandlers } from "./ipc/quick-capture-ipc.ts";
import { registerUpdateIpcHandlers } from "./ipc/updates.ts";

export function registerIpcHandlers(options?: {
  /** Window factory for Quick Capture when no live window exists yet. */
  createWindow?: () => BrowserWindow;
}): void {
  registerQuickCaptureIpcHandlers(options);
  registerDialogIpcHandlers();
  registerGitHubIpcHandlers();
  registerProjectIpcHandlers();
  registerAgentIpcHandlers();
  registerAppIpcHandlers();
  registerUpdateIpcHandlers();
}
