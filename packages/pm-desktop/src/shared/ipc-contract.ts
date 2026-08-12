/**
 * Typed IPC contract shared by main, preload, and renderer.
 *
 * All request/response handlers return a discriminated {@link IpcResult}
 * envelope instead of throwing: Electron mangles rejected Errors into bare
 * message strings across the IPC boundary, losing code/detail.
 */

import type { ConfiguredTracker } from "@devintern/task-trackers";
import type {
  LabelListResult,
  LabelRef,
  ProjectRef,
  PromptStyle,
  SourceType,
  StoryDraft,
  SubtaskDraft,
} from "@getdevintern/pm/engine";
import type { PmInitContext, PmTrackerInfo } from "@getdevintern/pm/init";
import type { UpdateStatus } from "./auto-update.ts";
import type { ProjectBindingInfo } from "./project-binding.ts";
import type { ProjectGitSyncStatus } from "./project-git-sync.ts";

export type {
  LabelListResult,
  LabelRef,
  ProjectRef,
  PromptStyle,
  SourceType,
  StoryDraft,
  SubtaskDraft,
} from "@getdevintern/pm/engine";

export type { ConfiguredTracker } from "@devintern/task-trackers";
export type { ExistingTrackerConfig, PmInitContext, PmTrackerInfo } from "@getdevintern/pm/init";
export type { UpdatePhase, UpdateStatus, UpdateDownloadProgress } from "./auto-update.ts";
export {
  UPDATE_SNOOZE_MS,
  formatUpdateAvailableMessage,
  shouldPromptForUpdate,
} from "./auto-update.ts";
export type { ProjectBinding, ProjectBindingInfo } from "./project-binding.ts";
export type { ProjectGitSyncKind, ProjectGitSyncStatus } from "./project-git-sync.ts";
export {
  canUpdateProjectFromRemote,
  projectGitSyncLabel,
  shouldShowUpdateFromRemote,
} from "./project-git-sync.ts";

