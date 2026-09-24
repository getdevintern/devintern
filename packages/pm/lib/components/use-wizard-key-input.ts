import React from "react";
import { useInput } from "ink";
import type { ScrollViewRef } from "ink-scroll-view";
import { TEXT_ENTRY_STEPS } from "./interactive-types";
import type { InteractiveState, WizardSession, WizardStep } from "./interactive-types";

export interface WizardKeyInputParams {
  state: InteractiveState;
  setState: React.Dispatch<React.SetStateAction<InteractiveState>>;
  resetInput: (nextValue?: string) => void;
  exit: () => void;
  projects: Array<{ key: string; name: string }>;
  hasHarnessStep: boolean;
  orderedIssueTypes: string[];
  orderedHarnesses: Array<{ name: string; displayName: string }>;
  scrollViewRef: React.RefObject<ScrollViewRef | null>;
  session: WizardSession;
  handleEscape: () => void;
  handleEnter: () => void;
  stepBeforeHarnessRef: React.MutableRefObject<WizardStep | null>;
}

/**
 * Global key router for the wizard: Ctrl+C/P/G, preview scrolling, Esc/Enter,
 * number shortcuts, and y/n decisions. Active only outside text-entry steps so
 * `PromptInput` owns the keyboard there.
 */
export function useWizardKeyInput(params: WizardKeyInputParams): void {
  const {
    state,
    setState,
    resetInput,
    exit,
    projects,
    hasHarnessStep,
    orderedIssueTypes,
    orderedHarnesses,
    scrollViewRef,
    session,
    handleEscape,
    handleEnter,
    stepBeforeHarnessRef,
  } = params;

  useInput(
    // oxlint-disable-next-line complexity -- global key router couples to scroll refs and the outer promise resolvers; extract a `wizardReducer`/`useWizardKeyInput` state machine instead of splitting its branches.
    (inputChar, key) => {
      if (key.ctrl && inputChar === "c") {
        exit();
        return;
      }

      // Success screen - any key signals the orchestrator to start another task.
      // State reset is owned by handle.restart() so we never flash the wizard
      // before the create-another loop is ready to waitForCompletion again.
      if (state.step === "success") {
        if (session.restartPromiseResolve) {
          const resolveRestart = session.restartPromiseResolve;
          session.restartPromiseResolve = null;
          resolveRestart();
        }
        return;
      }

      // Ctrl+P to navigate to project selection (only if projects are available)
      if (key.ctrl && inputChar === "p" && projects.length > 0) {
        if (state.step !== "generating" && state.step !== "regenerating" && state.step !== "done") {
          setState((prev) => ({ ...prev, step: "project" }));
          resetInput();
          return;
        }
      }

      // Ctrl+G to navigate to harness selection (only if harnesses are available).
      // Ctrl+H was the original binding, but it collides with backspace (\b / 0x08)
      // in many terminal emulators and line disciplines, so the keypress was
      // swallowed before reaching Ink. Ctrl+G does not collide with common
      // terminal control characters.
      if (key.ctrl && inputChar === "g" && hasHarnessStep) {
        if (
          state.step !== "harness" &&
          state.step !== "generating" &&
          state.step !== "regenerating" &&
          state.step !== "done"
        ) {
          stepBeforeHarnessRef.current = state.step;
          setState((prev) => ({ ...prev, step: "harness" }));
          resetInput();
          return;
        }
      }

      // Handle scrolling in preview mode
      if (state.step === "preview") {
        if (key.upArrow) {
          scrollViewRef.current?.scrollBy(-1);
          return;
        }
        if (key.downArrow) {
          const ref = scrollViewRef.current;
          if (ref) {
            const currentOffset = ref.getScrollOffset();
            const bottomOffset = ref.getBottomOffset();
            if (currentOffset < bottomOffset) {
              ref.scrollBy(1);
            }
          }
          return;
        }
        if (key.pageUp) {
          const ref = scrollViewRef.current;
          if (ref) {
            const height = ref.getViewportHeight() || 1;
            ref.scrollBy(-height);
          }
          return;
        }
        if (key.pageDown) {
          const ref = scrollViewRef.current;
          if (ref) {
            const height = ref.getViewportHeight() || 1;
            const currentOffset = ref.getScrollOffset();
            const bottomOffset = ref.getBottomOffset();
            if (currentOffset < bottomOffset) {
              ref.scrollBy(Math.min(height, bottomOffset - currentOffset));
            }
          }
          return;
        }
      }

      if (key.escape) {
        handleEscape();
        return;
      }

      if (key.return) {
        handleEnter();
        return;
      }

      if (!key.ctrl && !key.meta && inputChar) {
        if (state.step === "source-type" && ["1", "2", "3"].includes(inputChar)) {
          const sourceType = inputChar === "1" ? "figma" : inputChar === "2" ? "log" : "prompt";
          setState((prev) => ({ ...prev, sourceType, step: "source-input" }));
          resetInput();
          return;
        }

        if (state.step === "issue-type") {
          const index = parseInt(inputChar) - 1;
          if (index >= 0 && index < orderedIssueTypes.length) {
            const issueType = orderedIssueTypes[index];
            if (issueType) {
              setState((prev) => ({ ...prev, issueType, step: "style" }));
              resetInput();
              return;
            }
          }
        }

        if (state.step === "harness") {
          const index = parseInt(inputChar) - 1;
          if (index >= 0 && index < orderedHarnesses.length) {
            const harness = orderedHarnesses[index];
            if (harness) {
              const target = stepBeforeHarnessRef.current ?? "style";
              stepBeforeHarnessRef.current = null;
              setState((prev) => ({ ...prev, harnessName: harness.name, step: target }));
              resetInput();
              return;
            }
          }
        }

        if (state.step === "style" && ["1", "2"].includes(inputChar)) {
          const promptStyle = inputChar === "1" ? "pm" : "technical";
          setState((prev) => ({
            ...prev,
            promptStyle,
            decompose: false,
            step: "confirm",
          }));
          resetInput();
          return;
        }

        if (state.step === "confirm" && ["y", "n"].includes(inputChar.toLowerCase())) {
          if (inputChar.toLowerCase() === "y") {
            setState((prev) => ({ ...prev, step: "generating" }));
            if (session.completePromiseResolve) {
              session.completed = true;
              session.completePromiseResolve(state);
            }
          } else {
            setState((prev) => ({ ...prev, step: "source-type" }));
            resetInput();
          }
          return;
        }

        if (state.step === "preview") {
          // Ignore action keys until preview content is available (avoids blank/stuck states).
          if (!state.previewData) {
            return;
          }
          if (inputChar.toLowerCase() === "e") {
            setState((prev) => ({ ...prev, step: "edit-prompt" }));
            resetInput();
            return;
          }
          if (["y", "n"].includes(inputChar.toLowerCase())) {
            if (inputChar.toLowerCase() === "y") {
              setState((prev) => ({ ...prev, step: "done" }));
              if (session.completePromiseResolve) {
                session.completed = true;
                session.completePromiseResolve(state);
              }
            } else {
              setState((prev) => ({
                ...prev,
                step: "source-type",
                previewData: undefined,
              }));
              resetInput();
            }
            return;
          }
        }
      }
    },
    { isActive: !TEXT_ENTRY_STEPS.has(state.step) },
  );
}
