/**
 * PM story-generation engine.
 *
 * UI-agnostic orchestration of agent prompts and task-tracker backends,
 * consumed by both the CLI/TUI (index.ts) and desktop hosts. This module
 * (and everything it imports) must never pull in ink/React.
 */

import { runAgent as defaultRunAgent } from "../agent.js";
import { dumpAgentOutput } from "../agent-debug.js";
import { createBackend, type CreatedTask, type TaskBackend } from "../backends/index.js";
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
export type { CreatedTask } from "../backends/index.js";

/** Fallback issue types when a supporting backend cannot provide a list. */
export { DEFAULT_ISSUE_TYPES, getDefaultIssueType, orderIssueTypes };

export interface GenerateStoryInput {
  source: SourceInput;
  promptStyle: PromptStyle;
  epicKey?: string;
  extraInstructions?: string;
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
}

export interface CreateTaskResult {
  task: CreatedTask;
  /** True when an epic link was requested and persisted. */
  epicLinked: boolean;
  /** Present when epic linking was attempted but failed (task still created). */
  epicLinkError?: string;
}

export interface PmEngine {
  readonly backendName: string;
  readonly supportsIssueTypes: boolean;
  readonly supportsEpicLinking: boolean;
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

  async function runAndParse<T>(
    label: string,
    prompt: string,
    validate: (value: unknown) => value is T,
    failureMessage: string,
    invalidMessage: string,
    events?: EngineCallEvents,
  ): Promise<T> {
    const onAgentChunk = events?.onAgentChunk;
    const result = await runAgent(config.agent.harness, config.agent.path, prompt, {
      maxTurns: 100,
      skipPermissions: true,
      model,
      silent: true,
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

    async generateStory(input, events) {
      const { source, promptStyle, epicKey, extraInstructions } = input;

      const replacements: Record<string, string> = {
        epicContext: epicKey ? `\nThis story will be part of epic: ${epicKey}` : "",
        extraInstructions: extraInstructions
          ? `\nAdditional instructions: ${extraInstructions}`
          : "",
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

      return runAndParse(
        "story-generation",
        prompt,
        isStoryPayload,
        "Failed to generate story from source",
        "Missing required fields: summary and description",
        events,
      );
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

    async createTask(draft, taskOptions) {
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

      return { task, epicLinked, epicLinkError };
    },

    async createSubtask(parentKey, subtask, projectKey) {
      // Ensure we have a description, use summary as fallback
      const description = subtask.description?.trim() || subtask.summary;
      return backend.createSubtask(parentKey, subtask.summary, description, projectKey);
    },
  };
}
