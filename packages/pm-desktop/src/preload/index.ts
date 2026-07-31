/**
 * Preload: exposes the typed PM API on `window.pm` via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type AgentChunkEvent, type PmDesktopApi } from "../shared/ipc-contract.ts";

const api: PmDesktopApi = {
  chooseProjectDir: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProjectDir),
  getProjectStatus: (dir) => ipcRenderer.invoke(IPC_CHANNELS.getProjectStatus, dir),
  getLastProjectDir: () => ipcRenderer.invoke(IPC_CHANNELS.getLastProjectDir),
  listIssueTypes: (projectKey) => ipcRenderer.invoke(IPC_CHANNELS.listIssueTypes, projectKey),
  generateStory: (requestId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateStory, requestId, input),
  editStory: (requestId, input) => ipcRenderer.invoke(IPC_CHANNELS.editStory, requestId, input),
  decomposeStory: (requestId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.decomposeStory, requestId, input),
  createTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTask, input),
  createSubtasks: (parentKey, subtasks, projectKey) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSubtasks, parentKey, subtasks, projectKey),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  onAgentChunk: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentChunkEvent) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.agentChunk, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentChunk, listener);
  },
};

contextBridge.exposeInMainWorld("pm", api);
