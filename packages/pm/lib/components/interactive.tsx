import React, { useState, useRef, useEffect, useReducer, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
import { TicketSidebar } from "./TicketSidebar";
import { NoTicketsEmptyState } from "./NoTicketsEmptyState";
import { getDefaultIssueType, orderIssueTypes } from "../issue-types";
import { uiSymbols } from "../runtime/terminal.js";
import {
  createInitialWizard,
  getActiveTicket,
  getTicket,
  initialTicketWorkspacesState,
  isTicketBusy,
  nextTicketId,
  ticketWorkspacesReducer,
} from "../ticket-workspaces.ts";
import type { TicketWizardState, TicketWorkspacesState, WizardStep } from "../ticket-workspaces.ts";

/** Wizard + ticket fields exposed to the CLI orchestrator. */
export type InteractiveState = TicketWizardState;

/**
 * User-driven actions from any open ticket. The orchestrator listens with
 * `waitForAction` so multiple tickets can generate concurrently.
 */
export type InteractiveTicketAction =
  | { type: "generate"; ticketId: string; config: InteractiveState }
  | { type: "create"; ticketId: string; config: InteractiveState }
  | {
      type: "edit";
      ticketId: string;
      editPrompt: string;
      currentSummary: string;
      currentDescription: string;
    }
  | { type: "restart"; ticketId: string };

export interface InteractiveModeHandle {
  /** Primary multi-ticket API: next user action on any open ticket. */
  waitForAction: () => Promise<InteractiveTicketAction>;
  /**
   * @deprecated Prefer waitForAction. Resolves on generate or create confirm
   * for any ticket (tests / single-ticket paths).
   */
  waitForCompletion: () => Promise<InteractiveState>;
  /**
   * @deprecated Prefer waitForAction. Resolves when the user submits an edit
   * prompt on any ticket.
   */
  waitForEdit: () => Promise<{
    editPrompt: string;
    currentSummary: string;
    currentDescription: string;
    ticketId: string;
  }>;
  /**
   * @deprecated Prefer waitForAction. Resolves when the user restarts a ticket
   * after success.
   */
  waitForRestart: () => Promise<{ ticketId: string }>;

  setGenerating: (ticketId?: string) => void;
  setStatusMessage: (message: string, ticketId?: string) => void;
  setPreviewData: (summary: string, description: string, ticketId?: string) => void;
  updatePreviewData: (summary: string, description: string, ticketId?: string) => void;
  showSuccess: (message: string, options?: { ticketId?: string; createdKey?: string }) => void;
  restart: (ticketId?: string) => void;
  cleanup: () => void;
  getStep: () => WizardStep;
  getPreviewData: () => { summary: string; description: string } | undefined;
  /** Current harness selected for the active ticket. */
  getHarnessName: () => string | undefined;
  getActiveTicketId: () => string | null;
  /** Snapshot of open workspaces (tests / debugging / orchestrator). */
  getWorkspaces: () => TicketWorkspacesState;
  /** Open a new ticket workspace and focus it. */
  openTicket: () => string;
  /** Close a ticket (busy tickets still close; UI may confirm first via keyboard). */
  closeTicket: (id: string) => void;
  /** Switch the active ticket without cancelling background work. */
  activateTicket: (id: string) => void;
}

export interface InteractiveModeOptions {
  projects?: Array<{ key: string; name: string }>;
  defaultProjectKey?: string;
  issueTypes?: string[];
  fetchIssueTypes?: (projectKey: string) => Promise<string[]>;
  backendName?: string;
  /** @deprecated Prefer `harnesses` + `currentHarnessName`. */
  harnessDisplayName?: string;
  harnesses?: Array<{ name: string; displayName: string }>;
  currentHarnessName?: string;
  /**
   * Whether the selected tracker can persist an epic/parent link. When
   * `false`, the epic linking step is skipped. Defaults to `true` when omitted.
   */
  supportsEpicLinking?: boolean;
  stdin?: NodeJS.ReadStream;
}

const TEXT_ENTRY_STEPS = new Set<WizardStep>([
  "project",
  "source-input",
  "custom",
  "epic",
  "edit-prompt",
]);

interface StepNavFlags {
  hasEpicStep: boolean;
  hasIssueTypeStep: boolean;
}

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
    case "edit-prompt":
      return "preview";
    case "harness":
      return null;
    // Preview stays put: orchestrator holds waitForAction race.
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

/**
 * Launches the multi-ticket Ink interactive shell for creating PM tasks.
 *
 * Renders a sidebar of open ticket workspaces plus the active ticket's wizard,
 * exposes imperative hooks for generation/preview/edit flows, and supports
 * concurrent agent runs across tickets.
 *
 * @param options - Optional projects, issue types, fetcher, and backend display name.
 * @returns Handle with methods to drive generation, preview, edit, and multi-ticket actions.
 */
export async function runInteractiveMode(
  options?: InteractiveModeOptions,
): Promise<InteractiveModeHandle> {
  return new Promise((resolve, reject) => {
    let completed = false;
    let cancelled = false;

    type DispatchFn = (action: Parameters<typeof ticketWorkspacesReducer>[1]) => void;
    let dispatchRef: DispatchFn | null = null;
    let openTicketFn: (() => string) | null = null;
    let closeTicketFn: ((id: string) => void) | null = null;
    let activateTicketFn: ((id: string) => void) | null = null;
    /**
     * Immediate workspace snapshot for the orchestrator (ticket still open?).
     * Updated on every dispatch so background agent completions see closes promptly.
     */
    let workspacesRef: TicketWorkspacesState = initialTicketWorkspacesState;
    /**
     * Post-commit snapshot for getStep/getPreviewData. Updated only after React
     * applies state so tests waiting on getStep() are synchronized with useInput
     * handlers that close over the last render.
     */
    let publishedWorkspaces: TicketWorkspacesState = initialTicketWorkspacesState;
    /** Preview updates deferred while a ticket is on the edit-prompt step. */
    const previewBuffer = new Map<string, { summary: string; description: string }>();
    /** Patches queued before the Ink tree mounts and registers dispatch. */
    const pendingUpdates: Array<{
      ticketId: string;
      updates: Partial<TicketWizardState>;
    }> = [];

    const actionQueue: InteractiveTicketAction[] = [];
    let actionWaiter: ((action: InteractiveTicketAction) => void) | null = null;

    let completePromiseResolve: ((config: InteractiveState) => void) | null = null;
    let completePromiseReject: ((error: Error) => void) | null = null;
    let editPromiseResolve:
      | ((data: {
          editPrompt: string;
          currentSummary: string;
          currentDescription: string;
          ticketId: string;
        }) => void)
      | null = null;
    let editPromiseReject: ((error: Error) => void) | null = null;
    let restartPromiseResolve: ((data: { ticketId: string }) => void) | null = null;
    let restartPromiseReject: ((error: Error) => void) | null = null;

    const cancelError = () => new Error("Interactive mode cancelled");

    /** Rejects any pending orchestrator waiters when the Ink app unmounts (e.g. Ctrl+C). */
    const rejectPendingWaiters = () => {
      cancelled = true;
      const error = cancelError();
      actionWaiter = null;
      actionQueue.length = 0;
      if (completePromiseReject) {
        completePromiseReject(error);
        completePromiseReject = null;
        completePromiseResolve = null;
      }
      if (editPromiseReject) {
        editPromiseReject(error);
        editPromiseReject = null;
        editPromiseResolve = null;
      }
      if (restartPromiseReject) {
        restartPromiseReject(error);
        restartPromiseReject = null;
        restartPromiseResolve = null;
      }
    };

    const emitAction = (action: InteractiveTicketAction) => {
      if (cancelled) return;
      if (actionWaiter) {
        const resolveAction = actionWaiter;
        actionWaiter = null;
        resolveAction(action);
      } else {
        actionQueue.push(action);
      }

      if (action.type === "generate" || action.type === "create") {
        if (completePromiseResolve) {
          const resolveComplete = completePromiseResolve;
          completePromiseResolve = null;
          completePromiseReject = null;
          resolveComplete(action.config);
        }
      } else if (action.type === "edit") {
        if (editPromiseResolve) {
          const resolveEdit = editPromiseResolve;
          editPromiseResolve = null;
          editPromiseReject = null;
          resolveEdit({
            editPrompt: action.editPrompt,
            currentSummary: action.currentSummary,
            currentDescription: action.currentDescription,
            ticketId: action.ticketId,
          });
        }
      } else if (action.type === "restart") {
        if (restartPromiseResolve) {
          const resolveRestart = restartPromiseResolve;
          restartPromiseResolve = null;
          restartPromiseReject = null;
          resolveRestart({ ticketId: action.ticketId });
        }
      }
    };

    const resolveTicketId = (ticketId?: string): string | null => {
      if (ticketId) {
        return getTicket(workspacesRef, ticketId) ? ticketId : null;
      }
      return workspacesRef.activeTicketId;
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

    const hasIssueTypeStep = options?.issueTypes !== undefined;
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
    const stepAfterCustom = hasEpicStep ? "epic" : hasIssueTypeStep ? "issue-type" : "style";

    const defaultIssueTypes =
      options?.issueTypes && options.issueTypes.length > 0
        ? options.issueTypes
        : ["Story", "Task", "Bug", "Epic"];

    const makeFreshWizard = (): TicketWizardState =>
      createInitialWizard({
        projectKey: defaultProjectKey,
        issueType: getDefaultIssueType(defaultIssueTypes),
        harnessName: currentHarnessName,
      });

    // Seed one ticket synchronously so single-ticket use and getStep() work before paint.
    const seededWorkspaces = ticketWorkspacesReducer(initialTicketWorkspacesState, {
      type: "session-started",
      id: nextTicketId(),
      wizard: makeFreshWizard(),
    });
    workspacesRef = seededWorkspaces;
    publishedWorkspaces = seededWorkspaces;

    /**
     * Root Ink component: multi-ticket sidebar + active ticket wizard.
     */
    const InteractiveShell: React.FC = () => {
      const { exit } = useApp();
      const { stdout } = useStdout();
      const terminalWidth = stdout?.columns ?? 80;

      const [workspaces, reactDispatch] = useReducer(ticketWorkspacesReducer, seededWorkspaces);
      /** Keeps workspacesRef in lockstep with every UI and imperative update. */
      const dispatch = useCallback((action: Parameters<typeof ticketWorkspacesReducer>[1]) => {
        workspacesRef = ticketWorkspacesReducer(workspacesRef, action);
        reactDispatch(action);
      }, []);
      const [inputVersion, setInputVersion] = useState(0);
      const [issueTypes, setIssueTypes] = useState<string[]>(defaultIssueTypes);
      const orderedIssueTypes = orderIssueTypes(issueTypes);
      const [isLoadingIssueTypes, setIsLoadingIssueTypes] = useState(false);
      const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
      const scrollViewRef = useRef<ScrollViewRef>(null);
      const sym = uiSymbols();
      const prevStepByTicket = useRef<Map<string, WizardStep>>(new Map());
      const prevActiveIdRef = useRef<string | null>(seededWorkspaces.activeTicketId);
      const [elapsedSeconds, setElapsedSeconds] = useState(0);
      const generatingStartedAt = useRef<number | null>(null);
      const issueTypesCache = useRef<Map<string, string[]>>(new Map());
      const stepBeforeHarness = useRef<Map<string, WizardStep>>(new Map());

      const activeTicket = getActiveTicket(workspaces);
      const activeWizard = activeTicket?.wizard;
      const activeStep = activeWizard?.step;

      // Register dispatch; publish committed state for getStep/getPreviewData;
      // flush pre-mount patches once.
      useEffect(() => {
        dispatchRef = dispatch;
        publishedWorkspaces = workspaces;
        if (pendingUpdates.length > 0) {
          const queued = pendingUpdates.splice(0, pendingUpdates.length);
          for (const item of queued) {
            // Snapshot already has these patches; only push into React.
            reactDispatch({
              type: "wizard-patched",
              id: item.ticketId,
              patch: item.updates,
            });
          }
        }
      }, [dispatch, reactDispatch, workspaces]);

      useEffect(() => {
        if (defaultProjectKey && defaultIssueTypes.length > 0) {
          issueTypesCache.current.set(defaultProjectKey, defaultIssueTypes);
        }
      }, []);

      // Remount text inputs when switching tickets so draftInput seeds correctly
      useEffect(() => {
        if (activeTicket?.id !== prevActiveIdRef.current) {
          prevActiveIdRef.current = activeTicket?.id ?? null;
          setInputVersion((v) => v + 1);
        }
      }, [activeTicket?.id]);

      // Apply buffered previewData when any ticket leaves edit-prompt (e.g. Esc).
      useEffect(() => {
        for (const ticket of workspaces.tickets) {
          const prevStep = prevStepByTicket.current.get(ticket.id);
          const nextStep = ticket.wizard.step;

          if (prevStep === "edit-prompt" && nextStep !== "edit-prompt") {
            const buffered = previewBuffer.get(ticket.id);
            if (buffered) {
              previewBuffer.delete(ticket.id);
              if (
                ticket.wizard.previewData?.summary !== buffered.summary ||
                ticket.wizard.previewData?.description !== buffered.description
              ) {
                dispatch({
                  type: "wizard-patched",
                  id: ticket.id,
                  patch: { previewData: buffered },
                });
              }
            }
          }

          prevStepByTicket.current.set(ticket.id, nextStep);
        }
      }, [dispatch, workspaces.tickets]);

      // Redirect skipped steps
      useEffect(() => {
        if (!activeTicket || !activeWizard) return;
        if (activeWizard.step === "epic" && !hasEpicStep) {
          dispatch({
            type: "wizard-patched",
            id: activeTicket.id,
            patch: { step: hasIssueTypeStep ? "issue-type" : "style" },
          });
          return;
        }
        if (activeWizard.step === "issue-type" && !hasIssueTypeStep) {
          dispatch({
            type: "wizard-patched",
            id: activeTicket.id,
            patch: { step: "style" },
          });
        }
      }, [activeTicket, activeWizard, dispatch]);

      // Elapsed timer for generating steps on the active ticket
      useEffect(() => {
        if (activeStep === "generating" || activeStep === "regenerating") {
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
      }, [activeStep, activeTicket?.id]);

      // Fetch issue types when active ticket project changes
      useEffect(() => {
        const projectKey = activeWizard?.projectKey;
        if (!projectKey || !activeTicket) return;

        const fetchTypesForProject = async () => {
          const cached = issueTypesCache.current.get(projectKey);
          if (cached && cached.length > 0) {
            setIssueTypes(cached);
            if (!cached.includes(activeWizard.issueType)) {
              dispatch({
                type: "wizard-patched",
                id: activeTicket.id,
                patch: { issueType: getDefaultIssueType(cached) },
              });
            }
            return;
          }

          if (!options?.fetchIssueTypes) return;

          setIsLoadingIssueTypes(true);
          try {
            const types = await options.fetchIssueTypes(projectKey);
            if (types.length > 0) {
              issueTypesCache.current.set(projectKey, types);
              setIssueTypes(types);
              if (!types.includes(activeWizard.issueType)) {
                dispatch({
                  type: "wizard-patched",
                  id: activeTicket.id,
                  patch: { issueType: getDefaultIssueType(types) },
                });
              }
            }
          } catch {
            setIssueTypes(defaultIssueTypes);
          } finally {
            setIsLoadingIssueTypes(false);
          }
        };

        void fetchTypesForProject();
      }, [activeTicket, activeWizard, dispatch]);

      const openTicket = useCallback((): string => {
        const id = nextTicketId();
        dispatch({
          type: "ticket-opened",
          id,
          wizard: makeFreshWizard(),
        });
        setCloseConfirmId(null);
        setInputVersion((v) => v + 1);
        return id;
      }, [dispatch]);

      const closeTicket = useCallback(
        (id: string) => {
          dispatch({ type: "ticket-closed", id });
          setCloseConfirmId(null);
          setInputVersion((v) => v + 1);
        },
        [dispatch],
      );

      const requestCloseTicket = useCallback(
        (id: string) => {
          const ticket = getTicket(workspaces, id);
          if (!ticket) return;
          if (isTicketBusy(ticket.wizard.step)) {
            setCloseConfirmId(id);
            return;
          }
          closeTicket(id);
        },
        [workspaces, closeTicket],
      );

      const activateTicket = useCallback(
        (id: string) => {
          dispatch({ type: "ticket-activated", id });
          setCloseConfirmId(null);
          setInputVersion((v) => v + 1);
        },
        [dispatch],
      );

      // Expose open/close/activate to the imperative handle
      useEffect(() => {
        openTicketFn = openTicket;
        closeTicketFn = closeTicket;
        activateTicketFn = activateTicket;
      }, [openTicket, closeTicket, activateTicket]);

      const switchTicketByOffset = useCallback(
        (offset: number) => {
          if (workspaces.tickets.length === 0) return;
          const currentIndex = workspaces.tickets.findIndex(
            (t) => t.id === workspaces.activeTicketId,
          );
          const base = currentIndex < 0 ? 0 : currentIndex;
          const next = (base + offset + workspaces.tickets.length) % workspaces.tickets.length;
          const nextTicket = workspaces.tickets[next];
          if (nextTicket) activateTicket(nextTicket.id);
        },
        [workspaces, activateTicket],
      );

      const patchActive = useCallback(
        (patch: Partial<TicketWizardState>) => {
          if (!activeTicket) return;
          dispatch({ type: "wizard-patched", id: activeTicket.id, patch });
        },
        [activeTicket, dispatch],
      );

      // Global multi-ticket shortcuts (always active, including during text entry)
      useInput((inputChar, key) => {
        if (key.ctrl && inputChar === "c") {
          exit();
          return;
        }

        // Close confirmation dialog
        if (closeConfirmId) {
          if (inputChar.toLowerCase() === "y" || key.return) {
            closeTicket(closeConfirmId);
            return;
          }
          if (inputChar.toLowerCase() === "n" || key.escape) {
            setCloseConfirmId(null);
            return;
          }
          return;
        }

        // Ctrl+N — open new ticket
        if (key.ctrl && inputChar === "n") {
          openTicket();
          return;
        }

        // Ctrl+W — close active ticket
        if (key.ctrl && inputChar === "w") {
          if (activeTicket) {
            requestCloseTicket(activeTicket.id);
          }
          return;
        }

        // Ctrl+↑ / Ctrl+↓ — switch tickets
        if (key.ctrl && key.upArrow) {
          switchTicketByOffset(-1);
          return;
        }
        if (key.ctrl && key.downArrow) {
          switchTicketByOffset(1);
          return;
        }

        // Ctrl+1..9 — select ticket by index
        if (key.ctrl && inputChar >= "1" && inputChar <= "9") {
          const index = parseInt(inputChar, 10) - 1;
          const ticket = workspaces.tickets[index];
          if (ticket) activateTicket(ticket.id);
          return;
        }

        // Empty state: n opens first ticket (when no text entry captures it)
        if (!activeTicket && (inputChar === "n" || inputChar === "N") && !key.ctrl) {
          openTicket();
        }
      });

      // Wizard key handling for the active ticket (non text-entry steps)
      useInput(
        (inputChar, key) => {
          if (closeConfirmId || !activeTicket || !activeWizard) return;

          // Success screen - any key signals restart for this ticket
          if (activeWizard.step === "success") {
            emitAction({ type: "restart", ticketId: activeTicket.id });
            return;
          }

          // Ctrl+P to navigate to project selection (success already returned above)
          if (key.ctrl && inputChar === "p" && projects.length > 0) {
            if (!isTicketBusy(activeWizard.step)) {
              patchActive({ step: "project", draftInput: "" });
              setInputVersion((v) => v + 1);
              return;
            }
          }

          if (key.ctrl && inputChar === "g" && hasHarnessStep) {
            if (
              activeWizard.step !== "harness" &&
              activeWizard.step !== "generating" &&
              activeWizard.step !== "regenerating" &&
              activeWizard.step !== "done"
            ) {
              stepBeforeHarness.current.set(activeTicket.id, activeWizard.step);
              patchActive({ step: "harness", draftInput: "" });
              setInputVersion((v) => v + 1);
              return;
            }
          }

          // Scrolling in preview / edit-prompt
          if (activeWizard.step === "preview" || activeWizard.step === "edit-prompt") {
            if (key.upArrow && !key.ctrl) {
              scrollViewRef.current?.scrollBy(-1);
              return;
            }
            if (key.downArrow && !key.ctrl) {
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
            if (activeWizard.step === "source-type" && ["1", "2", "3"].includes(inputChar)) {
              const sourceType = inputChar === "1" ? "figma" : inputChar === "2" ? "log" : "prompt";
              patchActive({ sourceType, step: "source-input", draftInput: "" });
              setInputVersion((v) => v + 1);
              return;
            }

            if (activeWizard.step === "issue-type") {
              const index = parseInt(inputChar) - 1;
              if (index >= 0 && index < orderedIssueTypes.length) {
                const issueType = orderedIssueTypes[index];
                if (issueType) {
                  patchActive({ issueType, step: "style", draftInput: "" });
                  setInputVersion((v) => v + 1);
                  return;
                }
              }
            }

            if (activeWizard.step === "harness") {
              const index = parseInt(inputChar) - 1;
              const harness = orderedHarnesses[index];
              if (harness) {
                const target = stepBeforeHarness.current.get(activeTicket.id) ?? "style";
                stepBeforeHarness.current.delete(activeTicket.id);
                patchActive({ harnessName: harness.name, step: target, draftInput: "" });
                setInputVersion((v) => v + 1);
                return;
              }
            }

            if (activeWizard.step === "style" && ["1", "2"].includes(inputChar)) {
              const promptStyle = inputChar === "1" ? "pm" : "technical";
              patchActive({
                promptStyle,
                decompose: false,
                step: "confirm",
                draftInput: "",
              });
              setInputVersion((v) => v + 1);
              return;
            }

            if (activeWizard.step === "confirm" && ["y", "n"].includes(inputChar.toLowerCase())) {
              if (inputChar.toLowerCase() === "y") {
                const config = { ...activeWizard, step: "generating" as const };
                patchActive({ step: "generating" });
                completed = true;
                emitAction({ type: "generate", ticketId: activeTicket.id, config });
              } else {
                patchActive({ step: "source-type", draftInput: "" });
                setInputVersion((v) => v + 1);
              }
              return;
            }

            if (activeWizard.step === "preview") {
              if (!activeWizard.previewData) return;
              if (inputChar.toLowerCase() === "e") {
                patchActive({ step: "edit-prompt", draftInput: "" });
                setInputVersion((v) => v + 1);
                return;
              }
              if (["y", "n"].includes(inputChar.toLowerCase())) {
                if (inputChar.toLowerCase() === "y") {
                  const config = { ...activeWizard, step: "done" as const };
                  patchActive({ step: "done" });
                  completed = true;
                  emitAction({ type: "create", ticketId: activeTicket.id, config });
                } else {
                  patchActive({
                    step: "source-type",
                    previewData: undefined,
                    draftInput: "",
                  });
                  setInputVersion((v) => v + 1);
                }
              }
            }
          }
        },
        {
          isActive:
            !closeConfirmId &&
            Boolean(activeTicket) &&
            activeWizard !== undefined &&
            !TEXT_ENTRY_STEPS.has(activeWizard.step),
        },
      );

      const handleTextSubmit = (submittedValue: string) => {
        if (!activeTicket || !activeWizard) return;
        const trimmedInput = submittedValue.trim();

        switch (activeWizard.step) {
          case "project": {
            if (trimmedInput === "" && defaultProjectKey) {
              patchActive({
                projectKey: defaultProjectKey,
                step: "source-type",
                draftInput: "",
              });
              setInputVersion((v) => v + 1);
              break;
            }

            const index = parseInt(trimmedInput) - 1;
            if (index >= 0 && index < projects.length) {
              const project = projects[index];
              if (project) {
                patchActive({
                  projectKey: project.key,
                  step: "source-type",
                  draftInput: "",
                });
                setInputVersion((v) => v + 1);
              }
            }
            break;
          }

          case "source-input":
            if (trimmedInput) {
              patchActive({
                sourceContent: trimmedInput,
                step: "custom",
                draftInput: "",
              });
              setInputVersion((v) => v + 1);
            }
            break;

          case "custom":
            patchActive({
              customInstructions: trimmedInput || undefined,
              step: stepAfterCustom as WizardStep,
              draftInput: "",
            });
            setInputVersion((v) => v + 1);
            break;

          case "epic":
            patchActive({
              epicKey: trimmedInput || undefined,
              step: hasIssueTypeStep ? "issue-type" : "style",
              draftInput: "",
            });
            setInputVersion((v) => v + 1);
            break;

          case "edit-prompt": {
            const currentPreview = activeWizard.previewData;
            if (trimmedInput && currentPreview) {
              patchActive({
                editPrompt: trimmedInput,
                step: "regenerating",
                draftInput: "",
              });
              completed = true;
              emitAction({
                type: "edit",
                ticketId: activeTicket.id,
                editPrompt: trimmedInput,
                currentSummary: currentPreview.summary,
                currentDescription: currentPreview.description,
              });
              setInputVersion((v) => v + 1);
            }
            break;
          }
        }
      };

      const navFlags: StepNavFlags = { hasEpicStep, hasIssueTypeStep };

      const inputSeedForStep = (step: WizardStep): string => {
        if (!activeWizard) return "";
        switch (step) {
          case "source-input":
            return activeWizard.sourceContent || "";
          case "custom":
            return activeWizard.customInstructions || "";
          case "epic":
            return activeWizard.epicKey || "";
          default:
            return "";
        }
      };

      const handleEscape = () => {
        if (!activeTicket || !activeWizard) return;
        if (activeWizard.step === "harness") {
          const target = stepBeforeHarness.current.get(activeTicket.id) ?? "style";
          stepBeforeHarness.current.delete(activeTicket.id);
          patchActive({ step: target, draftInput: inputSeedForStep(target) });
          setInputVersion((v) => v + 1);
          return;
        }
        const previous = getPreviousStep(activeWizard.step, navFlags);
        if (previous === null) return;
        const seed = inputSeedForStep(previous);
        patchActive({ step: previous, draftInput: seed });
        setInputVersion((v) => v + 1);
      };

      const handleEnter = () => {
        if (!activeTicket || !activeWizard) return;
        if (
          activeWizard.step === "generating" ||
          activeWizard.step === "regenerating" ||
          activeWizard.step === "done" ||
          activeWizard.step === "success"
        ) {
          return;
        }

        const trimmedInput = (activeWizard.draftInput || "").trim();

        switch (activeWizard.step) {
          case "harness": {
            const target = stepBeforeHarness.current.get(activeTicket.id) ?? "style";
            if (trimmedInput === "") {
              stepBeforeHarness.current.delete(activeTicket.id);
              patchActive({ step: target, draftInput: "" });
              setInputVersion((v) => v + 1);
              break;
            }
            const harness = orderedHarnesses[parseInt(trimmedInput) - 1];
            if (harness) {
              stepBeforeHarness.current.delete(activeTicket.id);
              patchActive({ harnessName: harness.name, step: target, draftInput: "" });
              setInputVersion((v) => v + 1);
            }
            break;
          }
          case "source-type":
            if (["1", "2", "3"].includes(trimmedInput)) {
              const sourceType =
                trimmedInput === "1" ? "figma" : trimmedInput === "2" ? "log" : "prompt";
              patchActive({ sourceType, step: "source-input", draftInput: "" });
              setInputVersion((v) => v + 1);
            }
            break;

          case "issue-type": {
            if (!hasIssueTypeStep) break;
            if (trimmedInput === "") {
              patchActive({ step: "style", draftInput: "" });
              setInputVersion((v) => v + 1);
              break;
            }
            const index = parseInt(trimmedInput) - 1;
            if (index >= 0 && index < orderedIssueTypes.length) {
              const issueType = orderedIssueTypes[index];
              if (issueType) {
                patchActive({ issueType, step: "style", draftInput: "" });
                setInputVersion((v) => v + 1);
              }
            }
            break;
          }

          case "style":
            if (["1", "2"].includes(trimmedInput)) {
              const promptStyle = trimmedInput === "1" ? "pm" : "technical";
              patchActive({
                promptStyle,
                decompose: false,
                step: "confirm",
                draftInput: "",
              });
              setInputVersion((v) => v + 1);
            }
            break;

          case "confirm":
            if (["y", "n", ""].includes(trimmedInput.toLowerCase())) {
              if (trimmedInput.toLowerCase() === "y" || trimmedInput === "") {
                const config = { ...activeWizard, step: "generating" as const };
                patchActive({ step: "generating" });
                completed = true;
                emitAction({ type: "generate", ticketId: activeTicket.id, config });
              } else {
                patchActive({ step: "source-type", draftInput: "" });
                setInputVersion((v) => v + 1);
              }
            }
            break;

          case "preview":
            if (!activeWizard.previewData) break;
            if (["y", "n", ""].includes(trimmedInput.toLowerCase())) {
              if (trimmedInput.toLowerCase() === "y" || trimmedInput === "") {
                const config = { ...activeWizard, step: "done" as const };
                patchActive({ step: "done" });
                completed = true;
                emitAction({ type: "create", ticketId: activeTicket.id, config });
              } else {
                patchActive({
                  step: "source-type",
                  previewData: undefined,
                  draftInput: "",
                });
                setInputVersion((v) => v + 1);
              }
            }
            break;
        }
      };

      const sharedPromptInputProps = {
        onEscape: handleEscape,
        onExit: exit,
      };

      const renderStep = () => {
        if (!activeTicket || !activeWizard) return null;
        const state = activeWizard;
        const input = state.draftInput || "";

        switch (state.step) {
          case "harness":
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Select agent:</Text>
                {orderedHarnesses.map((harness, index) => (
                  <Text key={harness.name}>
                    {index + 1}. {harness.displayName}
                    {harness.name === state.harnessName ? " (current)" : ""}
                  </Text>
                ))}
                <Text dimColor>Enter keeps the current agent; Esc returns.</Text>
              </Box>
            );
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
                  key={`${activeTicket.id}-${state.step}-${inputVersion}`}
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
                  key={`${activeTicket.id}-${state.step}-${inputVersion}`}
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
                <Text dimColor>
                  Example: &quot;Focus on accessibility&quot; or &quot;Prioritize performance&quot;
                </Text>
                <PromptInput
                  key={`${activeTicket.id}-${state.step}-${inputVersion}`}
                  initialValue={input}
                  onSubmit={handleTextSubmit}
                  {...sharedPromptInputProps}
                />
              </Box>
            );

          case "epic":
            if (!hasEpicStep) {
              return (
                <Box flexDirection="column" paddingY={1}>
                  <Text dimColor>Skipping epic step…</Text>
                </Box>
              );
            }
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Epic key (optional, press Enter to skip):</Text>
                <Text dimColor>Example: PROJ-123</Text>
                <PromptInput
                  key={`${activeTicket.id}-${state.step}-${inputVersion}`}
                  initialValue={input}
                  onSubmit={handleTextSubmit}
                  {...sharedPromptInputProps}
                />
              </Box>
            );

          case "issue-type": {
            if (!hasIssueTypeStep) {
              return (
                <Box flexDirection="column" paddingY={1}>
                  <Text dimColor>Skipping issue type step…</Text>
                </Box>
              );
            }
            const defaultIssueType = orderedIssueTypes[0];
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>
                  Select issue type <Text dimColor>(Enter to accept default)</Text>:
                  {isLoadingIssueTypes ? <Text dimColor> Loading…</Text> : null}
                </Text>
                {orderedIssueTypes.map((type, index) => (
                  <Text key={type}>
                    {index + 1}. {type}
                    {type === defaultIssueType ? " (default)" : ""}
                  </Text>
                ))}
              </Box>
            );
          }

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
                  {state.harnessName && (
                    <Box flexDirection="column" paddingTop={1}>
                      <Text bold>Agent:</Text>
                      <Text color="cyan">
                        {allHarnesses.find((h) => h.name === state.harnessName)?.displayName ||
                          state.harnessName}
                      </Text>
                    </Box>
                  )}
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
                <Text dimColor>
                  Elapsed: {elapsedSeconds}s • Switch tickets anytime (Ctrl+↑/↓) • Ctrl+C to cancel
                </Text>
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
                  <Text dimColor>
                    (Use arrow keys {sym.scrollArrows} to scroll, PgUp/PgDn for fast scroll)
                  </Text>
                  <Box
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={1}
                    paddingY={1}
                    flexDirection="column"
                    height={Math.min(25, Math.max(10, (stdout?.rows ?? 40) - 18))}
                  >
                    <ScrollView ref={scrollViewRef}>
                      <MarkdownText>{state.previewData.description}</MarkdownText>
                    </ScrollView>
                  </Box>
                </Box>
                <Box paddingTop={1}>
                  <Text bold>
                    Create this {state.issueType.toLowerCase()} in{" "}
                    {options?.backendName || "task tracker"}? (Y/n){sym.sep}Press E to edit
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
                  <Text dimColor>
                    (Use arrow keys {sym.scrollArrows} to scroll, PgUp/PgDn for fast scroll)
                  </Text>
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
                    Example: &quot;Add more details about error handling&quot; or &quot;Make it more
                    concise&quot;
                  </Text>
                  <PromptInput
                    key={`${activeTicket.id}-${state.step}-${inputVersion}`}
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
                <Text dimColor>
                  Elapsed: {elapsedSeconds}s • Switch tickets anytime (Ctrl+↑/↓) • Ctrl+C to cancel
                </Text>
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
                  <Text dimColor>
                    Press any key to reset this ticket…{sym.sep}Ctrl+N: open another ticket
                  </Text>
                </Box>
              </Box>
            );

          default:
            return (
              <Box flexDirection="column" paddingY={1}>
                <Text bold color="yellow">
                  This step could not be displayed.
                </Text>
                <Text dimColor>Press Esc to return to the start, or Ctrl+C to exit.</Text>
              </Box>
            );
        }
      };

      const currentProjectDisplay = (() => {
        if (!activeWizard) return "N/A";
        const project =
          projects.find((p) => p.key === activeWizard.projectKey)?.name || activeWizard.projectKey;
        if (!project) return "N/A";
        return options?.backendName ? `${options.backendName}/${project}` : project;
      })();

      const showSidebar = terminalWidth >= 60;
      const titleWidth = terminalWidth < 80 ? 12 : 18;

      const mainColumn = (
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">
              📋 @devintern/pm - Interactive Mode
            </Text>
            {activeTicket ? (
              <>
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Project: </Text>
                  <Text color="cyan">{currentProjectDisplay}</Text>
                  {projects.length > 0 && <Text dimColor>{sym.sep}Ctrl+P: Change Project</Text>}
                </Box>
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Agent: </Text>
                  <Text color="cyan">
                    {allHarnesses.find((h) => h.name === activeWizard?.harnessName)?.displayName ||
                      options?.harnessDisplayName ||
                      "None"}
                  </Text>
                  {hasHarnessStep && <Text dimColor>{sym.sep}Ctrl+G: Change Agent</Text>}
                  <Text dimColor>
                    {sym.sep}
                    {workspaces.tickets.length} ticket
                    {workspaces.tickets.length === 1 ? "" : "s"} open
                  </Text>
                </Box>
                <Text dimColor>
                  {activeWizard && canNavigateBack(activeWizard.step, navFlags)
                    ? `ESC: Back${sym.sep}`
                    : ""}
                  {activeWizard?.step === "success"
                    ? `Any key: Reset ticket${sym.sep}Ctrl+N: New${sym.sep}Ctrl+C: Exit`
                    : activeWizard?.step === "preview"
                      ? `Y: Create${sym.sep}N: Discard${sym.sep}E: Edit${sym.sep}Ctrl+C: Exit`
                      : activeWizard && isTicketBusy(activeWizard.step)
                        ? `Ctrl+↑/↓: Switch${sym.sep}Ctrl+C: Cancel`
                        : "Ctrl+N: New ticket • Ctrl+W: Close • Ctrl+C: Exit"}
                </Text>
              </>
            ) : (
              <Text dimColor>Ctrl+N: Open a ticket • Ctrl+C: Exit</Text>
            )}
          </Box>

          {closeConfirmId ? (
            <Box flexDirection="column" paddingY={1} borderStyle="round" borderColor="yellow">
              <Text bold color="yellow">
                Close ticket with work in progress?
              </Text>
              <Text dimColor>
                An agent or tracker operation is still running on this ticket. Closing removes it
                from the sidebar; in-flight work will no longer be shown here (it is not cancelled
                on the agent side).
              </Text>
              <Text bold>Close? (Y/n)</Text>
            </Box>
          ) : activeTicket ? (
            renderStep()
          ) : (
            <NoTicketsEmptyState />
          )}
        </Box>
      );

      // Compact ticket strip for narrow terminals
      const compactStrip =
        !showSidebar && workspaces.tickets.length > 0 ? (
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>
              Tickets:{" "}
              {workspaces.tickets
                .map((t, i) => {
                  const active = t.id === workspaces.activeTicketId;
                  const label = `${i + 1}${active ? "*" : ""}`;
                  return label;
                })
                .join(" ")}{" "}
              · Ctrl+N new · Ctrl+↑/↓ switch · Ctrl+W close
            </Text>
          </Box>
        ) : null;

      return (
        <Box flexDirection="column">
          {compactStrip}
          <Box flexDirection="row">
            {showSidebar ? (
              <TicketSidebar
                tickets={workspaces.tickets}
                activeTicketId={workspaces.activeTicketId}
                titleWidth={titleWidth}
              />
            ) : null}
            {mainColumn}
          </Box>
        </Box>
      );
    };

    const { waitUntilExit, unmount } = render(
      <InteractiveShell />,
      options?.stdin !== undefined ? { stdin: options.stdin } : undefined,
    );

    waitUntilExit().then(() => {
      rejectPendingWaiters();
      if (!completed) {
        reject(cancelError());
      }
    });

    const waitForAction = (): Promise<InteractiveTicketAction> => {
      if (cancelled) {
        return Promise.reject(cancelError());
      }
      if (actionQueue.length > 0) {
        return Promise.resolve(actionQueue.shift()!);
      }
      return new Promise((resolveAction, rejectAction) => {
        if (cancelled) {
          rejectAction(cancelError());
          return;
        }
        actionWaiter = (action) => {
          actionWaiter = null;
          resolveAction(action);
        };
      });
    };

    const waitForCompletion = (): Promise<InteractiveState> => {
      if (cancelled) {
        return Promise.reject(cancelError());
      }
      return new Promise((resolveComplete, rejectComplete) => {
        completePromiseResolve = (config) => {
          completePromiseResolve = null;
          completePromiseReject = null;
          resolveComplete(config);
        };
        completePromiseReject = rejectComplete;
      });
    };

    /**
     * Apply wizard updates to a ticket. When the ticket is on edit-prompt and
     * the update would stay there, buffer previewData so mid-edit rewrites do
     * not clobber the visible description (applied on leave via effect).
     */
    const applyTicketUpdate = (
      ticketId: string,
      updates: Partial<TicketWizardState>,
      opts?: { bufferPreviewIfEditing?: boolean },
    ) => {
      const ticket = getTicket(workspacesRef, ticketId);
      if (!ticket) return;

      let patch = updates;
      if (
        opts?.bufferPreviewIfEditing &&
        updates.previewData &&
        ticket.wizard.step === "edit-prompt"
      ) {
        const nextStep = updates.step ?? ticket.wizard.step;
        if (nextStep === "edit-prompt") {
          previewBuffer.set(ticketId, updates.previewData);
          const { previewData: _preview, ...rest } = updates;
          if (Object.keys(rest).length === 0) return;
          patch = rest;
        } else {
          // Leaving edit-prompt with new preview — apply atomically, drop buffer.
          previewBuffer.delete(ticketId);
        }
      }

      const action = {
        type: "wizard-patched" as const,
        id: ticketId,
        patch,
      };

      if (!dispatchRef) {
        // Pre-mount: update snapshot now; flush into React on first effect.
        workspacesRef = ticketWorkspacesReducer(workspacesRef, action);
        pendingUpdates.push({ ticketId, updates: patch });
        return;
      }
      dispatchRef(action);
    };

    const setGenerating = (ticketId?: string) => {
      const id = resolveTicketId(ticketId);
      if (!id) return;
      applyTicketUpdate(id, {
        step: "generating",
        statusMessage: "Starting AI agent...",
      });
    };

    const setStatusMessage = (message: string, ticketId?: string) => {
      const id = resolveTicketId(ticketId);
      if (!id) return;
      applyTicketUpdate(id, { statusMessage: message });
    };

    const setPreviewData = (summary: string, description: string, ticketId?: string) => {
      const id = resolveTicketId(ticketId);
      if (!id) return;
      applyTicketUpdate(
        id,
        { previewData: { summary, description }, step: "preview" },
        { bufferPreviewIfEditing: true },
      );
    };

    const updatePreviewData = (summary: string, description: string, ticketId?: string) => {
      const id = resolveTicketId(ticketId);
      if (!id) return;
      applyTicketUpdate(
        id,
        { previewData: { summary, description } },
        { bufferPreviewIfEditing: true },
      );
    };

    const showSuccess = (
      message: string,
      successOptions?: { ticketId?: string; createdKey?: string },
    ) => {
      const id = resolveTicketId(successOptions?.ticketId);
      if (!id) return;
      applyTicketUpdate(id, {
        successMessage: message,
        step: "success",
        statusMessage: undefined,
        createdKey: successOptions?.createdKey,
      });
    };

    const restart = (ticketId?: string) => {
      const id = resolveTicketId(ticketId);
      if (!id) return;
      const fresh = makeFreshWizard();
      previewBuffer.delete(id);
      // Explicit undefined clears optional fields (wizard-patched uses `in` checks).
      applyTicketUpdate(id, {
        ...fresh,
        projectKey: defaultProjectKey,
        sourceType: undefined,
        sourceContent: undefined,
        customInstructions: undefined,
        epicKey: undefined,
        previewData: undefined,
        editPrompt: undefined,
        successMessage: undefined,
        statusMessage: undefined,
        createdKey: undefined,
      });
    };

    resolve({
      waitForAction,
      waitForCompletion,
      waitForEdit: () => {
        if (cancelled) {
          return Promise.reject(cancelError());
        }
        return new Promise((resolveEdit, rejectEdit) => {
          editPromiseResolve = (data) => {
            editPromiseResolve = null;
            editPromiseReject = null;
            resolveEdit(data);
          };
          editPromiseReject = rejectEdit;
        });
      },
      waitForRestart: () => {
        if (cancelled) {
          return Promise.reject(cancelError());
        }
        return new Promise((resolveRestart, rejectRestart) => {
          restartPromiseResolve = (data) => {
            restartPromiseResolve = null;
            restartPromiseReject = null;
            resolveRestart(data);
          };
          restartPromiseReject = rejectRestart;
        });
      },
      setGenerating,
      setStatusMessage,
      setPreviewData,
      updatePreviewData,
      showSuccess,
      restart,
      // Published (post-commit) snapshot keeps getStep in lockstep with useInput.
      getStep: () => getActiveTicket(publishedWorkspaces)?.wizard.step ?? "source-type",
      getPreviewData: () => {
        const active = getActiveTicket(publishedWorkspaces);
        if (!active) return undefined;
        const buffered = previewBuffer.get(active.id);
        // Prefer live wizard data; buffer is only for mid-edit deferred updates
        return active.wizard.previewData ?? buffered;
      },
      getHarnessName: () => getActiveTicket(publishedWorkspaces)?.wizard.harnessName,
      getActiveTicketId: () => publishedWorkspaces.activeTicketId,
      getWorkspaces: () => workspacesRef,
      openTicket: () => {
        if (openTicketFn) return openTicketFn();
        // Pre-mount fallback
        const id = nextTicketId();
        const action = {
          type: "ticket-opened" as const,
          id,
          wizard: makeFreshWizard(),
        };
        workspacesRef = ticketWorkspacesReducer(workspacesRef, action);
        publishedWorkspaces = workspacesRef;
        if (dispatchRef) dispatchRef(action);
        return id;
      },
      closeTicket: (id: string) => {
        if (closeTicketFn) {
          closeTicketFn(id);
          return;
        }
        const action = { type: "ticket-closed" as const, id };
        workspacesRef = ticketWorkspacesReducer(workspacesRef, action);
        publishedWorkspaces = workspacesRef;
        if (dispatchRef) dispatchRef(action);
      },
      activateTicket: (id: string) => {
        if (activateTicketFn) {
          activateTicketFn(id);
          return;
        }
        const action = { type: "ticket-activated" as const, id };
        workspacesRef = ticketWorkspacesReducer(workspacesRef, action);
        publishedWorkspaces = workspacesRef;
        if (dispatchRef) dispatchRef(action);
      },
      cleanup: () => {
        rejectPendingWaiters();
        unmount();
      },
    });
  });
}