export interface IpcError {
  code: string;
  message: string;
  detail?: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/** Installed harness option for the header harness switcher. */
export interface AvailableHarness {
  /** Registry id (e.g. `claude-code`). */
  name: string;
  /** Human-readable label shown in the pill and menu. */
  displayName: string;
}

/** Everything the renderer needs to render the composer for a project dir. */
export interface ProjectStatus {
  projectDir: string;
  configured: boolean;
  /**
   * True when the folder (or an ancestor) is inside a git working tree.
   * Product minimum for a “suitable” project folder; distinct from PM config.
   */
  isGitRepository: boolean;
  /** Present when the config could not be loaded (missing .env vars, etc.). */
  configError?: string;
  /**
   * True when `<project>/.devintern-code` exists — the team is already using
   * (or scaffolding) @devintern/code, so skip the discovery tip.
   */
  hasCodeConfig?: boolean;
  backendName?: string;
  harnessDisplayName?: string;
  /** Active harness registry id (e.g. `claude-code`), when config loaded. */
  activeHarnessName?: string;
  /**
   * Installed/valid harnesses offered by the header switcher. Includes the
   * active harness even when PATH detection would miss a custom CLI path.
   */
  availableHarnesses?: AvailableHarness[];
  supportsIssueTypes?: boolean;
  supportsEpicLinking?: boolean;
  supportsLabels?: boolean;
  /**
   * When true with {@link supportsLabels}, the Labels picker may invent names
   * that are not in the tracker catalog (markdown frontmatter).
   */
  supportsFreeformLabels?: boolean;
  /** True when local files can be uploaded onto created tickets. */
  supportsAttachments?: boolean;
  defaultProjectKey?: string;
  projects?: ProjectRef[];
  /** Set when listing remote projects failed (API error, etc.). */
  projectsError?: string;
  issueTypes?: string[];
  /** Existing tracker labels for the default project (when supported). */
  labels?: LabelRef[];
  /**
   * True when {@link labels} stopped at the soft catalog cap — the picker is
   * incomplete and should surface an affordance (e.g. “Showing first N…”).
   */
  labelsTruncated?: boolean;
  /** Set when listing labels failed (API error, etc.). */
  labelsError?: string;
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
  /**
   * Result of fetch (+ optional ff-only pull) for this checkout.
   * Soft-dirty (dirty repo-root `.gitignore`) does not block update.
   */
  gitSync?: ProjectGitSyncStatus;
  /**
   * Sidebar project binding `{ remote, localPath, lastFetch, managed }`.
   * Managed clones are app-owned under userData/projects.
   */
  projectBinding?: ProjectBindingInfo;
}

/** Connect a GitHub repo into a managed clone under userData/projects. */
export interface ConnectGitHubRepoRequest {
  /** `owner/repo` or github.com URL. */
  repoInput: string;
  /** Optional branch (defaults to the repo default branch). */
  branch?: string;
}

/** Stored GitHub auth status (never includes the token). */
export interface GitHubAuthStatus {
  connected: boolean;
  /** Which method is stored, when connected. */
  method?: "oauth" | "pat";
  /** GitHub login, when known (OAuth validation or PAT validation on set). */
  login?: string;
  /** Whether Electron safeStorage encryption is available right now. */
  encryptionAvailable: boolean;
  /**
   * When connected: whether the on-disk token file uses encryption
   * (false = plaintext fallback under userData).
   */
  tokenEncrypted?: boolean;
}

/** Prompt shown to the user during the OAuth device flow. */
export interface GitHubOAuthPrompt {
  userCode: string;
  verificationUri: string;
}

export interface GitHubRepoListItem {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** Local file attached in the composer for generation and/or tracker upload. */
export interface AttachmentRef {
  path: string;
  name: string;
}

export interface GenerateStoryRequest {
  source: { type: SourceType; content: string };
  promptStyle: PromptStyle;
  epicKey?: string;
  extraInstructions?: string;
  attachments?: AttachmentRef[];
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
  /** Existing label ids from {@link LabelRef.id} to apply after create. */
  labels?: string[];
  /** Local files to upload after create when the tracker supports attachments. */
  attachments?: AttachmentRef[];
}

export interface CreateTaskResponse {
  key: string;
  url: string;
  epicLinked: boolean;
  epicLinkError?: string;
  labelsApplied: boolean;
  labelsApplyError?: string;
  attachmentsUploaded: number;
  attachmentErrors?: string[];
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

/**
 * Payload for merging a tracker's credentials into an already-initialized
 * project's `.devintern-pm/.env` and making it the active tracker. Unrelated
 * settings and other trackers' credentials are preserved.
 */
export interface UpdateProjectTrackerRequest {
  projectDir: string;
  trackerId: string;
  values: Record<string, string>;
}

/** Result of a tracker credential probe (ok envelope wraps this from IPC). */
export type ProbeConnectionResult = { ok: true } | { ok: false; message: string };

/** Init inspect payload: config snapshot + tracker menu for the wizard. */
export type ProjectInitInspect = PmInitContext & {
  trackers: PmTrackerInfo[];
  /**
   * Parsed `.devintern-pm/.env` values (including secrets) for update-mode
   * prefill. Empty when no pm config exists yet (init mode).
   */
  currentEnv: Record<string, string>;
};

/** API surface exposed on `window.pm` by the preload script. */
export interface PmDesktopApi {
  chooseProjectDir(): Promise<IpcResult<string | null>>;
  /** Open a multi-select dialog for supported attachment files. */
  chooseAttachmentFiles(): Promise<IpcResult<AttachmentRef[]>>;
  /** Persist a clipboard image to a temp PNG, or null when clipboard has no image. */
  saveClipboardImage(): Promise<IpcResult<AttachmentRef | null>>;
  /**
   * Resolve absolute filesystem paths for File objects from drag-and-drop
   * (sync; uses Electron webUtils in preload — not an IPC round-trip).
   */
  resolveDroppedFiles(files: File[]): AttachmentRef[];
  getProjectStatus(dir: string): Promise<IpcResult<ProjectStatus>>;
  getLastProjectDir(): Promise<IpcResult<string | null>>;
  /**
   * Eligible recent project directories (most recent first). Omits missing paths
   * and folders that no longer have both `.git` and `.devintern-pm`.
   */
  getRecentProjectDirs(): Promise<IpcResult<string[]>>;
  /**
   * Clone (or reuse) a GitHub repo into a managed userData checkout, then load it.
   * Private repos require a stored GitHub token first.
   */
  connectGitHubRepo(input: ConnectGitHubRepoRequest): Promise<IpcResult<ProjectStatus>>;
  /** Whether a GitHub token is stored (never returns the secret). */
  getGitHubAuthStatus(): Promise<IpcResult<GitHubAuthStatus>>;
  /** Store a GitHub PAT after validating it against the API. */
  setGitHubToken(token: string): Promise<IpcResult<GitHubAuthStatus>>;
  /** Clear the stored GitHub token (PAT or OAuth). */
  clearGitHubToken(): Promise<IpcResult<null>>;
  /** Whether the OAuth "Sign in with GitHub" path is available (Client ID set). */
  isGitHubOAuthAvailable(): Promise<IpcResult<boolean>>;
  /**
   * Start the OAuth device flow. Resolves with the auth status on success.
   * Rejects with code `cancelled` / `expired` / `denied` / `error`.
   */
  startGitHubOAuth(): Promise<IpcResult<GitHubAuthStatus>>;
  /** Cancel an in-flight OAuth device flow (resolves once polling stops). */
  cancelGitHubOAuth(): Promise<IpcResult<null>>;
  /** Subscribe to the OAuth device-flow prompt (user code + verification URI). */
  onGitHubOAuthPrompt(callback: (prompt: GitHubOAuthPrompt) => void): () => void;
  /** Repositories visible to the stored token (empty when disconnected). */
  listGitHubRepos(): Promise<IpcResult<GitHubRepoListItem[]>>;
  /** Reveal the project folder in the OS file manager. */
  revealProjectInFolder(dir: string): Promise<IpcResult<null>>;
  /**
   * Remove a connected project. Managed clones delete the checkout after confirm
   * in the UI; unmanaged folder opens only drop the binding / recent entry.
   */
  removeConnectedProject(options: {
    localPath: string;
    /** When true, delete the managed clone directory from disk. */
    deleteFiles: boolean;
  }): Promise<IpcResult<null>>;
  listIssueTypes(projectKey?: string): Promise<IpcResult<string[]>>;
  /** Existing tracker labels for the project/repo/board/team context. */
  listLabels(projectKey?: string): Promise<IpcResult<LabelListResult>>;
  /** Tracker menu + existing-config / reusable-code snapshot for the setup wizard. */
  inspectProjectInit(dir: string): Promise<IpcResult<ProjectInitInspect>>;
  /** Validate tracker credentials before writing config (markdown always ok). */
  probeTrackerConnection(
    trackerId: string,
    values: Record<string, string>,
  ): Promise<IpcResult<ProbeConnectionResult>>;
  /** Write `.devintern-pm/.env` + gitignore secrets, then load the project session. */
  initializeProject(input: InitializeProjectRequest): Promise<IpcResult<ProjectStatus>>;
  /**
   * Merge a tracker's credentials into `.devintern-pm/.env` (preserving other
   * trackers and settings), make it the active tracker, and reload the session.
   * Use this for post-init tracker changes from the desktop app.
   */
  updateProjectTracker(input: UpdateProjectTrackerRequest): Promise<IpcResult<ProjectStatus>>;
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
  /**
   * Mark a request id as in flight until {@link endAgentRequest}. Used to hold
   * the session lock across multi-IPC flows (e.g. create + optional decompose).
   */
  beginAgentRequest(requestId: string): Promise<IpcResult<null>>;
  /** Clear a request id started with {@link beginAgentRequest}. */
  endAgentRequest(requestId: string): Promise<IpcResult<null>>;
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
  /**
   * Persist `AGENT_HARNESS` for an installed harness and reload the session.
   * Open tickets are kept; subsequent agent actions use the new harness.
   */
  switchHarness(harnessName: string): Promise<IpcResult<ProjectStatus>>;
  /**
   * Fetch the project remote and fast-forward when clean or PM soft-dirty.
   * Soft-dirty must not block; hard-dirty skips with a clear message.
   */
  updateProjectFromRemote(): Promise<IpcResult<ProjectStatus>>;
  /** Subscribe to streaming agent output. Returns an unsubscribe function. */
  onAgentChunk(callback: (event: AgentChunkEvent) => void): () => void;
  /** Subscribe to About menu requests from the main process. */
  onShowAbout(callback: () => void): () => void;
  /** Current auto-update snapshot (disabled in unpackaged/dev builds). */
  getUpdateStatus(): Promise<IpcResult<UpdateStatus>>;
  /** Manual check (About). Surfaces errors; ignores snooze for display. */
  checkForUpdates(): Promise<IpcResult<UpdateStatus>>;
  /** Download the available update (shows progress via onUpdateStatus). */
  downloadUpdate(): Promise<IpcResult<UpdateStatus>>;
  /** Quit and install a downloaded update (preserves userData settings). */
  installUpdate(): Promise<IpcResult<UpdateStatus>>;
  /** Snooze prompts for the current available version (~24h). */
  snoozeUpdate(): Promise<IpcResult<UpdateStatus>>;
  /** Dismiss a recoverable update error. */
  dismissUpdateError(): Promise<IpcResult<UpdateStatus>>;
  /** Subscribe to auto-update status changes. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
}

export const IPC_CHANNELS = {
  chooseProjectDir: "pm:choose-project-dir",
  chooseAttachmentFiles: "pm:choose-attachment-files",
  saveClipboardImage: "pm:save-clipboard-image",
  getProjectStatus: "pm:get-project-status",
  getLastProjectDir: "pm:get-last-project-dir",
  getRecentProjectDirs: "pm:get-recent-project-dirs",
  connectGitHubRepo: "pm:connect-github-repo",
  getGitHubAuthStatus: "pm:get-github-auth-status",
  setGitHubToken: "pm:set-github-token",
  clearGitHubToken: "pm:clear-github-token",
  isGitHubOAuthAvailable: "pm:is-github-oauth-available",
  startGitHubOAuth: "pm:start-github-oauth",
  cancelGitHubOAuth: "pm:cancel-github-oauth",
  githubOAuthPrompt: "pm:github-oauth-prompt",
  listGitHubRepos: "pm:list-github-repos",
  revealProjectInFolder: "pm:reveal-project-in-folder",
  removeConnectedProject: "pm:remove-connected-project",
  listIssueTypes: "pm:list-issue-types",
  listLabels: "pm:list-labels",
  inspectProjectInit: "pm:inspect-project-init",
  probeTrackerConnection: "pm:probe-tracker-connection",
  initializeProject: "pm:initialize-project",
  updateProjectTracker: "pm:update-project-tracker",
  generateStory: "pm:generate-story",
  editStory: "pm:edit-story",
  decomposeStory: "pm:decompose-story",
  createTask: "pm:create-task",
  createSubtasks: "pm:create-subtasks",
  beginAgentRequest: "pm:begin-agent-request",
  endAgentRequest: "pm:end-agent-request",
  openExternal: "pm:open-external",
  getAppVersion: "pm:get-app-version",
  isCodeDiscoveryDismissed: "pm:is-code-discovery-dismissed",
  dismissCodeDiscovery: "pm:dismiss-code-discovery",
  getAnalyticsEnabled: "pm:get-analytics-enabled",
  setAnalyticsEnabled: "pm:set-analytics-enabled",
  switchTracker: "pm:switch-tracker",
  switchProjectKey: "pm:switch-project-key",
  switchHarness: "pm:switch-harness",
  updateProjectFromRemote: "pm:update-project-from-remote",
  agentChunk: "pm:agent-chunk",
  showAbout: "pm:show-about",
  getUpdateStatus: "pm:get-update-status",
  checkForUpdates: "pm:check-for-updates",
  downloadUpdate: "pm:download-update",
  installUpdate: "pm:install-update",
  snoozeUpdate: "pm:snooze-update",
  dismissUpdateError: "pm:dismiss-update-error",
  updateStatus: "pm:update-status",
} as const;
