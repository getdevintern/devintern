/**
 * Typed IPC contract shared by main, preload, and renderer.
 *
 * All request/response handlers return a discriminated {@link IpcResult}
 * envelope instead of throwing: Electron mangles rejected Errors into bare
 * message strings across the IPC boundary, losing code/detail.
 */

import type {
  ProjectRef,
  PromptStyle,
  SourceType,
  StoryDraft,
  SubtaskDraft,
} from "@getdevintern/pm/engine";

export type {
  ProjectRef,
  PromptStyle,
  SourceType,
  StoryDraft,
  SubtaskDraft,
} from "@getdevintern/pm/engine";

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
  backendName?: string;
  harnessDisplayName?: string;
  supportsIssueTypes?: boolean;
  supportsEpicLinking?: boolean;
  defaultProjectKey?: string;
  projects?: ProjectRef[];
  issueTypes?: string[];
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

/** API surface exposed on `window.pm` by the preload script. */
export interface PmDesktopApi {
  chooseProjectDir(): Promise<IpcResult<string | null>>;
  getProjectStatus(dir: string): Promise<IpcResult<ProjectStatus>>;
  getLastProjectDir(): Promise<IpcResult<string | null>>;
  listIssueTypes(projectKey?: string): Promise<IpcResult<string[]>>;
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
  /** Subscribe to streaming agent output. Returns an unsubscribe function. */
  onAgentChunk(callback: (event: AgentChunkEvent) => void): () => void;
}

export const IPC_CHANNELS = {
  chooseProjectDir: "pm:choose-project-dir",
  getProjectStatus: "pm:get-project-status",
  getLastProjectDir: "pm:get-last-project-dir",
  listIssueTypes: "pm:list-issue-types",
  generateStory: "pm:generate-story",
  editStory: "pm:edit-story",
  decomposeStory: "pm:decompose-story",
  createTask: "pm:create-task",
  createSubtasks: "pm:create-subtasks",
  openExternal: "pm:open-external",
  agentChunk: "pm:agent-chunk",
} as const;
