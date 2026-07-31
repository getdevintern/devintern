/**
 * UI-agnostic types for the PM story-generation engine.
 *
 * This module must stay free of ink/React imports so the engine can run in
 * any Node host (CLI, Electron main process, tests).
 */

export type SourceType = "figma" | "log" | "prompt";
export type PromptStyle = "technical" | "pm";

export interface SourceInput {
  type: SourceType;
  content: string;
}

/** A generated (not yet created) story: title + markdown body. */
export interface StoryDraft {
  summary: string;
  description: string;
}

/** A generated subtask suggestion from story decomposition. */
export interface SubtaskDraft {
  summary: string;
  description?: string;
}

export interface ProjectRef {
  key: string;
  name: string;
}

/**
 * Per-call event callbacks.
 *
 * A fresh object is passed to each engine call (instead of a shared
 * EventEmitter) so callbacks scope naturally to one request — no listener
 * lifecycle to manage across TUI restarts or renderer reloads.
 */
export interface EngineCallEvents {
  /** Raw agent output chunk as it streams. */
  onAgentChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export type EngineErrorCode = "agent-failed" | "parse-failed" | "backend-failed";

/**
 * Error thrown by engine operations.
 *
 * `detail` carries raw diagnostics (agent stdout/stderr) so callers can
 * surface them without the engine printing anything itself.
 */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail?: string;
  /** Path of a debug dump file with the full raw agent output, when one was written. */
  readonly dumpFile?: string;

  constructor(code: EngineErrorCode, message: string, detail?: string, dumpFile?: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.detail = detail;
    this.dumpFile = dumpFile;
  }
}
