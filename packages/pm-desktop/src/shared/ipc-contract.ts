/**
 * Typed IPC contract shared by main, preload, and renderer.
 *
 * All request/response handlers return a discriminated {@link IpcResult}
 * envelope instead of throwing: Electron mangles rejected Errors into bare
 * message strings across the IPC boundary, losing code/detail.
 */

import type { ConfiguredTracker } from "@devintern/task-trackers";
import type {
  ProjectRef,
  PromptStyle,
  SourceType,
  StoryDraft,
  SubtaskDraft,
} from "@getdevintern/pm/engine";
import type { PmInitContext, PmTrackerInfo } from "@getdevintern/pm/init";

export type {
  ProjectRef,
  PromptStyle,
  SourceType,
  StoryDraft,
  SubtaskDraft,
} from "@getdevintern/pm/engine";

export type { ConfiguredTracker } from "@devintern/task-trackers";
export type { ExistingTrackerConfig, PmInitContext, PmTrackerInfo } from "@getdevintern/pm/init";

export interface IpcError {
  code: string;
  message: string;
  detail?: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/** Everything the renderer needs to render the composer for a project dir. */
export interface ProjectStatus {
  projectDir: string;
  configured: boolean;
  /** Present when the config could not be loaded (missing .env vars, etc.). */
  configError?: string;
  /**
   * True when `<project>/.devintern-code` exists — the team is already using
   * (or scaffolding) @devintern/code, so skip the discovery tip.
   */
  hasCodeConfig?: boolean;
  backendName?: string;
  harnessDisplayName?: string;
  supportsIssueTypes?: boolean;
  supportsEpicLinking?: boolean;
  defaultProjectKey?: string;
  projects?: ProjectRef[];
  /** Set when listing remote projects failed (API error, etc.). */
  projectsError?: string;
  issueTypes?: string[];
  /**
   * Trackers whose required credentials are already present in the project
   * env — the only options offered by the tracker switcher.
   */
  configuredTrackers?: ConfiguredTracker[];
  /** Active `TASK_TRACKER` id (e.g. `jira`), when known from env/config. */
  activeTrackerId?: string;
  /** Human-readable name for the active tracker. */
  activeTrackerDisplayName?: string;
  /**
   * True when the active tracker has a project-key env var that can be
   * persisted (Jira project, Linear team, …). Markdown has no switcher.
   */
  supportsProjectSwitch?: boolean;
}

export interface GenerateStoryRequest {
  source: { type: SourceType; content: string };
  promptStyle: PromptStyle;
  epicKey?: string;
  extraInstructions?: string;
}

export interface EditStoryRequest {
  current: StoryDraft;
  editPrompt: string;
  issueType: string;
}

export interface DecomposeStoryRequest {
  story: StoryDraft;
  sourceType: SourceType;
  promptStyle: PromptStyle;
}

export interface CreateTaskRequest {
  draft: StoryDraft;
  issueType: string;
  projectKey?: string;
  epicKey?: string;
}

export interface CreateTaskResponse {
  key: string;
  url: string;
  epicLinked: boolean;
  epicLinkError?: string;
}

export interface SubtaskOutcome {
  subtask: SubtaskDraft;
  key?: string;
  url?: string;
  error?: string;
}

export interface AgentChunkEvent {
  requestId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

/** Payload for writing `.devintern-pm` config from the in-app setup wizard. */
export interface InitializeProjectRequest {
  projectDir: string;
  trackerId: string;
  values: Record<string, string>;
  /** Required when config already exists; cancel leaves the file untouched. */
  overwrite?: boolean;
}

/** Result of a tracker credential probe (ok envelope wraps this from IPC). */
export type ProbeConnectionResult = { ok: true } | { ok: false; message: string };

/** Init inspect payload: config snapshot + tracker menu for the wizard. */
export type ProjectInitInspect = PmInitContext & { trackers: PmTrackerInfo[] };

/** API surface exposed on `window.pm` by the preload script. */
export interface PmDesktopApi {
  chooseProjectDir(): Promise<IpcResult<string | null>>;
  getProjectStatus(dir: string): Promise<IpcResult<ProjectStatus>>;
  getLastProjectDir(): Promise<IpcResult<string | null>>;
  listIssueTypes(projectKey?: string): Promise<IpcResult<string[]>>;
  /** Tracker menu + existing-config / reusable-code snapshot for the setup wizard. */
  inspectProjectInit(dir: string): Promise<IpcResult<ProjectInitInspect>>;
  /** Validate tracker credentials before writing config (markdown always ok). */
  probeTrackerConnection(
    trackerId: string,
    values: Record<string, string>,
  ): Promise<IpcResult<ProbeConnectionResult>>;
  /** Write `.devintern-pm/.env` + gitignore secrets, then load the project session. */
  initializeProject(input: InitializeProjectRequest): Promise<IpcResult<ProjectStatus>>;
  generateStory(requestId: string, input: GenerateStoryRequest): Promise<IpcResult<StoryDraft>>;
  editStory(requestId: string, input: EditStoryRequest): Promise<IpcResult<StoryDraft>>;
  decomposeStory(
    requestId: string,
    input: DecomposeStoryRequest,
  ): Promise<IpcResult<SubtaskDraft[]>>;
  createTask(input: CreateTaskRequest): Promise<IpcResult<CreateTaskResponse>>;
  createSubtasks(
    parentKey: string,
    subtasks: SubtaskDraft[],
    projectKey?: string,
  ): Promise<IpcResult<SubtaskOutcome[]>>;
  openExternal(url: string): Promise<IpcResult<null>>;
  /** Installed/running app version from Electron `app.getVersion()`. */
  getAppVersion(): Promise<IpcResult<string>>;
  /** Whether the user dismissed the Code discovery tip (persists across sessions). */
  isCodeDiscoveryDismissed(): Promise<IpcResult<boolean>>;
  /** Persist dismissal of the Code discovery tip. */
  dismissCodeDiscovery(): Promise<IpcResult<null>>;
  /** Whether anonymous usage analytics are enabled (default on). */
  getAnalyticsEnabled(): Promise<IpcResult<boolean>>;
  /** Enable or disable anonymous usage analytics. */
  setAnalyticsEnabled(enabled: boolean): Promise<IpcResult<null>>;
  /**
   * Persist `TASK_TRACKER` for a configured tracker and reload the session.
   * Open tickets are reset so composer/capabilities match the new backend.
   */
  switchTracker(trackerId: string): Promise<IpcResult<ProjectStatus>>;
  /**
   * Persist the active tracker's project-key env var and reload the session.
   * Open tickets are reset so the new default project is applied.
   */
  switchProjectKey(projectKey: string): Promise<IpcResult<ProjectStatus>>;
  /** Subscribe to streaming agent output. Returns an unsubscribe function. */
  onAgentChunk(callback: (event: AgentChunkEvent) => void): () => void;
  /** Subscribe to About menu requests from the main process. */
  onShowAbout(callback: () => void): () => void;
}

export const IPC_CHANNELS = {
  chooseProjectDir: "pm:choose-project-dir",
  getProjectStatus: "pm:get-project-status",
  getLastProjectDir: "pm:get-last-project-dir",
  listIssueTypes: "pm:list-issue-types",
  inspectProjectInit: "pm:inspect-project-init",
  probeTrackerConnection: "pm:probe-tracker-connection",
  initializeProject: "pm:initialize-project",
  generateStory: "pm:generate-story",
  editStory: "pm:edit-story",
  decomposeStory: "pm:decompose-story",
  createTask: "pm:create-task",
  createSubtasks: "pm:create-subtasks",
  openExternal: "pm:open-external",
  getAppVersion: "pm:get-app-version",
  isCodeDiscoveryDismissed: "pm:is-code-discovery-dismissed",
  dismissCodeDiscovery: "pm:dismiss-code-discovery",
  getAnalyticsEnabled: "pm:get-analytics-enabled",
  setAnalyticsEnabled: "pm:set-analytics-enabled",
  switchTracker: "pm:switch-tracker",
  switchProjectKey: "pm:switch-project-key",
  agentChunk: "pm:agent-chunk",
  showAbout: "pm:show-about",
} as const;
