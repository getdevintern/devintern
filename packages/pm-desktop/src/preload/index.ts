/**
 * Preload: exposes the typed PM API on `window.pm` via contextBridge.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import { basename } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc-contract.ts";
import type {
  AgentChunkEvent,
  AttachmentRef,
  GitHubOAuthPrompt,
  PmDesktopApi,
  UpdateStatus,
} from "../shared/ipc-contract.ts";
import { createShowAboutLatch } from "./show-about-latch.ts";

const showAboutLatch = createShowAboutLatch();

// Capture early show-about events that arrive before any renderer subscriber.
ipcRenderer.on(IPC_CHANNELS.showAbout, () => {
  showAboutLatch.noteEvent();
});

const api: PmDesktopApi = {
  chooseProjectDir: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProjectDir),
  chooseAttachmentFiles: () => ipcRenderer.invoke(IPC_CHANNELS.chooseAttachmentFiles),
  saveClipboardImage: () => ipcRenderer.invoke(IPC_CHANNELS.saveClipboardImage),
  resolveDroppedFiles: (files) => {
    const refs: AttachmentRef[] = [];
    for (const file of files) {
      try {
        const path = webUtils.getPathForFile(file);
        if (path) {
          refs.push({ path, name: file.name || basename(path) });
        }
      } catch {
        // Skip files without a resolvable path (e.g. browser-only blobs).
      }
    }
    return refs;
  },
  getProjectStatus: (dir) => ipcRenderer.invoke(IPC_CHANNELS.getProjectStatus, dir),
  getLastProjectDir: () => ipcRenderer.invoke(IPC_CHANNELS.getLastProjectDir),
  validateRequiredTools: () => ipcRenderer.invoke(IPC_CHANNELS.validateRequiredTools),
  getRecentProjectDirs: () => ipcRenderer.invoke(IPC_CHANNELS.getRecentProjectDirs),
  connectGitHubRepo: (input) => ipcRenderer.invoke(IPC_CHANNELS.connectGitHubRepo, input),
  getGitHubAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getGitHubAuthStatus),
  setGitHubToken: (token) => ipcRenderer.invoke(IPC_CHANNELS.setGitHubToken, token),
  clearGitHubToken: () => ipcRenderer.invoke(IPC_CHANNELS.clearGitHubToken),
  isGitHubOAuthAvailable: () => ipcRenderer.invoke(IPC_CHANNELS.isGitHubOAuthAvailable),
  startGitHubOAuth: () => ipcRenderer.invoke(IPC_CHANNELS.startGitHubOAuth),
  cancelGitHubOAuth: () => ipcRenderer.invoke(IPC_CHANNELS.cancelGitHubOAuth),
  onGitHubOAuthPrompt: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GitHubOAuthPrompt) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.githubOAuthPrompt, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.githubOAuthPrompt, listener);
  },
  listGitHubRepos: () => ipcRenderer.invoke(IPC_CHANNELS.listGitHubRepos),
  revealProjectInFolder: (dir) => ipcRenderer.invoke(IPC_CHANNELS.revealProjectInFolder, dir),
  removeConnectedProject: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeConnectedProject, options),
  listIssueTypes: (projectKey) => ipcRenderer.invoke(IPC_CHANNELS.listIssueTypes, projectKey),
  listLabels: (projectKey) => ipcRenderer.invoke(IPC_CHANNELS.listLabels, projectKey),
  inspectProjectInit: (dir) => ipcRenderer.invoke(IPC_CHANNELS.inspectProjectInit, dir),
  probeTrackerConnection: (trackerId, values) =>
    ipcRenderer.invoke(IPC_CHANNELS.probeTrackerConnection, trackerId, values),
  initializeProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.initializeProject, input),
  updateProjectTracker: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateProjectTracker, input),
  generateStory: (requestId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateStory, requestId, input),
  editStory: (requestId, input) => ipcRenderer.invoke(IPC_CHANNELS.editStory, requestId, input),
  decomposeStory: (requestId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.decomposeStory, requestId, input),
  createTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTask, input),
  createSubtasks: (parentKey, subtasks, projectKey) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSubtasks, parentKey, subtasks, projectKey),
  beginAgentRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.beginAgentRequest, requestId),
  endAgentRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.endAgentRequest, requestId),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.getAppVersion),
  isCodeDiscoveryDismissed: () => ipcRenderer.invoke(IPC_CHANNELS.isCodeDiscoveryDismissed),
  dismissCodeDiscovery: () => ipcRenderer.invoke(IPC_CHANNELS.dismissCodeDiscovery),
  getAnalyticsEnabled: () => ipcRenderer.invoke(IPC_CHANNELS.getAnalyticsEnabled),
  setAnalyticsEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.setAnalyticsEnabled, enabled),
  switchTracker: (trackerId) => ipcRenderer.invoke(IPC_CHANNELS.switchTracker, trackerId),
  switchProjectKey: (projectKey) => ipcRenderer.invoke(IPC_CHANNELS.switchProjectKey, projectKey),
  switchHarness: (harnessName) => ipcRenderer.invoke(IPC_CHANNELS.switchHarness, harnessName),
  switchModel: (model) => ipcRenderer.invoke(IPC_CHANNELS.switchModel, model),
  updateProjectFromRemote: () => ipcRenderer.invoke(IPC_CHANNELS.updateProjectFromRemote),
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
  getUpdateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateStatus),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate),
  snoozeUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.snoozeUpdate),
  dismissUpdateError: () => ipcRenderer.invoke(IPC_CHANNELS.dismissUpdateError),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateStatus) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.updateStatus, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStatus, listener);
  },
};

contextBridge.exposeInMainWorld("pm", api);
