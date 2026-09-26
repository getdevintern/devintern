import React, { useRef } from "react";
import { getPreviousStep } from "./interactive-navigation";
import type {
  InteractiveState,
  StepNavFlags,
  WizardSession,
  WizardStep,
} from "./interactive-types";

export interface WizardActionsParams {
  state: InteractiveState;
  setState: React.Dispatch<React.SetStateAction<InteractiveState>>;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  resetInput: (nextValue?: string) => void;
  exit: () => void;
  projects: Array<{ key: string; name: string }>;
  defaultProjectKey?: string;
  hasIssueTypeStep: boolean;
  hasEpicStep: boolean;
  stepAfterCustom: WizardStep;
  orderedIssueTypes: string[];
  orderedHarnesses: Array<{ name: string; displayName: string }>;
  session: WizardSession;
}

export interface WizardActions {
  navFlags: StepNavFlags;
  handleTextSubmit: (submittedValue: string) => void;
  handleEscape: () => void;
  handleEnter: () => void;
  inputSeedForStep: (step: WizardStep) => string;
  sharedPromptInputProps: { onEscape: () => void; onExit: () => void };
  stepBeforeHarnessRef: React.MutableRefObject<WizardStep | null>;
}

/**
 * Text-submit, Esc, and Enter handlers for the wizard plus the shared prompt
 * props. Also owns the `stepBeforeHarness` modal-return marker shared with the
 * global key router.
 */
