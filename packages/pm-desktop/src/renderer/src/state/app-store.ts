/**
 * Output-panel state machine.
 *
 * Form state lives outside this store (plain controlled inputs, always
 * editable). This reducer owns the generate → preview → edit → create →
 * decompose lifecycle on the right-hand panel. A "restart" keeps the form
 * and just resets the panel — the desktop equivalent of the CLI's
 * wait-for-restart loop against the stateless engine.
 */

import type {
  CreateTaskResponse,
  IpcError,
  StoryDraft,
  SubtaskDraft,
  SubtaskOutcome,
} from "../../../shared/ipc-contract.ts";

export type Phase =
  | "idle"
  | "generating"
  | "preview"
  | "editing"
  | "creating"
  | "decomposing"
  | "subtask-review"
  | "creating-subtasks"
  | "done"
  | "error";

export interface OutputState {
  phase: Phase;
  /** requestId of the in-flight agent call; chunks from other ids are ignored. */
  activeRequestId: string | null;
  agentLog: string;
  draft: StoryDraft | null;
  created: CreateTaskResponse | null;
  subtasks: SubtaskDraft[];
  /** Indexes into `subtasks` selected for creation. */
  selectedSubtasks: Set<number>;
  subtaskOutcomes: SubtaskOutcome[] | null;
  error: IpcError | null;
}

export const initialOutputState: OutputState = {
  phase: "idle",
  activeRequestId: null,
  agentLog: "",
  draft: null,
  created: null,
  subtasks: [],
  selectedSubtasks: new Set(),
  subtaskOutcomes: null,
  error: null,
};

export type OutputAction =
  | { type: "generate-started"; requestId: string }
  | { type: "generate-succeeded"; draft: StoryDraft }
  | { type: "edit-started"; requestId: string }
  | { type: "edit-succeeded"; draft: StoryDraft }
  | { type: "draft-title-changed"; summary: string }
  | { type: "create-started" }
  | { type: "create-succeeded"; created: CreateTaskResponse }
  | { type: "decompose-started"; requestId: string }
  | { type: "decompose-succeeded"; subtasks: SubtaskDraft[] }
  | { type: "subtask-toggled"; index: number }
  | { type: "create-subtasks-started" }
  | { type: "create-subtasks-finished"; outcomes: SubtaskOutcome[] }
  | { type: "subtasks-skipped" }
  | { type: "agent-chunk"; requestId: string; chunk: string }
  | { type: "request-failed"; error: IpcError }
  | { type: "error-dismissed" }
  | { type: "restarted" };

/** True while an operation is in flight and new requests must be blocked. */
export function isBusy(phase: Phase): boolean {
  return (
    phase === "generating" ||
    phase === "editing" ||
    phase === "creating" ||
    phase === "decomposing" ||
    phase === "creating-subtasks"
  );
}

export function outputReducer(state: OutputState, action: OutputAction): OutputState {
  switch (action.type) {
    case "generate-started":
      return {
        ...initialOutputState,
        phase: "generating",
        activeRequestId: action.requestId,
      };
    case "generate-succeeded":
      return { ...state, phase: "preview", activeRequestId: null, draft: action.draft };
    case "edit-started":
      return {
        ...state,
        phase: "editing",
        activeRequestId: action.requestId,
        agentLog: "",
        error: null,
      };
    case "edit-succeeded":
      return { ...state, phase: "preview", activeRequestId: null, draft: action.draft };
    case "draft-title-changed":
      return state.draft ? { ...state, draft: { ...state.draft, summary: action.summary } } : state;
    case "create-started":
      return { ...state, phase: "creating", error: null };
    case "create-succeeded":
      return { ...state, phase: "done", created: action.created };
    case "decompose-started":
      return {
        ...state,
        phase: "decomposing",
        activeRequestId: action.requestId,
        agentLog: "",
        error: null,
      };
    case "decompose-succeeded":
      return {
        ...state,
        phase: "subtask-review",
        activeRequestId: null,
        subtasks: action.subtasks,
        selectedSubtasks: new Set(action.subtasks.map((_, i) => i)),
      };
    case "subtask-toggled": {
      const selected = new Set(state.selectedSubtasks);
      if (selected.has(action.index)) {
        selected.delete(action.index);
      } else {
        selected.add(action.index);
      }
      return { ...state, selectedSubtasks: selected };
    }
    case "create-subtasks-started":
      return { ...state, phase: "creating-subtasks", error: null };
    case "create-subtasks-finished":
      return { ...state, phase: "done", subtaskOutcomes: action.outcomes };
    case "subtasks-skipped":
      return { ...state, phase: "done", subtasks: [], selectedSubtasks: new Set() };
    case "agent-chunk":
      if (action.requestId !== state.activeRequestId) {
        return state;
      }
      return { ...state, agentLog: state.agentLog + action.chunk };
    case "request-failed":
      return { ...state, phase: "error", activeRequestId: null, error: action.error };
    case "error-dismissed":
      // Return to the most sensible resting state: done if the task was
      // already created (re-showing Create would risk a duplicate), preview
      // if a draft exists (failed edit/create), otherwise idle.
      return {
        ...state,
        phase: state.created ? "done" : state.draft ? "preview" : "idle",
        error: null,
      };
    case "restarted":
      return initialOutputState;
  }
}
