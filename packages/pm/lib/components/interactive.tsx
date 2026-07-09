import React, { useState, useRef, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
import { getDefaultIssueType } from "../issue-types";

interface Task {
  summary: string;
  description: string;
  type: "Story" | "Task" | "Bug" | "Epic";
}

interface InteractiveState {
  step:
    | "project"
    | "source-type"
    | "source-input"
    | "custom"
    | "epic"
    | "style"
    | "issue-type"
    | "confirm"
    | "generating"
    | "preview"
    | "edit-prompt"
    | "regenerating"
    | "done"
    | "success";
  projectKey?: string;
  sourceType?: "figma" | "log" | "prompt";
  sourceContent?: string;
  customInstructions?: string;
  epicKey?: string;
  promptStyle: "pm" | "technical";
  issueType: string;
  decompose: boolean;
  tasks: Task[];
  previewData?: {
    summary: string;
    description: string;
  };
  editPrompt?: string;
  successMessage?: string;
  statusMessage?: string;
}

export interface InteractiveModeHandle {
  setGenerating: () => void;
  setStatusMessage: (message: string) => void;
  setPreviewData: (summary: string, description: string) => void;
  waitForCompletion: () => Promise<InteractiveState>;
  waitForEdit: () => Promise<{
    editPrompt: string;
    currentSummary: string;
    currentDescription: string;
  }>;
  showSuccess: (message: string) => void;
  waitForRestart: () => Promise<void>;
  restart: () => void;
  cleanup: () => void;
  getStep: () => InteractiveState["step"];
  getPreviewData: () => { summary: string; description: string } | undefined;
  /** Updates preview data without changing the current step. */
  updatePreviewData: (summary: string, description: string) => void;
}

export interface InteractiveModeOptions {
  projects?: Array<{ key: string; name: string }>;
  defaultProjectKey?: string;
  issueTypes?: string[];
  fetchIssueTypes?: (projectKey: string) => Promise<string[]>;
  backendName?: string;
  harnessDisplayName?: string;
  /**
   * Whether the selected tracker can persist an epic/parent link. When
   * `false`, the epic linking step is skipped. Defaults to `true` when omitted.
   */
  supportsEpicLinking?: boolean;
  stdin?: NodeJS.ReadStream;
}

const TEXT_ENTRY_STEPS = new Set<InteractiveState["step"]>([
  "project",
  "source-input",
  "custom",
  "epic",
  "edit-prompt",
]);

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
    let completed = false;
    let updateState: ((updates: Partial<InteractiveState>) => void) | null = null;
    let completePromiseResolve: ((config: InteractiveState) => void) | null = null;
    let editPromiseResolve:
      | ((data: { editPrompt: string; currentSummary: string; currentDescription: string }) => void)
      | null = null;
    let restartPromiseResolve: (() => void) | null = null;
    let currentStep: InteractiveState["step"] = "source-type";
    let visiblePreviewDataRef: { summary: string; description: string } | null = null;

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

    // First step after collecting custom instructions, accounting for skips.
    const stepAfterCustom = hasEpicStep ? "epic" : hasIssueTypeStep ? "issue-type" : "style";

    // Use provided issue types or default fallback
    const defaultIssueTypes =
      options?.issueTypes && options.issueTypes.length > 0
        ? options.issueTypes
        : ["Story", "Task", "Bug", "Epic"];

    /**
     * Root Ink component for the interactive task-creation wizard.
     *
     * @returns Full-screen wizard UI with step-specific prompts and preview panes.
     */
    const InteractiveFormWithPreview: React.FC = () => {
      const { exit } = useApp();
      const initialIssueType = getDefaultIssueType(defaultIssueTypes);
      const [state, setState] = useState<InteractiveState>({
        step: "source-type",
        projectKey: defaultProjectKey, // Start with default project
        promptStyle: "pm",
        issueType: initialIssueType,
        decompose: false,
        tasks: [],
      });
      const [input, setInput] = useState("");
      const [inputVersion, setInputVersion] = useState(0);
      const [issueTypes, setIssueTypes] = useState<string[]>(defaultIssueTypes);
      const orderedIssueTypes = (() => {
        const def = getDefaultIssueType(issueTypes);
        return [def, ...issueTypes.filter((t) => t !== def)];
      })();
      const [isLoadingIssueTypes, setIsLoadingIssueTypes] = useState(false);
      const scrollViewRef = useRef<ScrollViewRef>(null);
      const bufferedPreviewData = useRef<{ summary: string; description: string } | null>(null);
      const prevStepRef = useRef<InteractiveState["step"]>(state.step);
      const stateRef = useRef(state);
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
        if (
          prevStep === "edit-prompt" &&
          nextStep !== "edit-prompt" &&
          bufferedPreviewData.current
        ) {
          const buffered = bufferedPreviewData.current;
          bufferedPreviewData.current = null;
          setState((prev) => ({ ...prev, previewData: buffered }));
        }

        prevStepRef.current = nextStep;
      }, [state.step]);

      // Keep imperative refs in sync with state for external readers
      useEffect(() => {
        stateRef.current = state;
        currentStep = state.step;
        visiblePreviewDataRef = state.previewData ?? null;
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
        updateState = (updates) => {
          setState((prev) => {
            // Buffer previewData updates when user is actively editing so
            // the description preview is not rewritten mid-typing.
            if (updates.previewData && prev.step === "edit-prompt") {
              bufferedPreviewData.current = updates.previewData;
              const { previewData: _, ...rest } = updates;
              return { ...prev, ...rest };
            }
            return { ...prev, ...updates };
          });
        };
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
          if (!options?.fetchIssueTypes) {
            return;
          }

          setIsLoadingIssueTypes(true);
          try {
            const types = await options.fetchIssueTypes(state.projectKey);
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

      useInput(
        (inputChar, key) => {
          if (key.ctrl && inputChar === "c") {
            exit();
            return;
          }

          // Success screen - any key restarts
          if (state.step === "success") {
            setState({
              step: "source-type",
              projectKey: defaultProjectKey,
              promptStyle: "pm",
              issueType: getDefaultIssueType(defaultIssueTypes),
              decompose: false,
              tasks: [],
            });
            resetInput();
            // Resolve restart promise if waiting
            if (restartPromiseResolve) {
              restartPromiseResolve();
              restartPromiseResolve = null;
            }
            return;
          }

          // Ctrl+P to navigate to project selection (only if projects are available)
          if (key.ctrl && inputChar === "p" && projects.length > 0) {
            if (
              state.step !== "generating" &&
              state.step !== "regenerating" &&
              state.step !== "done"
            ) {
              setState((prev) => ({ ...prev, step: "project" }));
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
                if (completePromiseResolve) {
                  completed = true;
                  completePromiseResolve(stateRef.current);
                }
              } else {
                setState((prev) => ({ ...prev, step: "source-type" }));
                resetInput();
              }
              return;
            }

            if (state.step === "preview") {
              if (inputChar.toLowerCase() === "e") {
                setState((prev) => ({ ...prev, step: "edit-prompt" }));
                resetInput();
                return;
              }
              if (["y", "n"].includes(inputChar.toLowerCase())) {
                if (inputChar.toLowerCase() === "y") {
                  setState((prev) => ({ ...prev, step: "done" }));
                  if (completePromiseResolve) {
                    completed = true;
                    completePromiseResolve(stateRef.current);
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
            const currentPreview = visiblePreviewDataRef;
            if (trimmedInput) {
              setState((prev) => ({
                ...prev,
                editPrompt: trimmedInput,
                step: "regenerating",
              }));
              if (editPromiseResolve && currentPreview) {
                editPromiseResolve({
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

      /** Navigates to the previous wizard step when the user presses Escape. */
      const handleEscape = () => {
        switch (state.step) {
          case "source-type":
            // Can't go back from source-type, it's the first step
            break;
          case "project":
            resetInput();
            setState((prev) => ({ ...prev, step: "source-type" }));
            break;
          case "source-input":
            resetInput();
            setState((prev) => ({ ...prev, step: "source-type" }));
            break;
          case "custom":
            resetInput(state.sourceContent || "");
            setState((prev) => ({ ...prev, step: "source-input" }));
            break;
          case "epic":
            resetInput(state.customInstructions || "");
            setState((prev) => ({ ...prev, step: "custom" }));
            break;
          case "issue-type":
            if (hasEpicStep) {
              resetInput(state.epicKey || "");
              setState((prev) => ({ ...prev, step: "epic" }));
            } else {
              resetInput(state.customInstructions || "");
              setState((prev) => ({ ...prev, step: "custom" }));
            }
            break;
          case "style": {
            const back = hasIssueTypeStep ? "issue-type" : hasEpicStep ? "epic" : "custom";
            resetInput(back === "custom" ? state.customInstructions || "" : "");
            setState((prev) => ({ ...prev, step: back }));
            break;
          }
          case "confirm":
            resetInput();
            setState((prev) => ({ ...prev, step: "style" }));
            break;
          case "preview":
            break;
          case "edit-prompt":
            resetInput();
            setState((prev) => ({ ...prev, step: "preview" }));
            break;
        }
      };

      /** Handles Enter key on numeric/yes-no selection steps (non text-input steps). */
      const handleEnter = () => {
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
            if (["y", "n", ""].includes(trimmedInput.toLowerCase())) {
              if (trimmedInput.toLowerCase() === "y" || trimmedInput === "") {
                setState((prev) => ({ ...prev, step: "generating" }));
                if (completePromiseResolve) {
                  completed = true;
                  completePromiseResolve(stateRef.current);
                }
              } else {
                setState((prev) => ({ ...prev, step: "source-type" }));
                resetInput();
              }
            }
            break;

          case "preview":
            if (["y", "n", ""].includes(trimmedInput.toLowerCase())) {
              if (trimmedInput.toLowerCase() === "y" || trimmedInput === "") {
                setState((prev) => ({ ...prev, step: "done" }));
                if (completePromiseResolve) {
                  completed = true;
                  completePromiseResolve(stateRef.current);
                }
              } else {
                setState((prev) => ({
                  ...prev,
                  step: "source-type",
                  previewData: undefined,
                }));
                resetInput();
              }
            }
            break;
        }
      };

      const sharedPromptInputProps = {
        onEscape: handleEscape,
        onExit: exit,
      };

      /**
       * Renders the UI for the current wizard step.
       *
       * @returns Step-specific Ink layout, or null for hidden steps.
       */
      const renderStep = () => {
        switch (state.step) {
          case "project":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Select project:</Text>
                {projects.map((project, index) => (
                  <Text key={project.key}>
                    {index + 1}. {project.name} ({project.key})
                    {project.key === defaultProjectKey ? " (default)" : ""}
                  </Text>
                ))}
                {defaultProjectKey && (
                  <Text dimColor>
                    Press Enter to use default project, or type number and press Enter
                  </Text>
                )}
                <PromptInput
                  key={`${state.step}-${inputVersion}`}
                  initialValue={input}
                  onSubmit={handleTextSubmit}
                  marginTop={1}
                  {...sharedPromptInputProps}
                />
              </Box>
            );

          case "source-type":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Select source type:</Text>
                <Text>1. Figma design URL</Text>
                <Text>2. Error log / Bug report</Text>
                <Text>3. Free-form prompt</Text>
              </Box>
            );

          case "source-input": {
            const label =
              state.sourceType === "figma"
                ? "Enter Figma URL:"
                : state.sourceType === "log"
                  ? "Enter error log or bug description:"
                  : "Enter your requirements:";
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>{label}</Text>
                <PromptInput
                  key={`${state.step}-${inputVersion}`}
                  initialValue={input}
                  onSubmit={handleTextSubmit}
                  {...sharedPromptInputProps}
                />
              </Box>
            );
          }

          case "custom":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Custom instructions (optional, press Enter to skip):</Text>
                <Text dimColor>Additional requirements or focus areas</Text>
                <Text dimColor>Example: "Focus on accessibility" or "Prioritize performance"</Text>
                <PromptInput
                  key={`${state.step}-${inputVersion}`}
                  initialValue={input}
                  onSubmit={handleTextSubmit}
                  {...sharedPromptInputProps}
                />
              </Box>
            );

          case "epic":
            if (!hasEpicStep) return null;
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Epic key (optional, press Enter to skip):</Text>
                <Text dimColor>Example: PROJ-123</Text>
                <PromptInput
                  key={`${state.step}-${inputVersion}`}
                  initialValue={input}
                  onSubmit={handleTextSubmit}
                  {...sharedPromptInputProps}
                />
              </Box>
            );

          case "issue-type":
            if (!hasIssueTypeStep) return null;
            const defaultIssueType = orderedIssueTypes[0];
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>
                  Select issue type <Text dimColor>(Enter to accept default)</Text>:
                </Text>
                {orderedIssueTypes.map((type, index) => (
                  <Text key={type}>
                    {index + 1}. {type}
                    {type === defaultIssueType ? " (default)" : ""}
                  </Text>
                ))}
              </Box>
            );

          case "style":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Select prompt style:</Text>
                <Text>1. PM style (user stories, acceptance criteria)</Text>
                <Text>2. Technical style (includes technical considerations)</Text>
              </Box>
            );

          case "confirm": {
            const sourceLabel =
              state.sourceType === "figma"
                ? "URL"
                : state.sourceType === "log"
                  ? "Error Log"
                  : "Requirements";
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold color="green">
                  Review your configuration:
                </Text>
                <Box paddingLeft={2} flexDirection="column" paddingY={1}>
                  {state.projectKey && (
                    <Box flexDirection="column" paddingBottom={1}>
                      <Text bold>Project:</Text>
                      <Text color="cyan">{state.projectKey}</Text>
                    </Box>
                  )}

                  <Text bold>Source Type:</Text>
                  <Text color="cyan">{state.sourceType}</Text>

                  {state.sourceContent && (
                    <Box flexDirection="column" paddingTop={1}>
                      <Text bold>{sourceLabel}:</Text>
                      <Text color="cyan">{state.sourceContent}</Text>
                    </Box>
                  )}

                  {state.customInstructions && (
                    <Box flexDirection="column" paddingTop={1}>
                      <Text bold>Custom Instructions:</Text>
                      <Text color="cyan">{state.customInstructions}</Text>
                    </Box>
                  )}

                  {state.epicKey && (
                    <Box flexDirection="column" paddingTop={1}>
                      <Text bold>Epic:</Text>
                      <Text color="cyan">{state.epicKey}</Text>
                    </Box>
                  )}

                  {hasIssueTypeStep && (
                    <Box flexDirection="column" paddingTop={1}>
                      <Text bold>Issue Type:</Text>
                      <Text color="cyan">{state.issueType}</Text>
                    </Box>
                  )}

                  <Box flexDirection="column" paddingTop={1}>
                    <Text bold>Prompt Style:</Text>
                    <Text color="cyan">{state.promptStyle}</Text>
                  </Box>
                </Box>
                <Text bold>Continue? (Y/n)</Text>
              </Box>
            );
          }

          case "generating":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold color="cyan">
                  🤖 Generating task...
                </Text>
                <Text dimColor>
                  {state.statusMessage ?? "Running AI agent — this may take a few minutes"}
                </Text>
                <Text dimColor>Elapsed: {elapsedSeconds}s • Ctrl+C to cancel</Text>
              </Box>
            );

          case "preview": {
            if (!state.previewData) {
              return (
                <Box flexDirection="column" paddingY={1}>
                  <Text bold color="yellow">
                    Waiting for task preview...
                  </Text>
                </Box>
              );
            }
            return (
              <Box flexDirection="column" paddingY={1}>
                <Box paddingY={1} flexDirection="column">
                  <Text bold>📌 Title:</Text>
                  <Box paddingLeft={2}>
                    <Text color="green">{state.previewData.summary}</Text>
                  </Box>
                </Box>
                <Box flexDirection="column">
                  <Text bold>📝 Description:</Text>
                  <Text dimColor>(Use arrow keys ↑↓ to scroll, PgUp/PgDn for fast scroll)</Text>
                  <Box
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={1}
                    paddingY={1}
                    flexDirection="column"
                    height={25}
                  >
                    <ScrollView ref={scrollViewRef}>
                      <MarkdownText>{state.previewData.description}</MarkdownText>
                    </ScrollView>
                  </Box>
                </Box>
                <Box paddingTop={1}>
                  <Text bold>
                    Create this {state.issueType.toLowerCase()} in{" "}
                    {options?.backendName || "task tracker"}? (Y/n) • Press E to edit
                  </Text>
                </Box>
              </Box>
            );
          }

          case "edit-prompt":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Box paddingY={1} flexDirection="column">
                  <Text bold>📌 Title:</Text>
                  <Box paddingLeft={2}>
                    <Text color="green">{state.previewData?.summary}</Text>
                  </Box>
                </Box>
                <Box flexDirection="column">
                  <Text bold>📝 Current Description:</Text>
                  <Text dimColor>(Use arrow keys ↑↓ to scroll, PgUp/PgDn for fast scroll)</Text>
                  <Box
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={1}
                    paddingY={1}
                    flexDirection="column"
                    height={15}
                  >
                    <ScrollView ref={scrollViewRef}>
                      <MarkdownText>{state.previewData?.description || ""}</MarkdownText>
                    </ScrollView>
                  </Box>
                </Box>
                <Box paddingTop={1} flexDirection="column">
                  <Text bold color="cyan">
                    What would you like to change?
                  </Text>
                  <Text dimColor>
                    Example: "Add more details about error handling" or "Make it more concise"
                  </Text>
                  <PromptInput
                    key={`${state.step}-${inputVersion}`}
                    initialValue={input}
                    onSubmit={handleTextSubmit}
                    marginTop={1}
                    {...sharedPromptInputProps}
                    onScrollUp={() => scrollViewRef.current?.scrollBy(-1)}
                    onScrollDown={() => {
                      const ref = scrollViewRef.current;
                      if (!ref) return;
                      const currentOffset = ref.getScrollOffset();
                      const bottomOffset = ref.getBottomOffset();
                      if (currentOffset < bottomOffset) {
                        ref.scrollBy(1);
                      }
                    }}
                    onPageUp={() => {
                      const ref = scrollViewRef.current;
                      if (!ref) return;
                      ref.scrollBy(-(ref.getViewportHeight() || 1));
                    }}
                    onPageDown={() => {
                      const ref = scrollViewRef.current;
                      if (!ref) return;
                      const height = ref.getViewportHeight() || 1;
                      const currentOffset = ref.getScrollOffset();
                      const bottomOffset = ref.getBottomOffset();
                      if (currentOffset < bottomOffset) {
                        ref.scrollBy(Math.min(height, bottomOffset - currentOffset));
                      }
                    }}
                  />
                </Box>
              </Box>
            );

          case "regenerating":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold color="cyan">
                  🤖 Updating task description...
                </Text>
                <Text dimColor>
                  {state.statusMessage ?? "Running AI agent — this may take a few minutes"}
                </Text>
                <Text dimColor>Elapsed: {elapsedSeconds}s • Ctrl+C to cancel</Text>
              </Box>
            );

          case "done":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold color="green">
                  ✓ Ready to create!
                </Text>
                <Text dimColor>Creating task in {options?.backendName || "task tracker"}...</Text>
              </Box>
            );

          case "success":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
                  <Box flexDirection="column">
                    <Text bold color="green">
                      ✓ Success!
                    </Text>
                    {state.successMessage && <Text color="green">{state.successMessage}</Text>}
                  </Box>
                </Box>
                <Box paddingTop={1}>
                  <Text dimColor>Press any key to create another task...</Text>
                </Box>
              </Box>
            );

          default:
            return null;
        }
      };

      // Get current project display as "Tracker/Project" or just project key/name
      const currentProjectDisplay = (() => {
        const project = projects.find((p) => p.key === state.projectKey)?.name || state.projectKey;
        if (!project) return "N/A";
        return options?.backendName ? `${options.backendName}/${project}` : project;
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
              {projects.length > 0 && <Text dimColor> • Ctrl+P: Change Project</Text>}
            </Box>
            <Box flexDirection="row" gap={1}>
              <Text dimColor>Agent: </Text>
              <Text color="cyan">{options?.harnessDisplayName || "None"}</Text>
            </Box>
            <Text dimColor>ESC: Back • Ctrl+C: Exit</Text>
          </Box>
          {renderStep()}
        </Box>
      );
    };

    const { waitUntilExit, unmount } = render(
      <InteractiveFormWithPreview />,
      options?.stdin !== undefined ? { stdin: options.stdin } : undefined,
    );

    waitUntilExit().then(() => {
      if (!completed) {
        reject(new Error("Interactive mode cancelled"));
      }
    });

    /**
     * Waits until the user confirms configuration or accepts a generated preview.
     *
     * @returns Resolved interactive state when the user proceeds to generation or creation.
     */
    const waitForCompletion = (): Promise<InteractiveState> => {
      return new Promise((resolveComplete) => {
        completePromiseResolve = (config) => {
          // Don't unmount - keep UI running for preview
          resolveComplete(config);
        };
      });
    };

    /** Switches the wizard to the generating step while the agent runs. */
    const setGenerating = () => {
      if (updateState) {
        updateState({
          step: "generating",
          statusMessage: "Starting AI agent...",
        });
      }
    };

    /** Updates the status line shown on the generating/regenerating screen. */
    const setStatusMessage = (message: string) => {
      if (updateState) {
        updateState({ statusMessage: message });
      }
    };

    /**
     * Populates the preview pane with generated task title and description.
     *
     * @param summary - Generated issue title.
     * @param description - Generated issue body (markdown).
     */
    const setPreviewData = (summary: string, description: string) => {
      if (updateState) {
        updateState({ previewData: { summary, description }, step: "preview" });
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
      if (updateState) {
        updateState({ previewData: { summary, description } });
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
      return new Promise((resolveEdit) => {
        editPromiseResolve = resolveEdit;
      });
    };

    /**
     * Displays the success screen with a completion message.
     *
     * @param message - Success text shown after task creation.
     */
    const showSuccess = (message: string) => {
      if (updateState) {
        updateState({ successMessage: message, step: "success" });
      }
    };

    /**
     * Waits until the user presses any key on the success screen to start another task.
     *
     * @returns Resolves when the user requests a new wizard run.
     */
    const waitForRestart = (): Promise<void> => {
      return new Promise((resolveRestart) => {
        restartPromiseResolve = resolveRestart;
      });
    };

    /** Resets wizard state to the first step without unmounting the Ink tree. */
    const restart = () => {
      if (updateState) {
        updateState({
          step: "source-type",
          projectKey: defaultProjectKey, // Reset to default project
          sourceType: undefined,
          sourceContent: undefined,
          customInstructions: undefined,
          epicKey: undefined,
          previewData: undefined,
          successMessage: undefined,
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
      getStep: () => currentStep,
      getPreviewData: () => visiblePreviewDataRef ?? undefined,
      /** Unmounts the Ink interactive form and releases terminal control. */
      cleanup: () => {
        unmount();
      },
    });
  });
}
