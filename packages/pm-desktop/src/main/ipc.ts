/**
 * IPC handlers: thin adapters between the renderer and the pm engine.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BrowserWindow, app, clipboard, dialog, globalShortcut, ipcMain, shell } from "electron";
import { MAX_ATTACHMENTS, attachmentExtensionError } from "@getdevintern/pm/attachments";
import { EngineError } from "@getdevintern/pm/engine";
import type { EngineCallEvents } from "@getdevintern/pm/engine";
import {
  PmInitError,
  inspectPmInitContext,
  listPmTrackers,
  probePmConnection,
  writePmProjectConfig,
} from "@getdevintern/pm/init";
import { IPC_CHANNELS } from "../shared/ipc-contract.ts";
import type {
  ConnectGitHubRepoRequest,
  CreateTaskRequest,
  DecomposeStoryRequest,
  EditStoryRequest,
  GenerateStoryRequest,
  InitializeProjectRequest,
  IpcResult,
  QuickCaptureConfig,
  SubtaskDraft,
  SubtaskOutcome,
  UpdateProjectTrackerRequest,
} from "../shared/ipc-contract.ts";
import { getAnalyticsEnabled, setAnalyticsEnabled, track } from "./analytics.ts";
import { toEngineCreateTaskOptions } from "./create-task-options.ts";
import {
  checkForUpdates,
  dismissUpdateError,
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
  snoozeUpdate,
  subscribeUpdateStatus,
} from "./auto-update.ts";
import { listGitHubRepos, validateGitHubToken } from "./github-api.ts";
import {
  clearGitHubToken,
  getGitHubAuthStatus,
  getGitHubToken,
  setGitHubToken,
} from "./github-auth.ts";
import { isGitHubOAuthAvailable, runDeviceFlow } from "./github-oauth.ts";
import { connectManagedGitHubRepo } from "./managed-clone.ts";
import { listProjectBindings } from "./project-bindings.ts";
import { persistTrackerCredentials, readProjectEnv } from "./project-env.ts";
import { removeConnectedProject } from "./remove-connected-project.ts";
import {
  getQuickCaptureStatus,
  initQuickCapture,
  setQuickCaptureSettings,
} from "./quick-capture.ts";
import {
  beginAgentRequest,
  detectGitRepository,
  endAgentRequest,
  getSession,
  loadProject,
  requireSession,
  switchContext,
  switchHarness,
  switchModel,
  switchProjectKey,
  switchTracker,
  updateProjectFromRemote,
} from "./session.ts";
import { listRecentProjectDirs, recordRecentProjectDir } from "./recent-projects.ts";
import { readSettings, updateSettings } from "./settings.ts";
import { validateRequiredTools } from "./validate-tools.ts";

/** Reveal only known project dirs (bindings, recents, current session) — not arbitrary paths. */
async function isAllowedRevealPath(resolved: string): Promise<boolean> {
  const session = getSession();
  if (session && resolve(session.projectDir) === resolved) return true;

  const settings = await readSettings();
  if (settings.lastProjectDir && resolve(settings.lastProjectDir) === resolved) return true;
  for (const dir of settings.recentProjectDirs ?? []) {
    if (resolve(dir) === resolved) return true;
  }

  const bindings = await listProjectBindings();
  return bindings.some((b) => resolve(b.localPath) === resolved);
}

/** AbortController for the in-flight OAuth device flow, if any. */
let oauthAbort: AbortController | null = null;

