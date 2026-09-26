import type { StepNavFlags, WizardStep } from "./interactive-types";

/**
 * Returns the previous reachable wizard step for Esc/back navigation.
 *
 * Mirrors forward skip logic (`hasEpicStep` / `hasIssueTypeStep`) so back edges
 * never land on disabled epic or issue-type steps. Returns `null` when Esc
 * should not change the step (root, async agent steps, preview, success).
 *
 * @param step - Current wizard step.
 * @param flags - Which optional config steps are enabled for this backend.
 * @returns Previous step, or `null` if Esc is a no-op on this step.
 */
export function getPreviousStep(step: WizardStep, flags: StepNavFlags): WizardStep | null {
  switch (step) {
    case "source-type":
      return null;
    case "project":
      return "source-type";
    case "source-input":
      return "source-type";
    case "custom":
      return "source-input";
    case "epic":
      return "custom";
    case "issue-type":
      return flags.hasEpicStep ? "epic" : "custom";
    case "style":
      if (flags.hasIssueTypeStep) return "issue-type";
      if (flags.hasEpicStep) return "epic";
      return "custom";
    case "confirm":
      return "style";
    case "harness":
      // Modal step: Esc is handled via stepBeforeHarness, not the linear map.
      return null;
    case "edit-prompt":
      return "preview";
    // Preview stays put: index.ts holds a waitForCompletion/waitForEdit race;
    // navigating away without resolving either promise would strand the agent loop.
    // Generating/regenerating/done: agent is in flight — Esc cannot cancel safely.
    // Success: any-key restart is handled separately in useInput.
    case "preview":
    case "generating":
    case "regenerating":
    case "done":
    case "success":
      return null;
    default:
      return "source-type";
  }
}

/** Whether the header should advertise Esc as Back for the current step. */
export function canNavigateBack(step: WizardStep, flags: StepNavFlags): boolean {
  return getPreviousStep(step, flags) !== null;
}
