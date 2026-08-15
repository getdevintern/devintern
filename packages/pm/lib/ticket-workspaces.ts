/**
 * Multi-ticket workspace state for the pm TUI.
 *
 * Mirrors the desktop product rules (independent workspaces, open/close/switch,
 * non-cancelling switch, status at a glance) while storing the TUI wizard
 * InteractiveState per ticket.
 */

export type WizardStep =
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

export interface TicketWizardState {
  step: WizardStep;
  projectKey?: string;
  sourceType?: "figma" | "log" | "prompt";
  sourceContent?: string;
  customInstructions?: string;
  epicKey?: string;
  promptStyle: "pm" | "technical";
  issueType: string;
  harnessName?: string;
  decompose: boolean;
  tasks: Array<{
    summary: string;
    description: string;
    type: "Story" | "Task" | "Bug" | "Epic";
  }>;
  previewData?: {
    summary: string;
    description: string;
  };
  editPrompt?: string;
  successMessage?: string;
  statusMessage?: string;
  /** Tracker key after successful create (sidebar identity). */
  createdKey?: string;
  /**
   * Draft text input for the current text-entry step. Kept per ticket so
   * switching workspaces does not lose in-progress typing.
   */
  draftInput: string;
}

export interface TicketWorkspace {
  id: string;
  wizard: TicketWizardState;
}

export interface TicketWorkspacesState {
  tickets: TicketWorkspace[];
  activeTicketId: string | null;
}

export const initialTicketWorkspacesState: TicketWorkspacesState = {
  tickets: [],
  activeTicketId: null,
};

export type TicketWorkspacesAction =
  | { type: "session-started"; id: string; wizard: TicketWizardState }
  | { type: "ticket-opened"; id: string; wizard: TicketWizardState }
  | { type: "ticket-activated"; id: string }
  | { type: "ticket-closed"; id: string }
  | { type: "wizard-patched"; id: string; patch: Partial<TicketWizardState> };

let ticketCounter = 0;

/** Generate a unique workspace id. Exported for tests that need stable control. */
export function nextTicketId(): string {
  return `ticket-${++ticketCounter}`;
}

/** Reset the id counter (tests only). */
export function resetTicketIdCounter(): void {
  ticketCounter = 0;
}

export function createInitialWizard(defaults: {
  projectKey?: string;
  issueType: string;
  harnessName?: string;
}): TicketWizardState {
  return {
    step: "source-type",
    projectKey: defaults.projectKey,
    promptStyle: "pm",
    issueType: defaults.issueType,
    harnessName: defaults.harnessName,
    decompose: false,
    tasks: [],
    draftInput: "",
  };
}

export function createTicketWorkspace(id: string, wizard: TicketWizardState): TicketWorkspace {
  return {
    id,
    wizard: { ...wizard, tasks: [...wizard.tasks] },
  };
}

export function getActiveTicket(state: TicketWorkspacesState): TicketWorkspace | null {
  if (!state.activeTicketId) return null;
  return state.tickets.find((t) => t.id === state.activeTicketId) ?? null;
}

export function getTicket(state: TicketWorkspacesState, id: string): TicketWorkspace | undefined {
  return state.tickets.find((t) => t.id === id);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Human-readable label for the sidebar. */
export function ticketTitle(ticket: TicketWorkspace, max = 28): string {
  if (ticket.wizard.createdKey) {
    return truncate(ticket.wizard.createdKey, max);
  }
  if (ticket.wizard.previewData?.summary?.trim()) {
    return truncate(ticket.wizard.previewData.summary.trim(), max);
  }
  if (ticket.wizard.sourceContent?.trim()) {
    const firstLine =
      ticket.wizard.sourceContent.trim().split(/\n/)[0] ?? ticket.wizard.sourceContent.trim();
    return truncate(firstLine, max);
  }
  return "New ticket";
}

/** Optional secondary identity line. */
export function ticketSubtitle(ticket: TicketWorkspace, max = 24): string | null {
  if (ticket.wizard.createdKey && ticket.wizard.previewData?.summary?.trim()) {
    return truncate(ticket.wizard.previewData.summary.trim(), max);
  }
  if (ticket.wizard.issueType && ticket.wizard.issueType !== "Task") {
    return ticket.wizard.issueType;
  }
  return null;
}

export type TicketAgentStatus = "running" | "ready" | "error" | "idle" | "done";

/** Map wizard step to a compact sidebar status. */
export function ticketAgentStatus(step: WizardStep, hasErrorMessage = false): TicketAgentStatus {
  if (hasErrorMessage && step === "success") return "error";
  if (step === "generating" || step === "regenerating" || step === "done") return "running";
  if (step === "preview" || step === "edit-prompt") return "ready";
  if (step === "success") return "done";
  if (step === "source-type" || step === "project") return "idle";
  return "ready";
}

export function ticketAgentStatusLabel(status: TicketAgentStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
    case "done":
      return "Done";
  }
}