export function useWizardActions(params: WizardActionsParams): WizardActions {
  const {
    state,
    setState,
    input,
    setInput,
    resetInput,
    exit,
    projects,
    defaultProjectKey,
    hasIssueTypeStep,
    hasEpicStep,
    stepAfterCustom,
    orderedIssueTypes,
    orderedHarnesses,
    session,
  } = params;

  const stepBeforeHarnessRef = useRef<WizardStep | null>(null);

  const navFlags: StepNavFlags = { hasEpicStep, hasIssueTypeStep };

  /**
   * Seed value for the text input when navigating back to a text-entry step.
   * Keeps prior answers editable instead of clearing the field.
   */
  const inputSeedForStep = (step: WizardStep): string => {
    switch (step) {
      case "source-input":
        return state.sourceContent || "";
      case "custom":
        return state.customInstructions || "";
      case "epic":
        return state.epicKey || "";
      default:
        return "";
    }
  };

  /**
   * Handles Enter submission from ink-text-input on text-entry wizard steps.
   *
   * @param submittedValue - Raw input value from the prompt field.
   */
  const handleTextSubmit = (submittedValue: string) => {
    const trimmedInput = submittedValue.trim();
    setInput(submittedValue);

    switch (state.step) {
      case "project": {
        if (trimmedInput === "" && defaultProjectKey) {
          setState((prev) => ({
            ...prev,
            projectKey: defaultProjectKey,
            step: "source-type",
          }));
          resetInput();
          break;
        }

        const index = parseInt(trimmedInput) - 1;
        if (index >= 0 && index < projects.length) {
          const project = projects[index];
          if (project) {
            setState((prev) => ({
              ...prev,
              projectKey: project.key,
              step: "source-type",
            }));
            resetInput();
          }
        }
        break;
      }

      case "source-input":
        if (trimmedInput) {
          setState((prev) => ({
            ...prev,
            sourceContent: trimmedInput,
            step: "custom",
          }));
          resetInput();
        }
        break;

      case "custom":
        setState((prev) => ({
          ...prev,
          customInstructions: trimmedInput || undefined,
          step: stepAfterCustom,
        }));
        resetInput();
        break;

      case "epic":
        setState((prev) => ({
          ...prev,
          epicKey: trimmedInput || undefined,
          step: hasIssueTypeStep ? "issue-type" : "style",
        }));
        resetInput();
        break;

      case "edit-prompt": {
        const currentPreview = session.visiblePreviewData;
        if (trimmedInput) {
          setState((prev) => ({
            ...prev,
            editPrompt: trimmedInput,
            step: "regenerating",
          }));
          if (session.editPromiseResolve && currentPreview) {
            session.editPromiseResolve({
              editPrompt: trimmedInput,
              currentSummary: currentPreview.summary,
              currentDescription: currentPreview.description,
            });
          }
          resetInput();
        }
        break;
      }
    }
  };

  /**
   * Navigates to the previous wizard step when the user presses Escape.
   * Uses the shared back-edge map so skipped epic/issue-type steps are never entered.
   * Does not clear previewData (including when leaving edit-prompt).
   */
  const handleEscape = () => {
    if (state.step === "harness") {
      const target = stepBeforeHarnessRef.current ?? "style";
      stepBeforeHarnessRef.current = null;
      resetInput(inputSeedForStep(target));
      setState((prev) => ({ ...prev, step: target }));
      return;
    }
    const previous = getPreviousStep(state.step, navFlags);
    if (previous === null) {
      return;
    }
    resetInput(inputSeedForStep(previous));
    setState((prev) => ({ ...prev, step: previous }));
  };

  /**
   * Resolve a y/n/Enter decision on the confirm and preview steps.
   * Accepting completes the wizard; declining restarts at source-type.
   */
  const handleDecision = (
    rawInput: string,
    acceptStep: "generating" | "done",
    clearPreview: boolean,
  ) => {
    const answer = rawInput.trim().toLowerCase();
    if (!["y", "n", ""].includes(answer)) return;
    if (answer === "y" || answer === "") {
      setState((prev) => ({ ...prev, step: acceptStep }));
      if (session.completePromiseResolve) {
        session.completed = true;
        session.completePromiseResolve(state);
      }
      return;
    }
    setState((prev) => ({
      ...prev,
      step: "source-type",
      ...(clearPreview ? { previewData: undefined } : {}),
    }));
    resetInput();
  };

  /**
   * Handles Enter on selection / yes-no steps (non text-input steps).
   * Agent and terminal steps ignore Enter so accidental keypresses never blank the UI.
   */
  const handleEnter = () => {
    // Do not act on Enter while the agent is running or the wizard is finished.
    if (
      state.step === "generating" ||
      state.step === "regenerating" ||
      state.step === "done" ||
      state.step === "success"
    ) {
      return;
    }

    const trimmedInput = input.trim();

    switch (state.step) {
      case "source-type":
        if (["1", "2", "3"].includes(trimmedInput)) {
          const sourceType =
            trimmedInput === "1" ? "figma" : trimmedInput === "2" ? "log" : "prompt";
          setState((prev) => ({
            ...prev,
            sourceType,
            step: "source-input",
          }));
          resetInput();
        }
        break;

      case "issue-type": {
        if (!hasIssueTypeStep) {
          break;
        }
        if (trimmedInput === "") {
          setState((prev) => ({ ...prev, step: "style" }));
          resetInput();
          break;
        }
        const index = parseInt(trimmedInput) - 1;
        if (index >= 0 && index < orderedIssueTypes.length) {
          const issueType = orderedIssueTypes[index];
          if (issueType) {
            setState((prev) => ({ ...prev, issueType, step: "style" }));
            resetInput();
          }
        }
        break;
      }

      case "harness": {
        const target = stepBeforeHarnessRef.current ?? "style";
        if (trimmedInput === "") {
          stepBeforeHarnessRef.current = null;
          setState((prev) => ({ ...prev, step: target }));
          resetInput();
          break;
        }
        const harnessIndex = parseInt(trimmedInput) - 1;
        if (harnessIndex >= 0 && harnessIndex < orderedHarnesses.length) {
          const harness = orderedHarnesses[harnessIndex];
          if (harness) {
            stepBeforeHarnessRef.current = null;
            setState((prev) => ({ ...prev, harnessName: harness.name, step: target }));
            resetInput();
          }
        }
        break;
      }

      case "style":
        if (["1", "2"].includes(trimmedInput)) {
          const promptStyle = trimmedInput === "1" ? "pm" : "technical";
          setState((prev) => ({
            ...prev,
            promptStyle,
            decompose: false,
            step: "confirm",
          }));
          resetInput();
        }
        break;

      case "confirm":
        handleDecision(trimmedInput, "generating", false);
        break;

      case "preview":
        // Enter alone accepts the draft (same as Y). Only act when preview data exists
        // so we never resolve completion while still showing "Waiting for task preview...".
        if (!state.previewData) {
          break;
        }
        handleDecision(trimmedInput, "done", true);
        break;
    }
  };

  const sharedPromptInputProps = {
    onEscape: handleEscape,
    onExit: exit,
  };

  return {
    navFlags,
    handleTextSubmit,
    handleEscape,
    handleEnter,
    inputSeedForStep,
    sharedPromptInputProps,
    stepBeforeHarnessRef,
  };
}
