/**
 * IPC handlers: thin adapters between the renderer and the pm engine.
 */

import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { EngineError, type EngineCallEvents } from "@getdevintern/pm/engine";
import {
  IPC_CHANNELS,
  type CreateTaskRequest,
  type DecomposeStoryRequest,
  type EditStoryRequest,
  type GenerateStoryRequest,
  type IpcResult,
  type SubtaskDraft,
  type SubtaskOutcome,
} from "../shared/ipc-contract.ts";
import { loadProject, requireSession } from "./session.ts";
import { readSettings, updateSettings } from "./settings.ts";

function toIpcError(error: unknown): { code: string; message: string; detail?: string } {
  if (error instanceof EngineError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  if (error instanceof Error) {
    return { code: "error", message: error.message };
  }
  return { code: "error", message: String(error) };
}

/** Wrap a handler so failures come back as a typed envelope, never a rejection. */
function handle<A extends unknown[], T>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: A) => Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await handler(event, ...(args as A)) };
    } catch (error) {
      return { ok: false, error: toIpcError(error) };
    }
  });
}

/** Per-request streaming bridge: engine chunks → renderer push events. */
function chunkEvents(event: Electron.IpcMainInvokeEvent, requestId: string): EngineCallEvents {
  return {
    onAgentChunk: (chunk, stream) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.agentChunk, { requestId, stream, chunk });
      }
    },
  };
}

export function registerIpcHandlers(): void {
  handle(IPC_CHANNELS.chooseProjectDir, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window!, {
      title: "Choose a project directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  handle(IPC_CHANNELS.getLastProjectDir, async () => {
    const settings = await readSettings();
    return settings.lastProjectDir ?? null;
  });

  handle(IPC_CHANNELS.getProjectStatus, async (_event, dir: string) => {
    const status = await loadProject(dir);
    await updateSettings({ lastProjectDir: dir });
    return status;
  });

  handle(IPC_CHANNELS.listIssueTypes, async (_event, projectKey?: string) => {
    return requireSession().engine.listIssueTypes(projectKey);
  });

  handle(
    IPC_CHANNELS.generateStory,
    async (event, requestId: string, input: GenerateStoryRequest) => {
      return requireSession().engine.generateStory(input, chunkEvents(event, requestId));
    },
  );

  handle(IPC_CHANNELS.editStory, async (event, requestId: string, input: EditStoryRequest) => {
    return requireSession().engine.editStory(input, chunkEvents(event, requestId));
  });

  handle(
    IPC_CHANNELS.decomposeStory,
    async (event, requestId: string, input: DecomposeStoryRequest) => {
      return requireSession().engine.decomposeStory(input, chunkEvents(event, requestId));
    },
  );

  handle(IPC_CHANNELS.createTask, async (_event, input: CreateTaskRequest) => {
    const result = await requireSession().engine.createTask(input.draft, {
      issueType: input.issueType,
      projectKey: input.projectKey,
      epicKey: input.epicKey,
    });
    return {
      key: result.task.key,
      url: result.task.url,
      epicLinked: result.epicLinked,
      epicLinkError: result.epicLinkError,
    };
  });

  handle(
    IPC_CHANNELS.createSubtasks,
    async (_event, parentKey: string, subtasks: SubtaskDraft[], projectKey?: string) => {
      const session = requireSession();
      const outcomes: SubtaskOutcome[] = [];
      for (const subtask of subtasks) {
        try {
          const created = await session.engine.createSubtask(parentKey, subtask, projectKey);
          outcomes.push({ subtask, key: created.key, url: created.url });
        } catch (error) {
          outcomes.push({
            subtask,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return outcomes;
    },
  );

  handle(IPC_CHANNELS.openExternal, async (_event, url: string) => {
    if (!/^https?:\/\//.test(url) && !url.startsWith("file://")) {
      throw new Error("Only http(s) and file URLs can be opened externally.");
    }
    await shell.openExternal(url);
    return null;
  });
}
