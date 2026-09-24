import React from "react";
import { render } from "ink";
import { getDefaultIssueType } from "../issue-types";
import { InteractiveFormWithPreview } from "./InteractiveForm";
import type {
  InteractiveModeHandle,
  InteractiveModeOptions,
  InteractiveState,
  WizardConfig,
  WizardSession,
} from "./interactive-types";

export { canNavigateBack, getPreviousStep } from "./interactive-navigation";
export type {
  InteractiveModeHandle,
  InteractiveModeOptions,
  InteractiveState,
  StepNavFlags,
  Task,
  WizardStep,
} from "./interactive-types";

/**
 * Launches the multi-step Ink interactive wizard for creating PM tasks.
 *
 * Renders the form, exposes imperative hooks for generation/preview/edit flows,
 * and resolves when the user confirms or cancels.
 *
 * @param options - Optional projects, issue types, fetcher, and backend display name.
 * @returns Handle with methods to drive generation, preview, edit, and restart cycles.
 */
export async function runInteractiveMode(
  options?: InteractiveModeOptions,
): Promise<InteractiveModeHandle> {
  return new Promise((resolve, reject) => {
    const session: WizardSession = {
      completed: false,
      updateState: null,
      completePromiseResolve: null,
      editPromiseResolve: null,
      restartPromiseResolve: null,
      currentStep: "source-type",
      visiblePreviewData: null,
      currentHarnessName: options?.currentHarnessName,
    };
    let cancelled = false;
    let completePromiseReject: ((error: Error) => void) | null = null;
    let editPromiseReject: ((error: Error) => void) | null = null;
    let restartPromiseReject: ((error: Error) => void) | null = null;

    const cancelError = () => new Error("Interactive mode cancelled");

    /** Rejects any pending orchestrator waiters when the Ink app unmounts (e.g. Ctrl+C). */
    const rejectPendingWaiters = () => {
      cancelled = true;
      const error = cancelError();
      if (completePromiseReject) {
        completePromiseReject(error);
        completePromiseReject = null;
        session.completePromiseResolve = null;
      }
      if (editPromiseReject) {
        editPromiseReject(error);
        editPromiseReject = null;
        session.editPromiseResolve = null;
      }
      if (restartPromiseReject) {
        restartPromiseReject(error);
        restartPromiseReject = null;
        session.restartPromiseResolve = null;
      }
    };

    // Use provided projects or empty array
    const allProjects = options?.projects || [];
    const defaultProjectKey = options?.defaultProjectKey;

    // Reorder projects to show default first
    const projects = defaultProjectKey
      ? [
          ...allProjects.filter((p) => p.key === defaultProjectKey),
          ...allProjects.filter((p) => p.key !== defaultProjectKey),
        ]
      : allProjects;

    // Whether to show the issue type selection step at all
    const hasIssueTypeStep = options?.issueTypes !== undefined;

    // Whether to show the epic linking step at all (skip for trackers that
    // can't persist an epic/parent link). Defaults to true for compatibility.
    const hasEpicStep = options?.supportsEpicLinking ?? true;

    const allHarnesses = options?.harnesses || [];
    const currentHarnessName = options?.currentHarnessName;
    const orderedHarnesses = currentHarnessName
      ? [
          ...allHarnesses.filter((h) => h.name === currentHarnessName),
          ...allHarnesses.filter((h) => h.name !== currentHarnessName),
        ]
      : allHarnesses;
    const hasHarnessStep = orderedHarnesses.length > 0;

    // First step after collecting custom instructions, accounting for skips.
    const stepAfterCustom = hasEpicStep ? "epic" : hasIssueTypeStep ? "issue-type" : "style";

    // Use provided issue types or default fallback
    const defaultIssueTypes =
      options?.issueTypes && options.issueTypes.length > 0
        ? options.issueTypes
        : ["Story", "Task", "Bug", "Epic"];

    const config: WizardConfig = {
      projects,
      defaultProjectKey,
      hasIssueTypeStep,
      hasEpicStep,
      allHarnesses,
      orderedHarnesses,
      hasHarnessStep,
      stepAfterCustom,
      defaultIssueTypes,
      currentHarnessName,
      backendName: options?.backendName,
      harnessDisplayName: options?.harnessDisplayName,
      fetchIssueTypes: options?.fetchIssueTypes,
    };

    const { waitUntilExit, unmount } = render(
      <InteractiveFormWithPreview session={session} config={config} />,
      options?.stdin !== undefined ? { stdin: options.stdin } : undefined,
    );

    waitUntilExit().then(() => {
      rejectPendingWaiters();
      if (!session.completed) {
        reject(cancelError());
      }
    });

    /**
     * Waits until the user confirms configuration or accepts a generated preview.
     *
     * @returns Resolved interactive state when the user proceeds to generation or creation.
     */
    const waitForCompletion = (): Promise<InteractiveState> => {
      if (cancelled) {
        return Promise.reject(cancelError());
      }
      return new Promise((resolveComplete, rejectComplete) => {
        session.completePromiseResolve = (resolvedState) => {
          // Don't unmount - keep UI running for preview / create-another cycles
          session.completePromiseResolve = null;
          completePromiseReject = null;
          resolveComplete(resolvedState);
        };
        completePromiseReject = rejectComplete;
      });
    };

    /** Switches the wizard to the generating step while the agent runs. */
    const setGenerating = () => {
      if (session.updateState) {
        session.updateState({
          step: "generating",
          statusMessage: "Starting AI agent...",
        });
      }
    };

    /** Updates the status line shown on the generating/regenerating screen. */
    const setStatusMessage = (message: string) => {
      if (session.updateState) {
        session.updateState({ statusMessage: message });
      }
    };

    /**
     * Populates the preview pane with generated task title and description.
     *
     * @param summary - Generated issue title.
     * @param description - Generated issue body (markdown).
     */
    const setPreviewData = (summary: string, description: string) => {
      if (session.updateState) {
        session.updateState({ previewData: { summary, description }, step: "preview" });
      }
    };

    /**
     * Updates preview data without changing the current step.
     * Used by orchestrators to refresh preview content while the user
     * is on the preview or edit-prompt screen.
     *
     * @param summary - Generated issue title.
     * @param description - Generated issue body (markdown).
     */
    const updatePreviewData = (summary: string, description: string) => {
      if (session.updateState) {
        session.updateState({ previewData: { summary, description } });
      }
    };

    /**
     * Waits until the user submits an edit prompt on the preview screen.
     *
     * @returns Edit prompt text plus the current preview title and description.
     */
    const waitForEdit = (): Promise<{
      editPrompt: string;
      currentSummary: string;
      currentDescription: string;
    }> => {
      if (cancelled) {
        return Promise.reject(cancelError());
      }
      return new Promise((resolveEdit, rejectEdit) => {
        session.editPromiseResolve = (data) => {
          session.editPromiseResolve = null;
          editPromiseReject = null;
          resolveEdit(data);
        };
        editPromiseReject = rejectEdit;
      });
    };

    /**
     * Displays the success screen with a completion message.
     *
     * @param message - Success text shown after task creation.
     */
    const showSuccess = (message: string) => {
      if (session.updateState) {
        session.updateState({ successMessage: message, step: "success", statusMessage: undefined });
      }
    };

    /**
     * Waits until the user presses any key on the success screen to start another task.
     *
     * @returns Resolves when the user requests a new wizard run.
     * @throws If the user cancels with Ctrl+C / the Ink app unmounts.
     */
    const waitForRestart = (): Promise<void> => {
      if (cancelled) {
        return Promise.reject(cancelError());
      }
      return new Promise((resolveRestart, rejectRestart) => {
        session.restartPromiseResolve = () => {
          session.restartPromiseResolve = null;
          restartPromiseReject = null;
          resolveRestart();
        };
        restartPromiseReject = rejectRestart;
      });
    };

    /**
     * Resets wizard state to the first step without unmounting the Ink tree.
     * Used after success/error so create-another reuses the same interactive session.
     */
    const restart = () => {
      if (session.updateState) {
        session.updateState({
          step: "source-type",
          projectKey: defaultProjectKey,
          sourceType: undefined,
          sourceContent: undefined,
          customInstructions: undefined,
          epicKey: undefined,
          promptStyle: "pm",
          issueType: getDefaultIssueType(defaultIssueTypes),
          // Preserve the harness the user most recently selected mid-wizard.
          harnessName: session.currentHarnessName ?? currentHarnessName,
          decompose: false,
          tasks: [],
          previewData: undefined,
          successMessage: undefined,
          statusMessage: undefined,
          editPrompt: undefined,
        });
      }
    };

    resolve({
      setGenerating,
      setStatusMessage,
      setPreviewData,
      updatePreviewData,
      waitForCompletion,
      waitForEdit,
      showSuccess,
      waitForRestart,
      restart,
      getStep: () => session.currentStep,
      getPreviewData: () => session.visiblePreviewData ?? undefined,
      getHarnessName: () => session.currentHarnessName,
      /** Unmounts the Ink interactive form and releases terminal control. */
      cleanup: () => {
        unmount();
      },
    });
  });
}
