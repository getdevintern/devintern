/**
 * IPC handlers: thin adapters between the renderer and the pm engine.
 */

import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { EngineError, type EngineCallEvents } from "@getdevintern/pm/engine";
import {
  PmInitError,
  inspectPmInitContext,
  listPmTrackers,
  probePmConnection,
  writePmProjectConfig,
} from "@getdevintern/pm/init";
import {
  IPC_CHANNELS,
  type CreateTaskRequest,
  type DecomposeStoryRequest,
  type EditStoryRequest,
  type GenerateStoryRequest,
  type InitializeProjectRequest,
  type IpcResult,
  type SubtaskDraft,
  type SubtaskOutcome,
} from "../shared/ipc-contract.ts";
import { getAnalyticsEnabled, setAnalyticsEnabled, track } from "./analytics.ts";
import {
  getSession,
  loadProject,
  requireSession,
  switchProjectKey,
  switchTracker,
} from "./session.ts";
import { readSettings, updateSettings } from "./settings.ts";

function toIpcError(error: unknown): { code: string; message: string; detail?: string } {
  if (error instanceof PmInitError) {
    return { code: error.code, message: error.message };
  }
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

    void track("project_opened", { configured: status.configured });
    if (status.configured) {
      const session = getSession();
      if (session) {
        void track("project_configured", {
          tracker: session.config.backend.type,
          harness: session.config.agent.harness.name,
        });
      }
    }

    return status;
  });

  handle(IPC_CHANNELS.inspectProjectInit, async (_event, dir: string) => {
    const context = await inspectPmInitContext(dir);
    return { ...context, trackers: listPmTrackers() };
  });

  handle(
    IPC_CHANNELS.probeTrackerConnection,
    async (_event, trackerId: string, values: Record<string, string>) => {
      return probePmConnection(trackerId, values);
    },
  );

  handle(IPC_CHANNELS.initializeProject, async (_event, input: InitializeProjectRequest) => {
    await writePmProjectConfig({
      cwd: input.projectDir,
      trackerId: input.trackerId,
      values: input.values,
      overwrite: input.overwrite === true,
    });
    const status = await loadProject(input.projectDir);
    await updateSettings({ lastProjectDir: input.projectDir });
    if (!status.configured) {
      throw new Error(
        status.configError ?? "Configuration was written but the project could not be loaded.",
      );
    }
    return status;
  });

  handle(IPC_CHANNELS.listIssueTypes, async (_event, projectKey?: string) => {
    return requireSession().engine.listIssueTypes(projectKey);
  });

  handle(
    IPC_CHANNELS.generateStory,
    async (event, requestId: string, input: GenerateStoryRequest) => {
      try {
        const draft = await requireSession().engine.generateStory(
          input,
          chunkEvents(event, requestId),
        );
        void track("story_generated", { source_type: input.source.type, ok: true });
        return draft;
      } catch (error) {
        void track("story_generated", { source_type: input.source.type, ok: false });
        throw error;
      }
    },
  );

  handle(IPC_CHANNELS.editStory, async (event, requestId: string, input: EditStoryRequest) => {
    try {
      const draft = await requireSession().engine.editStory(input, chunkEvents(event, requestId));
      void track("story_edited", { ok: true });
      return draft;
    } catch (error) {
      void track("story_edited", { ok: false });
      throw error;
    }
  });

  handle(
    IPC_CHANNELS.decomposeStory,
    async (event, requestId: string, input: DecomposeStoryRequest) => {
      try {
        const subtasks = await requireSession().engine.decomposeStory(
          input,
          chunkEvents(event, requestId),
        );
        void track("story_decomposed", { ok: true });
        return subtasks;
      } catch (error) {
        void track("story_decomposed", { ok: false });
        throw error;
      }
    },
  );

  handle(IPC_CHANNELS.createTask, async (_event, input: CreateTaskRequest) => {
    try {
      const result = await requireSession().engine.createTask(input.draft, {
        issueType: input.issueType,
        projectKey: input.projectKey,
        epicKey: input.epicKey,
      });
      void track("task_created", {
        ok: true,
        epic_linked: result.epicLinked,
      });
      return {
        key: result.task.key,
        url: result.task.url,
        epicLinked: result.epicLinked,
        epicLinkError: result.epicLinkError,
      };
    } catch (error) {
      void track("task_created", { ok: false });
      throw error;
    }
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

  handle(IPC_CHANNELS.getAppVersion, async () => {
    // Packaged builds: version from app metadata / package.json.
    // Dev runs: same package.json version via Electron's default resolution.
    return app.getVersion();
  });

  handle(IPC_CHANNELS.isCodeDiscoveryDismissed, async () => {
    const settings = await readSettings();
    return settings.codeDiscoveryDismissed === true;
  });

  handle(IPC_CHANNELS.dismissCodeDiscovery, async () => {
    await updateSettings({ codeDiscoveryDismissed: true });
    return null;
  });

  handle(IPC_CHANNELS.getAnalyticsEnabled, async () => {
    return getAnalyticsEnabled();
  });

  handle(IPC_CHANNELS.setAnalyticsEnabled, async (_event, enabled: boolean) => {
    await setAnalyticsEnabled(enabled);
    return null;
  });

  handle(IPC_CHANNELS.switchTracker, async (_event, trackerId: string) => {
    // Works even when the current tracker failed to load, so the user can
    // switch to another fully configured tracker without re-running setup.
    return switchTracker(trackerId);
  });

  handle(IPC_CHANNELS.switchProjectKey, async (_event, projectKey: string) => {
    return switchProjectKey(projectKey);
  });
}
