/**
 * Preload: exposes the typed PM API on `window.pm` via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type AgentChunkEvent, type PmDesktopApi } from "../shared/ipc-contract.ts";
import { createShowAboutLatch } from "./show-about-latch.ts";

const showAboutLatch = createShowAboutLatch();

// Capture early show-about events that arrive before any renderer subscriber.
ipcRenderer.on(IPC_CHANNELS.showAbout, () => {
  showAboutLatch.noteEvent();
});

const api: PmDesktopApi = {
  chooseProjectDir: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProjectDir),
  getProjectStatus: (dir) => ipcRenderer.invoke(IPC_CHANNELS.getProjectStatus, dir),
  getLastProjectDir: () => ipcRenderer.invoke(IPC_CHANNELS.getLastProjectDir),
  listIssueTypes: (projectKey) => ipcRenderer.invoke(IPC_CHANNELS.listIssueTypes, projectKey),
  inspectProjectInit: (dir) => ipcRenderer.invoke(IPC_CHANNELS.inspectProjectInit, dir),
  probeTrackerConnection: (trackerId, values) =>
    ipcRenderer.invoke(IPC_CHANNELS.probeTrackerConnection, trackerId, values),
  initializeProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.initializeProject, input),
  generateStory: (requestId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateStory, requestId, input),
  editStory: (requestId, input) => ipcRenderer.invoke(IPC_CHANNELS.editStory, requestId, input),
  decomposeStory: (requestId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.decomposeStory, requestId, input),
  createTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTask, input),
  createSubtasks: (parentKey, subtasks, projectKey) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSubtasks, parentKey, subtasks, projectKey),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.getAppVersion),
  isCodeDiscoveryDismissed: () => ipcRenderer.invoke(IPC_CHANNELS.isCodeDiscoveryDismissed),
  dismissCodeDiscovery: () => ipcRenderer.invoke(IPC_CHANNELS.dismissCodeDiscovery),
  getAnalyticsEnabled: () => ipcRenderer.invoke(IPC_CHANNELS.getAnalyticsEnabled),
  setAnalyticsEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.setAnalyticsEnabled, enabled),
  switchTracker: (trackerId) => ipcRenderer.invoke(IPC_CHANNELS.switchTracker, trackerId),
  switchProjectKey: (projectKey) => ipcRenderer.invoke(IPC_CHANNELS.switchProjectKey, projectKey),
  onAgentChunk: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentChunkEvent) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.agentChunk, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentChunk, listener);
  },
  onShowAbout: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.showAbout, listener);
    const unsubscribeLatch = showAboutLatch.subscribe(callback);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.showAbout, listener);
      unsubscribeLatch();
    };
  },
};

contextBridge.exposeInMainWorld("pm", api);
