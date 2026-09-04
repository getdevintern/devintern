/**
 * Composer form values — extracted from `ComposerForm.tsx` so state modules
 * (`ticket-workspaces.ts`, `ticket-workspaces-store.ts`) can depend on the
 * shape without importing `ComposerForm.tsx` (which now pulls in the stores
 * and would form a module cycle: ComposerForm → selectors → store →
 * ticket-workspaces → ComposerForm).
 *
 * `ComposerForm.tsx` re-exports these to preserve its existing import surface.
 */

import type {
  AttachmentRef,
  ProjectStatus,
  PromptStyle,
  QuickCaptureEvent,
  SourceType,
} from "../../../shared/ipc-contract.ts";
import { getDefaultIssueType, resolveIssueTypes } from "../lib/issue-types.ts";

export interface ComposerValues {
  sourceType: SourceType;
  sourceContent: Record<SourceType, string>;
  extraInstructions: string;
  promptStyle: PromptStyle;
  projectKey: string;
  issueType: string;
  epicKey: string;
  /** Selected tracker label ids ({@link LabelRef.id}). */
  labels: string[];
  /** Local files for agent context + optional tracker upload. */
  attachments: AttachmentRef[];
  decompose: boolean;
}

export const initialComposerValues: ComposerValues = {
  sourceType: "prompt",
  sourceContent: { figma: "", log: "", prompt: "" },
  extraInstructions: "",
  promptStyle: "pm",
  projectKey: "",
  issueType: "Task",
  epicKey: "",
  labels: [],
  attachments: [],
  decompose: false,
};

/**
 * Overlay a Quick Capture payload onto a freshly built composer:
 * useful clipboard text selects the inferred source tab and prefills it;
 * a null text leaves the empty Prompt tab ready to type.
 */
export function composerForCapture(base: ComposerValues, event: QuickCaptureEvent): ComposerValues {
  if (event.text === null) return base;
  return {
    ...base,
    sourceType: event.sourceType,
    sourceContent: { ...base.sourceContent, [event.sourceType]: event.text },
  };
}

/** Fresh composer defaults for a loaded project (default key + issue type). */
export function defaultComposerForProject(
  status: ProjectStatus,
  issueTypes: string[],
): ComposerValues {
  const types = resolveIssueTypes(issueTypes);
  return {
    ...initialComposerValues,
    sourceContent: { ...initialComposerValues.sourceContent },
    projectKey: status.defaultProjectKey ?? "",
    issueType: getDefaultIssueType(types),
  };
}