/** Compact label for narrow TUI sidebars. */
export function ticketAgentStatusShort(status: TicketAgentStatus): string {
  switch (status) {
    case "running":
      return "run";
    case "ready":
      return "rdy";
    case "error":
      return "err";
    case "idle":
      return "idle";
    case "done":
      return "done";
  }
}

export function isTicketBusy(step: WizardStep): boolean {
  return step === "generating" || step === "regenerating" || step === "done";
}

/**
 * Choose the next active ticket after closing `closedId`.
 * Prefers the neighbor above, then below; null if none remain.
 */
export function pickActiveAfterClose(
  tickets: TicketWorkspace[],
  closedId: string,
  previousActiveId: string | null,
): string | null {
  if (previousActiveId !== closedId) {
    if (previousActiveId && tickets.some((t) => t.id === previousActiveId && t.id !== closedId)) {
      return previousActiveId;
    }
  }
  const remaining = tickets.filter((t) => t.id !== closedId);
  if (remaining.length === 0) return null;
  const closedIndex = tickets.findIndex((t) => t.id === closedId);
  if (closedIndex > 0) {
    return tickets[closedIndex - 1]!.id;
  }
  return remaining[0]!.id;
}

function updateTicket(
  state: TicketWorkspacesState,
  id: string,
  update: (ticket: TicketWorkspace) => TicketWorkspace,
): TicketWorkspacesState {
  const index = state.tickets.findIndex((t) => t.id === id);
  if (index < 0) return state;
  const tickets = state.tickets.slice();
  tickets[index] = update(tickets[index]!);
  return { ...state, tickets };
}

export function ticketWorkspacesReducer(
  state: TicketWorkspacesState,
  action: TicketWorkspacesAction,
): TicketWorkspacesState {
  switch (action.type) {
    case "session-started": {
      // Fresh interactive session: one open workspace so single-ticket use stays smooth.
      const ticket = createTicketWorkspace(action.id, action.wizard);
      return { tickets: [ticket], activeTicketId: action.id };
    }
    case "ticket-opened": {
      const ticket = createTicketWorkspace(action.id, action.wizard);
      return {
        tickets: [...state.tickets, ticket],
        activeTicketId: action.id,
      };
    }
    case "ticket-activated": {
      if (!state.tickets.some((t) => t.id === action.id)) return state;
      return { ...state, activeTicketId: action.id };
    }
    case "ticket-closed": {
      if (!state.tickets.some((t) => t.id === action.id)) return state;
      const nextActive = pickActiveAfterClose(state.tickets, action.id, state.activeTicketId);
      return {
        tickets: state.tickets.filter((t) => t.id !== action.id),
        activeTicketId: nextActive,
      };
    }
    case "wizard-patched": {
      return updateTicket(state, action.id, (ticket) => {
        // `in` so callers can clear optional fields with explicit undefined.
        const next: TicketWizardState = {
          ...ticket.wizard,
          ...action.patch,
          tasks: action.patch.tasks ?? ticket.wizard.tasks,
        };
        if ("previewData" in action.patch) {
          next.previewData = action.patch.previewData;
        }
        if ("successMessage" in action.patch) {
          next.successMessage = action.patch.successMessage;
        }
        if ("statusMessage" in action.patch) {
          next.statusMessage = action.patch.statusMessage;
        }
        if ("createdKey" in action.patch) {
          next.createdKey = action.patch.createdKey;
        }
        if ("editPrompt" in action.patch) {
          next.editPrompt = action.patch.editPrompt;
        }
        if ("customInstructions" in action.patch) {
          next.customInstructions = action.patch.customInstructions;
        }
        if ("epicKey" in action.patch) {
          next.epicKey = action.patch.epicKey;
        }
        if ("sourceType" in action.patch) {
          next.sourceType = action.patch.sourceType;
        }
        if ("sourceContent" in action.patch) {
          next.sourceContent = action.patch.sourceContent;
        }
        return { ...ticket, wizard: next };
      });
    }
  }
}