function toIpcError(error: unknown): { code: string; message: string; detail?: string } {
  if (error instanceof PmInitError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof EngineError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  if (error instanceof Error) {
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "error";
    return { code, message: error.message };
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

/** Run an agent IPC call while marking its request id as in flight. */
async function withAgentRequest<T>(requestId: string, run: () => Promise<T>): Promise<T> {
  beginAgentRequest(requestId);
  try {
    return await run();
  } finally {
    endAgentRequest(requestId);
  }
}

export function registerIpcHandlers(options?: {
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

  handle(IPC_CHANNELS.chooseProjectDir, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    // Electron 43+ opens Downloads when defaultPath is omitted; seed from
    // lastProjectDir (updated on successful open in getProjectStatus / initializeProject).
    const settings = await readSettings();
    const result = await dialog.showOpenDialog(window!, {
      title: "Open existing project folder",
      defaultPath: settings.lastProjectDir ?? undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  handle(IPC_CHANNELS.chooseAttachmentFiles, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window!, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Supported attachments",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
            "txt",
            "md",
            "markdown",
            "csv",
            "tsv",
            "json",
            "yaml",
            "yml",
            "xml",
            "html",
            "log",
            "pdf",
            "ipynb",
          ],
        },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        {
          name: "Documents",
          extensions: ["txt", "md", "markdown", "csv", "json", "yaml", "yml", "pdf"],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    const refs = [];
    for (const filePath of result.filePaths.slice(0, MAX_ATTACHMENTS)) {
      const name = basename(filePath);
      const extError = attachmentExtensionError(name);
      if (extError) {
        throw new Error(`${name}: ${extError}`);
      }
      refs.push({ path: filePath, name });
    }
    return refs;
  });

  handle(IPC_CHANNELS.saveClipboardImage, async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return null;
    }
    const dir = mkdtempSync(join(tmpdir(), "devpm-clipboard-"));
    const name = `screenshot-${Date.now()}.png`;
    const filePath = join(dir, name);
    writeFileSync(filePath, image.toPNG());
    return { path: filePath, name };
  });

  handle(IPC_CHANNELS.getLastProjectDir, async () => {
    const settings = await readSettings();
    return settings.lastProjectDir ?? null;
  });

  handle(IPC_CHANNELS.validateRequiredTools, async () => {
    const settings = await readSettings();
    let agentEnv: Record<string, string> = {};
    if (settings.lastProjectDir) {
      try {
        const { env } = await readProjectEnv(settings.lastProjectDir);
        agentEnv = Object.fromEntries(
          Object.entries(env).filter(
            ([key]) =>
              key === "AGENT_HARNESS" || key === "AGENT_CLI_PATH" || key.endsWith("_CLI_PATH"),
          ),
        );
      } catch {
        // A stale/unreadable remembered project must not hide process-level tools.
      }
    }
    return validateRequiredTools({ envOverrides: agentEnv });
  });

  handle(IPC_CHANNELS.getRecentProjectDirs, async () => {
    return listRecentProjectDirs();
  });

  handle(IPC_CHANNELS.connectGitHubRepo, async (_event, input: ConnectGitHubRepoRequest) => {
    if (!input || typeof input !== "object") {
      throw Object.assign(new Error("Enter a GitHub repository as owner/repo."), {
        code: "invalid_input",
      });
    }
    if (typeof input.repoInput !== "string" || input.repoInput.trim().length === 0) {
      throw Object.assign(new Error("Enter a GitHub repository as owner/repo."), {
        code: "invalid_input",
      });
    }
    const branch =
      typeof input.branch === "string" && input.branch.trim().length > 0
        ? input.branch.trim()
        : undefined;
    const binding = await connectManagedGitHubRepo({
      repoInput: input.repoInput.trim(),
      branch,
    });
    const status = await loadProject(binding.localPath);
    await updateSettings({ lastProjectDir: status.projectDir });
    await recordRecentProjectDir(status.projectDir);
    void track("project_opened", { configured: status.configured });
    return status;
  });

  handle(IPC_CHANNELS.getGitHubAuthStatus, async () => {
    return getGitHubAuthStatus();
  });

  handle(IPC_CHANNELS.setGitHubToken, async (_event, token: string) => {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw Object.assign(new Error("Paste a GitHub personal access token."), {
        code: "auth_required",
      });
    }
    const trimmed = token.trim();
    const validated = await validateGitHubToken(trimmed);
    if (!validated.ok) {
      throw Object.assign(new Error(validated.message), { code: "auth_required" });
    }
    await setGitHubToken(trimmed);
    const status = await getGitHubAuthStatus();
    return { ...status, login: validated.login };
  });

  handle(IPC_CHANNELS.clearGitHubToken, async () => {
    await clearGitHubToken();
    return null;
  });

  handle(IPC_CHANNELS.isGitHubOAuthAvailable, async () => {
    return isGitHubOAuthAvailable();
  });

  handle(IPC_CHANNELS.startGitHubOAuth, async () => {
    if (oauthAbort) {
      throw Object.assign(new Error("A sign-in is already in progress."), {
        code: "in_progress",
      });
    }
    oauthAbort = new AbortController();
    try {
      await runDeviceFlow({
        signal: oauthAbort.signal,
        onPrompt: (prompt) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.githubOAuthPrompt, prompt);
            }
          }
        },
      });
    } finally {
      oauthAbort = null;
    }
    return getGitHubAuthStatus();
  });

  handle(IPC_CHANNELS.cancelGitHubOAuth, async () => {
    oauthAbort?.abort();
    return null;
  });

  handle(IPC_CHANNELS.listGitHubRepos, async () => {
    const token = await getGitHubToken();
    return listGitHubRepos(token);
  });

  handle(IPC_CHANNELS.revealProjectInFolder, async (_event, dir: unknown) => {
    if (typeof dir !== "string" || dir.trim().length === 0) {
      throw Object.assign(new Error("Invalid project folder."), { code: "invalid_input" });
    }
    const resolved = resolve(dir);
    if (!(await isAllowedRevealPath(resolved))) {
      throw new Error("Can only reveal a known project folder.");
    }
    shell.showItemInFolder(resolved);
    return null;
  });

  handle(IPC_CHANNELS.removeConnectedProject, async (_event, options: unknown) => {
    if (!options || typeof options !== "object") {
      throw Object.assign(new Error("Invalid remove project request."), {
        code: "invalid_input",
      });
    }
    const { localPath, deleteFiles } = options as {
      localPath?: unknown;
      deleteFiles?: unknown;
    };
    if (typeof localPath !== "string" || typeof deleteFiles !== "boolean") {
      throw Object.assign(new Error("Invalid remove project request."), {
        code: "invalid_input",
      });
    }
    await removeConnectedProject({ localPath, deleteFiles });
    return null;
  });

  handle(IPC_CHANNELS.getProjectStatus, async (_event, dir: string) => {
    const status = await loadProject(dir);
    await updateSettings({ lastProjectDir: status.projectDir });
    // Only PM-ready folders (git + .devintern-pm) join the recent menu.
    await recordRecentProjectDir(status.projectDir);

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
    const { env } = await readProjectEnv(dir);
    return { ...context, trackers: listPmTrackers(), currentEnv: env };
  });

  handle(
    IPC_CHANNELS.probeTrackerConnection,
    async (_event, trackerId: string, values: Record<string, string>) => {
      return probePmConnection(trackerId, values);
    },
  );

  handle(IPC_CHANNELS.initializeProject, async (_event, input: InitializeProjectRequest) => {
    // Match loadProject's git gate so we never persist credentials for unsuitable folders.
    if (!detectGitRepository(input.projectDir)) {
      throw new Error(
        "This folder is not a git repository. Choose a git-connected project before setting up PM.",
      );
    }
    await writePmProjectConfig({
      cwd: input.projectDir,
      trackerId: input.trackerId,
      values: input.values,
      overwrite: input.overwrite === true,
    });
    const status = await loadProject(input.projectDir);
    await updateSettings({ lastProjectDir: status.projectDir });
    // Setup writes `.devintern-pm`, so the project is now eligible for recents.
    await recordRecentProjectDir(status.projectDir);
    if (!status.configured) {
      throw new Error(
        status.configError ?? "Configuration was written but the project could not be loaded.",
      );
    }
    return status;
  });

  handle(IPC_CHANNELS.updateProjectTracker, async (_event, input: UpdateProjectTrackerRequest) => {
    if (!input || typeof input !== "object") {
      throw Object.assign(new Error("Invalid update tracker request."), { code: "invalid_input" });
    }
    if (typeof input.projectDir !== "string" || typeof input.trackerId !== "string") {
      throw Object.assign(new Error("Invalid update tracker request."), { code: "invalid_input" });
    }
    if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
      throw Object.assign(new Error("Invalid update tracker request."), { code: "invalid_input" });
    }
    // Match initializeProject's git gate so we never persist credentials for
    // unsuitable folders.
    if (!detectGitRepository(input.projectDir)) {
      throw new Error(
        "This folder is not a git repository. Choose a git-connected project before updating PM.",
      );
    }
    // Hold the context-switch mutex so an agent IPC cannot interleave after the
    // env is rewritten but before the new session is ready (same contract as
    // switchTracker / switchHarness).
    return switchContext(async (projectDir) => {
      if (resolve(projectDir) !== resolve(input.projectDir)) {
        throw new Error("Project directory does not match the active session.");
      }
      await persistTrackerCredentials(projectDir, input.trackerId, input.values);
    });
  });

  handle(IPC_CHANNELS.listIssueTypes, async (_event, projectKey?: string) => {
    return requireSession().engine.listIssueTypes(projectKey);
  });

  handle(IPC_CHANNELS.listLabels, async (_event, projectKey?: string) => {
    return requireSession().engine.listLabels(projectKey);
  });

  handle(
    IPC_CHANNELS.generateStory,
    async (event, requestId: string, input: GenerateStoryRequest) => {
      return withAgentRequest(requestId, async () => {
        try {
          const draft = await requireSession().engine.generateStory(
            input,
            chunkEvents(event, requestId),
          );
          void track("story_generated", {
            source_type: input.source.type,
            ok: true,
            attachment_count: input.attachments?.length ?? 0,
            has_images: Boolean(
              input.attachments?.some((a) => /\.(png|jpe?g|webp|gif)$/i.test(a.name)),
            ),
          });
          return draft;
        } catch (error) {
          void track("story_generated", {
            source_type: input.source.type,
            ok: false,
            attachment_count: input.attachments?.length ?? 0,
          });
          throw error;
        }
      });
    },
  );

  handle(IPC_CHANNELS.editStory, async (event, requestId: string, input: EditStoryRequest) => {
    return withAgentRequest(requestId, async () => {
      try {
        const draft = await requireSession().engine.editStory(input, chunkEvents(event, requestId));
        void track("story_edited", { ok: true });
        return draft;
      } catch (error) {
        void track("story_edited", { ok: false });
        throw error;
      }
    });
  });

  handle(
    IPC_CHANNELS.decomposeStory,
    async (event, requestId: string, input: DecomposeStoryRequest) => {
      return withAgentRequest(requestId, async () => {
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
      });
    },
  );

  handle(IPC_CHANNELS.createTask, async (_event, input: CreateTaskRequest) => {
    // Non-streaming, but still holds the session engine — guard like generate/edit.
    return withAgentRequest(`create-task:${randomUUID()}`, async () => {
      try {
        // Never forward labelsPrevalidated — Jira/GitHub apply can auto-create
        // names; main always re-validates against getLabels.
        const result = await requireSession().engine.createTask(
          input.draft,
          toEngineCreateTaskOptions(input),
        );
        void track("task_created", {
          ok: true,
          epic_linked: result.epicLinked,
          labels_applied: result.labelsApplied,
          attachments_uploaded: result.attachmentsUploaded,
          attachment_errors: result.attachmentErrors?.length ?? 0,
        });
        return {
          key: result.task.key,
          url: result.task.url,
          epicLinked: result.epicLinked,
          epicLinkError: result.epicLinkError,
          labelsApplied: result.labelsApplied,
          labelsApplyError: result.labelsApplyError,
          attachmentsUploaded: result.attachmentsUploaded,
          attachmentErrors: result.attachmentErrors,
        };
      } catch (error) {
        void track("task_created", { ok: false });
        throw error;
      }
    });
  });

  handle(
    IPC_CHANNELS.createSubtasks,
    async (_event, parentKey: string, subtasks: SubtaskDraft[], projectKey?: string) => {
      // Non-streaming, but still holds the session engine — guard like generate/edit.
      return withAgentRequest(`create-subtasks:${randomUUID()}`, async () => {
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
      });
    },
  );

  handle(IPC_CHANNELS.beginAgentRequest, async (_event, requestId: string) => {
    beginAgentRequest(requestId);
    return null;
  });

  handle(IPC_CHANNELS.endAgentRequest, async (_event, requestId: string) => {
    endAgentRequest(requestId);
    return null;
  });

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

  handle(IPC_CHANNELS.switchHarness, async (_event, harnessName: string) => {
    return switchHarness(harnessName);
  });

  handle(IPC_CHANNELS.switchModel, async (_event, model: string) => {
    return switchModel(model);
  });

  handle(IPC_CHANNELS.updateProjectFromRemote, async () => {
    return updateProjectFromRemote();
  });

  handle(IPC_CHANNELS.getUpdateStatus, async () => getUpdateStatus());

  handle(IPC_CHANNELS.checkForUpdates, async () => checkForUpdates({ silent: false }));

  handle(IPC_CHANNELS.downloadUpdate, async () => downloadUpdate());

  handle(IPC_CHANNELS.installUpdate, async () => installUpdate());

  handle(IPC_CHANNELS.snoozeUpdate, async () => snoozeUpdate());

  handle(IPC_CHANNELS.dismissUpdateError, async () => dismissUpdateError());

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

  // Push status changes to all renderer windows (progress, available, errors).
  subscribeUpdateStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.updateStatus, status);
      }
    }
  });
}
