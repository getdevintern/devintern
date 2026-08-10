/**
 * PM story-generation engine.
 *
 * UI-agnostic orchestration of agent prompts and task-tracker backends,
 * consumed by both the CLI/TUI (index.ts) and desktop hosts. This module
 * (and everything it imports) must never pull in ink/React.
 */

import { runAgent as defaultRunAgent } from "../agent.js";
import { dumpAgentOutput } from "../agent-debug.js";
import {
  attachmentsGuidanceBlurb,
  cleanupAttachmentStaging,
  stageAttachments,
  type AttachmentRef,
} from "../attachments.js";
import {
  createBackend,
  type CreatedTask,
  type LabelListResult,
  type TaskBackend,
} from "../backends/index.js";
import type { Config } from "../config.js";
import { extractJsonPayload } from "./json.js";
import { defaultPromptsDir, loadPrompt } from "./prompts.js";
import {
  EngineError,
  type EngineCallEvents,
  type PromptStyle,
  type SourceInput,
  type StoryDraft,
  type SubtaskDraft,
  type ProjectRef,
} from "./types.js";
import { DEFAULT_ISSUE_TYPES, getDefaultIssueType, orderIssueTypes } from "../issue-types.js";

export { extractJsonPayload } from "./json.js";
export { defaultPromptsDir, loadPrompt } from "./prompts.js";
export {
  EngineError,
  type EngineCallEvents,
  type EngineErrorCode,
  type PromptStyle,
  type SourceInput,
  type SourceType,
  type StoryDraft,
  type SubtaskDraft,
  type ProjectRef,
} from "./types.js";
export type { CreatedTask, LabelListResult, LabelRef } from "../backends/index.js";

/** Fallback issue types when a supporting backend cannot provide a list. */
export { DEFAULT_ISSUE_TYPES, getDefaultIssueType, orderIssueTypes };

export interface GenerateStoryInput {
  source: SourceInput;
  promptStyle: PromptStyle;
  epicKey?: string;
  extraInstructions?: string;
  /** Local files for agent context (staged into a temp dir for the run). */
  attachments?: AttachmentRef[];
}

export interface EditStoryInput {
  current: StoryDraft;
  editPrompt: string;
  issueType: string;
}

export interface DecomposeStoryInput {
  story: StoryDraft;
  sourceType: SourceInput["type"];
  promptStyle: PromptStyle;
}

export interface CreateTaskOptions {
  issueType: string;
  projectKey?: string;
  epicKey?: string;
  /** Existing label ids from {@link LabelRef.id} to apply after create. */
  labels?: string[];
  /** Local files to upload after create when the tracker supports attachments. */
  attachments?: AttachmentRef[];
}

/**
 * In-process trusted-caller extension of {@link CreateTaskOptions}.
 * Not exported — desktop IPC / CLI must never set `labelsPrevalidated`.
 */
interface TrustedCreateTaskOptions extends CreateTaskOptions {
  /**
   * When true, skip the allowlist refetch — caller already constrained ids
   * (e.g. engine tests). Untrusted callers cannot set this via the public type.
   */
  labelsPrevalidated?: boolean;
}

export interface CreateTaskResult {
  task: CreatedTask;
  /** True when an epic link was requested and persisted. */
  epicLinked: boolean;
  /** Present when epic linking was attempted but failed (task still created). */
  epicLinkError?: string;
  /** True when labels were requested and applied successfully. */
  labelsApplied: boolean;
  /** Present when label apply was attempted but failed (task still created). */
  labelsApplyError?: string;
  /** Number of attachments uploaded successfully after create. */
  attachmentsUploaded: number;
  /** Per-file upload failures (task still created). */
  attachmentErrors?: string[];
}

export interface PmEngine {
  readonly backendName: string;
  readonly supportsIssueTypes: boolean;
  readonly supportsEpicLinking: boolean;
  readonly supportsLabels: boolean;
  /** True when inventing label names outside the catalog is allowed (markdown). */
  readonly supportsFreeformLabels: boolean;
  /** True when local files can be uploaded onto created tickets. */
  readonly supportsAttachments: boolean;
  /** Default project/team/board key from tracker config, if any. */
  readonly defaultProjectKey: string | undefined;

