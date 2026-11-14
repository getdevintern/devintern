/**
 * State machine for the "Report a problem" dialog.
 *
 * compose → (preview request) → preview → (send) → sent | saved
 *
 * The preview step holds the server's preview id; Send submits that id, so
 * what the user reviewed is what leaves the machine.
 */

import type { ReportDraft, ReportPreview, ReportSubmitResult } from "@/lib/api";

export type SentResult = Extract<ReportSubmitResult, { status: "sent" }>;
export type SavedResult = Extract<ReportSubmitResult, { status: "saved" }>;

export type ReportPhase =
  | { step: "compose"; busy: boolean; error?: string }
  | { step: "preview"; preview: ReportPreview; busy: boolean; error?: string }
  | { step: "sent"; result: SentResult }
  | { step: "saved"; result: SavedResult; preview: ReportPreview };

export interface ReportFlowState {
  draft: ReportDraft;
  email: string;
  phase: ReportPhase;
}

export type ReportFlowAction =
  | { type: "edit"; draft: Partial<ReportDraft> }
  | { type: "email"; email: string }
  | { type: "previewStart" }
  | { type: "previewDone"; preview: ReportPreview }
  | { type: "previewFailed"; error: string }
  | { type: "back" }
  | { type: "sendStart" }
  | { type: "sendDone"; result: ReportSubmitResult }
  | { type: "sendFailed"; error: string }
  | { type: "reset" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const INITIAL_REPORT_FLOW: ReportFlowState = {
  draft: { title: "", description: "", shareIdentifiers: false },
  email: "",
  phase: { step: "compose", busy: false },
};

/** Whether the compose form is complete enough to preview. */
export function canPreview(state: ReportFlowState): boolean {
  return (
    state.phase.step === "compose" &&
    !state.phase.busy &&
    state.draft.title.trim().length > 0 &&
    state.draft.description.trim().length > 0
  );
}

/** Whether the preview may be sent (anonymous reports need a contact email). */
export function canSend(state: ReportFlowState): boolean {
  const { phase } = state;
  if (phase.step !== "preview" || phase.busy) return false;
  return !phase.preview.contactRequired || EMAIL_PATTERN.test(state.email.trim());
}

/** Whether closing would throw away an unsent report (typed title or description). */
export function isReportDraftDirty(state: ReportFlowState): boolean {
  const { phase, draft } = state;
  if (phase.step === "sent" || phase.step === "saved") return false;
  return draft.title.trim() !== "" || draft.description.trim() !== "";
}

/** Whether a preview or send request is in flight (the dialog must stay open). */
export function isReportBusy(state: ReportFlowState): boolean {
  const { phase } = state;
  return (phase.step === "compose" || phase.step === "preview") && phase.busy;
}

/** Advance the dialog state. Out-of-order actions are ignored. */
export function reportFlowReducer(
  state: ReportFlowState,
  action: ReportFlowAction,
): ReportFlowState {
  const { phase } = state;
  switch (action.type) {
    case "edit":
      // Editing invalidates any preview: the user must preview again.
      if (phase.step !== "compose") return state;
      return { ...state, draft: { ...state.draft, ...action.draft } };
    case "email":
      return { ...state, email: action.email };
    case "previewStart":
      if (!canPreview(state)) return state;
      return { ...state, phase: { step: "compose", busy: true } };
    case "previewDone":
      if (phase.step !== "compose") return state;
      return { ...state, phase: { step: "preview", preview: action.preview, busy: false } };
    case "previewFailed":
      if (phase.step !== "compose") return state;
      return { ...state, phase: { step: "compose", busy: false, error: action.error } };
    case "back":
      if (phase.step !== "preview" || phase.busy) return state;
      return { ...state, phase: { step: "compose", busy: false } };
    case "sendStart":
      if (phase.step === "saved") {
        return { ...state, phase: { step: "preview", preview: phase.preview, busy: true } };
      }
      if (!canSend(state) || phase.step !== "preview") return state;
      return { ...state, phase: { ...phase, busy: true, error: undefined } };
    case "sendDone":
      if (phase.step !== "preview") return state;
      return action.result.status === "sent"
        ? { ...state, phase: { step: "sent", result: action.result } }
        : { ...state, phase: { step: "saved", result: action.result, preview: phase.preview } };
    case "sendFailed":
      if (phase.step !== "preview") return state;
      return { ...state, phase: { ...phase, busy: false, error: action.error } };
    case "reset":
      return INITIAL_REPORT_FLOW;
    default:
      return state;
  }
}
