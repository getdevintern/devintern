/**
 * Shared types for the interactive PM wizard.
 *
 * Kept dependency-free (no React, no Ink) so the controller, navigation map,
 * step renderers, and hooks can all import from here without cycles.
 */

export interface Task {
  summary: string;
  description: string;
  type: "Story" | "Task" | "Bug" | "Epic";
}

export interface InteractiveState {
  step:
    | "project"
    | "source-type"
    | "source-input"
    | "custom"
    | "epic"
    | "style"
    | "issue-type"
    | "harness"
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
  harnessName?: string;
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
  /** Current harness name selected in the wizard (if any). */
  getHarnessName: () => string | undefined;
  /** Updates preview data without changing the current step. */
  updatePreviewData: (summary: string, description: string) => void;
}

export interface InteractiveModeOptions {
  projects?: Array<{ key: string; name: string }>;
  defaultProjectKey?: string;
  issueTypes?: string[];
  fetchIssueTypes?: (projectKey: string) => Promise<string[]>;
  backendName?: string;
  /** @deprecated Prefer `harnesses` + `currentHarnessName` for on-the-fly switching. */
  harnessDisplayName?: string;
  /** Installed harnesses offered in the Ctrl+G picker. */
  harnesses?: Array<{ name: string; displayName: string }>;
  /** Active harness name at wizard start. */
  currentHarnessName?: string;
  /**
   * Whether the selected tracker can persist an epic/parent link. When
   * `false`, the epic linking step is skipped. Defaults to `true` when omitted.
   */
  supportsEpicLinking?: boolean;
  stdin?: NodeJS.ReadStream;
}

export type WizardStep = InteractiveState["step"];

export interface StepNavFlags {
  hasEpicStep: boolean;
  hasIssueTypeStep: boolean;
}

export interface EditRequest {
  editPrompt: string;
  currentSummary: string;
  currentDescription: string;
}

export const TEXT_ENTRY_STEPS = new Set<WizardStep>([
  "project",
  "source-input",
  "custom",
  "epic",
  "edit-prompt",
]);

/**
 * Mutable bridge between the orchestrator (`runInteractiveMode`) and the Ink
 * form. The form writes `updateState` / `currentStep` / preview / harness state;
 * the orchestrator installs the promise resolvers the form invokes.
 */
export interface WizardSession {
  completed: boolean;
  updateState: ((updates: Partial<InteractiveState>) => void) | null;
  completePromiseResolve: ((config: InteractiveState) => void) | null;
  editPromiseResolve: ((data: EditRequest) => void) | null;
  restartPromiseResolve: (() => void) | null;
  currentStep: WizardStep;
  visiblePreviewData: { summary: string; description: string } | null;
  currentHarnessName: string | undefined;
}

/** Immutable per-run configuration derived from {@link InteractiveModeOptions}. */
export interface WizardConfig {
  projects: Array<{ key: string; name: string }>;
  defaultProjectKey?: string;
  hasIssueTypeStep: boolean;
  hasEpicStep: boolean;
  allHarnesses: Array<{ name: string; displayName: string }>;
  orderedHarnesses: Array<{ name: string; displayName: string }>;
  hasHarnessStep: boolean;
  stepAfterCustom: WizardStep;
  defaultIssueTypes: string[];
  currentHarnessName?: string;
  backendName?: string;
  harnessDisplayName?: string;
  fetchIssueTypes?: (projectKey: string) => Promise<string[]>;
}
