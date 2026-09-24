import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import type { ScrollViewRef } from "ink-scroll-view";
import { getDefaultIssueType, orderIssueTypes } from "../issue-types";
import { uiSymbols } from "../runtime/terminal.js";
import { canNavigateBack } from "./interactive-navigation";
import { renderStep } from "./interactive-steps";
import type { InteractiveState, WizardConfig, WizardSession } from "./interactive-types";
import { useWizardActions } from "./use-wizard-actions";
import { useWizardKeyInput } from "./use-wizard-key-input";

export interface InteractiveFormProps {
  session: WizardSession;
  config: WizardConfig;
}

/**
 * Root Ink component for the interactive task-creation wizard.
 *
 * Owns local UI state and effects, wires the action/key hooks, and renders the
 * step-specific layout. The orchestrator drives it through {@link WizardSession}.
 */
export function InteractiveFormWithPreview({ session, config }: InteractiveFormProps) {
  const {
    projects,
    defaultProjectKey,
    hasEpicStep,
    hasIssueTypeStep,
    allHarnesses,
    orderedHarnesses,
    hasHarnessStep,
    stepAfterCustom,
    defaultIssueTypes,
    currentHarnessName,
    backendName,
    harnessDisplayName,
    fetchIssueTypes,
  } = config;

  const { exit } = useApp();
  const initialIssueType = getDefaultIssueType(defaultIssueTypes);
  const [state, setState] = useState<InteractiveState>({
    step: "source-type",
    projectKey: defaultProjectKey, // Start with default project
    promptStyle: "pm",
    issueType: initialIssueType,
    harnessName: currentHarnessName,
    decompose: false,
    tasks: [],
  });
  const [input, setInput] = useState("");
  const [inputVersion, setInputVersion] = useState(0);
  const [issueTypes, setIssueTypes] = useState<string[]>(defaultIssueTypes);
  const orderedIssueTypes = orderIssueTypes(issueTypes);
  const [, setIsLoadingIssueTypes] = useState(false);
  const scrollViewRef = useRef<ScrollViewRef>(null);
  const sym = uiSymbols();
  const bufferedPreviewData = useRef<{ summary: string; description: string } | null>(null);
  const prevStepRef = useRef<InteractiveState["step"]>(state.step);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const generatingStartedAt = useRef<number | null>(null);

  // Cache for issue types per project
  const issueTypesCache = useRef<Map<string, string[]>>(new Map());

  /**
   * Resets the text input field and bumps the key to remount ink-text-input.
   *
   * @param nextValue - Value to seed into the input after reset (default empty string).
   */
  const resetInput = (nextValue = "") => {
    setInput(nextValue);
    setInputVersion((version) => version + 1);
  };

  // Initialize cache with default project's issue types if available
  React.useEffect(() => {
    if (defaultProjectKey && defaultIssueTypes.length > 0) {
      issueTypesCache.current.set(defaultProjectKey, defaultIssueTypes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply buffered previewData when leaving edit-prompt for any other step,
  // and clear any stale buffer when entering edit-prompt.
  React.useEffect(() => {
    const prevStep = prevStepRef.current;
    const nextStep = state.step;

    if (prevStep !== "edit-prompt" && nextStep === "edit-prompt") {
      bufferedPreviewData.current = null;
    }

    // Apply buffered previewData on any transition out of edit-prompt so
    // updates are not lost when the orchestrator transitions through
    // intermediate states before reaching preview.
    if (prevStep === "edit-prompt" && nextStep !== "edit-prompt" && bufferedPreviewData.current) {
      const buffered = bufferedPreviewData.current;
      bufferedPreviewData.current = null;
      setState((prev) => ({ ...prev, previewData: buffered }));
    }

    prevStepRef.current = nextStep;
  }, [state.step]);

  // If a skipped step is ever set (stale state / future callers), redirect
  // to a reachable step so renderStep never shows an empty body.
  React.useEffect(() => {
    if (state.step === "epic" && !hasEpicStep) {
      setState((prev) => ({
        ...prev,
        step: hasIssueTypeStep ? "issue-type" : "style",
      }));
      return;
    }
    if (state.step === "issue-type" && !hasIssueTypeStep) {
      setState((prev) => ({ ...prev, step: "style" }));
    }
    // hasEpicStep / hasIssueTypeStep are fixed for the form lifetime (closure
    // constants from options), so they are not valid React dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step]);

  // Keep the orchestrator-visible session fields in sync with state.
  useEffect(() => {
    session.currentStep = state.step;
    session.visiblePreviewData = state.previewData ?? null;
    session.currentHarnessName = state.harnessName;
  });

  useEffect(() => {
    if (state.step === "generating" || state.step === "regenerating") {
      generatingStartedAt.current = Date.now();
      setElapsedSeconds(0);
      const interval = setInterval(() => {
        if (generatingStartedAt.current !== null) {
          setElapsedSeconds(Math.floor((Date.now() - generatingStartedAt.current) / 1000));
        }
      }, 1000);
      return () => clearInterval(interval);
    }
    generatingStartedAt.current = null;
  }, [state.step]);

  // Expose setState to parent
  React.useEffect(() => {
    session.updateState = (updates) => {
      setState((prev) => {
        // Buffer previewData updates when user is actively editing so
        // the description preview is not rewritten mid-typing. When the
        // same update also moves the step away from edit-prompt, apply it
        // atomically instead — buffering it just to re-apply one render
        // later would flash the stale preview for a frame.
        const staysInEditPrompt = (updates.step ?? prev.step) === "edit-prompt";
        if (updates.previewData && prev.step === "edit-prompt" && staysInEditPrompt) {
          bufferedPreviewData.current = updates.previewData;
          const { previewData: _, ...rest } = updates;
          return { ...prev, ...rest };
        }
        return { ...prev, ...updates };
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch issue types when project changes
  React.useEffect(() => {
    /**
     * Loads issue types for the selected project from cache or the backend fetcher.
     */
    const fetchTypesForProject = async () => {
      if (!state.projectKey) {
        return;
      }

      // Check if we have cached issue types for this project
      const cached = issueTypesCache.current.get(state.projectKey);
      if (cached && cached.length > 0) {
        setIssueTypes(cached);
        // Reset issue type to the best default if current is not available
        if (!cached.includes(state.issueType)) {
          setState((prev) => ({
            ...prev,
            issueType: getDefaultIssueType(cached),
          }));
        }
        return;
      }

      // No cache hit - fetch from API if fetcher is available
      if (!fetchIssueTypes) {
        return;
      }

      setIsLoadingIssueTypes(true);
      try {
        const types = await fetchIssueTypes(state.projectKey);
        if (types.length > 0) {
          // Cache the fetched types
          issueTypesCache.current.set(state.projectKey, types);
          setIssueTypes(types);
          // Reset issue type to the best default if current is not available
          if (!types.includes(state.issueType)) {
            setState((prev) => ({
              ...prev,
              issueType: getDefaultIssueType(types),
            }));
          }
        }
      } catch {
        // Silently fall back to default issue types on error
        setIssueTypes(defaultIssueTypes);
      } finally {
        setIsLoadingIssueTypes(false);
      }
    };

    fetchTypesForProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.projectKey, state.issueType]);

  const {
    navFlags,
    handleTextSubmit,
    handleEscape,
    handleEnter,
    sharedPromptInputProps,
    stepBeforeHarnessRef,
  } = useWizardActions({
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
  });

  useWizardKeyInput({
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
  });

  // Get current project display as "Tracker/Project" or just project key/name
  const currentProjectDisplay = (() => {
    const project = projects.find((p) => p.key === state.projectKey)?.name || state.projectKey;
    if (!project) return "N/A";
    return backendName ? `${backendName}/${project}` : project;
  })();

  // Get current harness display name from state. Only show the
  // displayName when the selected harness is still in the registry; if it
  // was removed mid-run, fall back to the startup display name
  // (harnessDisplayName || "None") and never leaks the raw harnessName string.
  const currentHarnessDisplay = (() => {
    const harness = allHarnesses.find((h) => h.name === state.harnessName);
    return harness?.displayName || harnessDisplayName || "None";
  })();

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          📋 @devintern/pm - Interactive Mode
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Project: </Text>
          <Text color="cyan">{currentProjectDisplay}</Text>
          {projects.length > 0 && <Text dimColor>{sym.sep}Ctrl+P: Change Project</Text>}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Agent: </Text>
          <Text color="cyan">{currentHarnessDisplay}</Text>
          {hasHarnessStep && <Text dimColor>{sym.sep}Ctrl+G: Change Agent</Text>}
        </Box>
        <Text dimColor>
          {canNavigateBack(state.step, navFlags) || state.step === "harness"
            ? `ESC: Back${sym.sep}`
            : ""}
          {state.step === "success"
            ? `Any key: New task${sym.sep}Ctrl+C: Exit`
            : state.step === "preview"
              ? `Y: Create${sym.sep}N: Discard${sym.sep}E: Edit${sym.sep}Ctrl+C: Exit`
              : state.step === "generating" || state.step === "regenerating"
                ? "Ctrl+C: Cancel"
                : "Ctrl+C: Exit"}
        </Text>
      </Box>
      {renderStep({
        state,
        input,
        inputVersion,
        sym,
        scrollViewRef,
        projects,
        defaultProjectKey,
        orderedIssueTypes,
        orderedHarnesses,
        allHarnesses,
        hasEpicStep,
        hasIssueTypeStep,
        backendName,
        elapsedSeconds,
        sharedPromptInputProps,
        handleTextSubmit,
      })}
    </Box>
  );
}