  /** List projects, or `undefined` when the backend has no project listing. */
  listProjects(): Promise<ProjectRef[] | undefined>;
  /**
   * List issue types for a project. Returns `[]` when the backend does not
   * support issue types; falls back to {@link DEFAULT_ISSUE_TYPES} when the
   * backend supports them but provides no fetcher. Backend fetch errors
   * propagate so callers can decide how to degrade.
   */
  listIssueTypes(projectKey?: string): Promise<string[]>;
  /**
   * List existing labels for a project/repo/board/team. Returns an empty
   * catalog when the backend does not support labels. Backend fetch errors
   * propagate so callers can decide how to degrade. Soft-capped catalogs set
   * `truncated` so pickers can surface an incomplete-list affordance.
   */
  listLabels(projectKey?: string): Promise<LabelListResult>;

  generateStory(input: GenerateStoryInput, events?: EngineCallEvents): Promise<StoryDraft>;
  editStory(input: EditStoryInput, events?: EngineCallEvents): Promise<StoryDraft>;
  decomposeStory(input: DecomposeStoryInput, events?: EngineCallEvents): Promise<SubtaskDraft[]>;

  createTask(draft: StoryDraft, options: CreateTaskOptions): Promise<CreateTaskResult>;
  createSubtask(
    parentKey: string,
    subtask: SubtaskDraft,
    projectKey?: string,
  ): Promise<CreatedTask>;
}

/** Injectable dependencies for tests. */
export interface EngineDeps {
  runAgent?: typeof defaultRunAgent;
  backend?: TaskBackend;
}

export interface CreateEngineOptions {
  /** Root prompts directory (defaults to the package's bundled prompts/). */
  promptsDir?: string;
  /** Model override passed to every agent call. */
  model?: string;
  /**
   * Base directory for resolving relative backend paths (markdown tasks dir).
   * Defaults to cwd; desktop hosts pass the project directory.
   */
  baseDir?: string;
}

function isStoryPayload(value: unknown): value is StoryDraft {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.summary) && Boolean(record.description);
}

interface DecompositionPayload {
  subtasks: SubtaskDraft[];
}

function isDecompositionPayload(value: unknown): value is DecompositionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.subtasks);
}

/**
 * Create a {@link PmEngine} bound to a loaded config and its task backend.
 *
 * @param config - Loaded application config (tracker + agent harness).
 * @param options - Prompts directory and model overrides.
 * @param deps - Injectable runAgent/backend for tests.
 */
export async function createEngine(
  config: Config,
  options: CreateEngineOptions = {},
  deps: EngineDeps = {},
): Promise<PmEngine> {
  const backend = deps.backend ?? (await createBackend(config, options.baseDir));
  const runAgent = deps.runAgent ?? defaultRunAgent;
  const promptsDir = options.promptsDir ?? defaultPromptsDir();
  const model = options.model;

  const defaultProjectKey =
    config.jira?.defaultProjectKey ||
    config.linear?.defaultTeamKey ||
    config.trello?.defaultBoardId ||
    config.azureDevOps?.defaultProject ||
    config.asana?.defaultProjectGid ||
    config.github?.repository;

  /** Session cache of listLabels results — avoids re-paginating on createTask. */
  const labelsByProject = new Map<string, LabelListResult>();

  async function loadLabels(
    projectKey: string | undefined,
    options?: { maxLabels?: number },
  ): Promise<LabelListResult> {
    if (!backend.getLabels) {
      return { labels: [], truncated: false };
    }
    const result = await backend.getLabels(projectKey, options);
    labelsByProject.set(projectKey ?? "", result);
    return result;
  }

  async function runAndParse<T>(
    label: string,
    prompt: string,
    validate: (value: unknown) => value is T,
    failureMessage: string,
    invalidMessage: string,
    events?: EngineCallEvents,
    agentFiles?: { attachmentPaths: string[]; imagePaths: string[] },
  ): Promise<T> {
    const onAgentChunk = events?.onAgentChunk;
    const result = await runAgent(config.agent.harness, config.agent.path, prompt, {
      maxTurns: 100,
      skipPermissions: true,
      model,
      silent: true,
      attachmentPaths: agentFiles?.attachmentPaths,
      imagePaths: agentFiles?.imagePaths,
      onStdout: onAgentChunk ? (chunk) => onAgentChunk(chunk, "stdout") : undefined,
      onStderr: onAgentChunk ? (chunk) => onAgentChunk(chunk, "stderr") : undefined,
    });

    const dumpContext = { harness: config.agent.harness.name, cliPath: config.agent.path };

    if (result.exitCode !== 0) {
      const dumpFile = await dumpAgentOutput(label, result, dumpContext);
      throw new EngineError(
        "agent-failed",
        failureMessage,
        result.stderr.trim() || "Unknown agent error",
        dumpFile ?? undefined,
      );
    }

    try {
      return extractJsonPayload(result.stdout, validate, invalidMessage);
    } catch (error) {
      if (error instanceof EngineError) {
        const dumpFile = await dumpAgentOutput(`${label}-parse`, result, dumpContext);
        throw new EngineError(error.code, error.message, error.detail, dumpFile ?? undefined);
      }
      throw error;
    }
  }

  return {
    backendName: backend.name,
    supportsIssueTypes: backend.supportsIssueTypes,
    supportsEpicLinking: backend.supportsEpicLinking,
    supportsLabels: backend.supportsLabels,
    supportsFreeformLabels: backend.supportsFreeformLabels,
    supportsAttachments: backend.supportsAttachments,
    defaultProjectKey,

    async listProjects() {
      if (!backend.getProjects) {
        return undefined;
      }
      const projects = await backend.getProjects();
      return projects.map((p) => ({ key: p.key, name: p.name }));
    },

    async listIssueTypes(projectKey?: string) {
      if (!backend.supportsIssueTypes) {
        return [];
      }
      if (!backend.getIssueTypes) {
        return [...DEFAULT_ISSUE_TYPES];
      }
      return backend.getIssueTypes(projectKey);
    },

    async listLabels(projectKey?: string) {
      if (!backend.supportsLabels || !backend.getLabels) {
        return { labels: [], truncated: false };
      }
      return loadLabels(projectKey);
    },

    async generateStory(input, events) {
      const { source, promptStyle, epicKey, extraInstructions, attachments } = input;
      const hasAttachments = Boolean(attachments?.length);

      const replacements: Record<string, string> = {
        epicContext: epicKey ? `\nThis story will be part of epic: ${epicKey}` : "",
        extraInstructions: extraInstructions
          ? `\nAdditional instructions: ${extraInstructions}`
          : "",
        attachmentsSection: attachmentsGuidanceBlurb(hasAttachments),
      };
      if (source.type === "figma") {
        replacements.figmaUrl = source.content;
      } else if (source.type === "log") {
        replacements.logContent = source.content;
      } else {
        replacements.promptContent = source.content;
      }

      const prompt = await loadPrompt(
        promptsDir,
        source.type,
        promptStyle,
        "story-generation.txt",
        replacements,
      );

      let stagingDir: string | undefined;
      try {
        let agentFiles: { attachmentPaths: string[]; imagePaths: string[] } | undefined;
        if (hasAttachments && attachments) {
          const staged = await stageAttachments(attachments);
          stagingDir = staged.dir;
          agentFiles = {
            attachmentPaths: staged.files.map((file) => file.path),
            imagePaths: staged.files
              .filter((file) => file.kind === "image")
              .map((file) => file.path),
          };
        }

        return await runAndParse(
          "story-generation",
          prompt,
          isStoryPayload,
          "Failed to generate story from source",
          "Missing required fields: summary and description",
          events,
          agentFiles,
        );
      } finally {
        await cleanupAttachmentStaging(stagingDir);
      }
    },

    async editStory(input, events) {
      const { current, editPrompt, issueType } = input;
      const prompt = `Revise this ${issueType.toLowerCase()} based on the user's feedback. Keep the title unless they ask to change it.

Current Title: ${current.summary}

Current Description:
${current.description}

Edit request: ${editPrompt}

Return only valid JSON (no other text). Use markdown inside the description string:

{
  "summary": "Updated or same title",
  "description": "Updated description in markdown format"
}`;

      return runAndParse(
        "story-edit",
        prompt,
        isStoryPayload,
        "Failed to update story",
        "Missing required fields in update",
        events,
      );
    },

    async decomposeStory(input, events) {
      const prompt = await loadPrompt(
        promptsDir,
        input.sourceType,
        input.promptStyle,
        "decomposition.txt",
        {
          storySummary: input.story.summary,
          storyDescription: input.story.description,
        },
      );

      const payload = await runAndParse(
        "decomposition",
        prompt,
        isDecompositionPayload,
        "Failed to decompose story",
        "Expected subtasks array in response",
        events,
      );
      return payload.subtasks;
    },

    async createTask(draft, options) {
      const taskOptions = options as TrustedCreateTaskOptions;
      const task = await backend.createTask(
        draft.summary,
        draft.description,
        taskOptions.issueType,
        taskOptions.projectKey,
      );

      // Link to epic if requested and the tracker can persist a real link.
      // Trackers without epic support skip this silently so we never create
      // a misleading attachment/text reference.
      let epicLinked = false;
      let epicLinkError: string | undefined;
      if (taskOptions.epicKey && backend.supportsEpicLinking && backend.linkToEpic) {
        try {
          await backend.linkToEpic(task.key, taskOptions.epicKey);
          epicLinked = true;
        } catch (error) {
          epicLinkError = error instanceof Error ? error.message : String(error);
        }
      }

      // Apply labels after create so a labeling failure does not block the
      // ticket itself (same partial-success model as epic linking).
      // Validate against existing labels first so name-keyed trackers (Jira /
      // GitHub) cannot invent labels that the picker never offered. Prefer the
      // session listLabels cache (or labelsPrevalidated) over a full refetch.
      // Freeform backends (markdown) skip the allowlist — any name is writable.
      let labelsApplied = false;
      let labelsApplyError: string | undefined;
      const labels = taskOptions.labels?.filter((id) => id.trim().length > 0) ?? [];
      if (labels.length > 0 && backend.supportsLabels && backend.applyLabels) {
        try {
          // Name-keyed trackers (GitHub/Jira) auto-create unknown labels — never
          // apply without a catalog API to allowlist against (unless freeform).
          if (!backend.supportsFreeformLabels && !backend.getLabels) {
            throw new Error(
              "Cannot apply labels: tracker supports labels but does not expose a label catalog",
            );
          }
          if (!taskOptions.labelsPrevalidated && !backend.supportsFreeformLabels) {
            const cacheKey = taskOptions.projectKey ?? "";
            let catalog = labelsByProject.get(cacheKey);
            if (!catalog) {
              catalog = await loadLabels(taskOptions.projectKey);
            }
            let known = new Set(catalog.labels.map((label) => label.id));
            let unknown = labels.filter((id) => !known.has(id));
            // Soft-capped catalogs can miss real labels — exhaust before rejecting.
            if (unknown.length > 0 && catalog.truncated) {
              catalog = await loadLabels(taskOptions.projectKey, {
                maxLabels: Number.POSITIVE_INFINITY,
              });
              known = new Set(catalog.labels.map((label) => label.id));
              unknown = labels.filter((id) => !known.has(id));
            }
            if (unknown.length > 0) {
              throw new Error(`Unknown label(s): ${unknown.join(", ")}`);
            }
          }
          await backend.applyLabels(task.key, labels);
          labelsApplied = true;
        } catch (error) {
          labelsApplyError = error instanceof Error ? error.message : String(error);
        }
      }

      // Upload attachments after create (best-effort; same partial-success model).
      let attachmentsUploaded = 0;
      let attachmentErrors: string[] | undefined;
      const attachList = taskOptions.attachments ?? [];
      if (attachList.length > 0 && backend.supportsAttachments && backend.uploadAttachment) {
        const errors: string[] = [];
        for (const attachment of attachList) {
          const name = attachment.name || attachment.path;
          try {
            await backend.uploadAttachment(task.key, attachment.path, {
              filename: attachment.name,
            });
            attachmentsUploaded += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${name}: ${message}`);
          }
        }
        if (errors.length > 0) {
          attachmentErrors = errors;
        }
      }

      return {
        task,
        epicLinked,
        epicLinkError,
        labelsApplied,
        labelsApplyError,
        attachmentsUploaded,
        attachmentErrors,
      };
    },

    async createSubtask(parentKey, subtask, projectKey) {
      // Ensure we have a description, use summary as fallback
      const description = subtask.description?.trim() || subtask.summary;
      return backend.createSubtask(parentKey, subtask.summary, description, projectKey);
    },
  };
}
