/**
 * Multi-ticket workspace state for the desktop PM app.
 *
 * Each open ticket is an independent workspace: its own composer inputs and
 * output-panel lifecycle. Agent streams are routed by `requestId` so a run on
 * ticket A keeps updating A after the user switches to ticket B.
 */

import { initialComposerValues } from "./composer-values.ts";
import type { ComposerValues } from "./composer-values.ts";
import { initialOutputState, isBusy, outputReducer } from "./app-store.ts";
import type { OutputAction, OutputState, Phase } from "./app-store.ts";

export interface TicketWorkspace {
  id: string;
  composer: ComposerValues;
  output: OutputState;
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
  | { type: "project-loaded"; defaultComposer: ComposerValues }
  /** Clear all ticket workspaces (non-git or unconfigured project). */
  | { type: "project-reset" }
  /** Persist a new default project key across open tickets without wiping them. */
  | { type: "default-project-changed"; projectKey: string }
  | { type: "ticket-opened"; id: string; composer: ComposerValues }
  | { type: "ticket-activated"; id: string }
  | { type: "ticket-closed"; id: string }
  | { type: "composer-patched"; id: string; patch: Partial<ComposerValues> }
  /** Apply an output-panel action to a specific ticket (not necessarily active). */
  | { type: "output-action"; id: string; action: OutputAction }
  /** Route a stream chunk to whichever ticket owns the requestId. */
  | { type: "agent-chunk"; requestId: string; chunk: string };

let ticketCounter = 0;

/** Generate a unique workspace id. Exported for tests that need stable control. */
export function nextTicketId(): string {
  return `ticket-${++ticketCounter}`;
}

/** Reset the id counter (tests only). */
export function resetTicketIdCounter(): void {
  ticketCounter = 0;
}

export function createTicketWorkspace(
  id: string,
  composer: ComposerValues = initialComposerValues,
): TicketWorkspace {
  return {
    id,
    composer: {
      ...composer,
      sourceContent: { ...composer.sourceContent },
      labels: [...composer.labels],
    },
    output: initialOutputState,
  };
}

export function getActiveTicket(state: TicketWorkspacesState): TicketWorkspace | null {
  if (!state.activeTicketId) return null;
  return state.tickets.find((t) => t.id === state.activeTicketId) ?? null;
}

/** Human-readable label for the sidebar. */
export function ticketTitle(ticket: TicketWorkspace): string {
  if (ticket.output.created?.key) {
    return ticket.output.created.key;
  }
  if (ticket.output.draft?.summary?.trim()) {
    return truncate(ticket.output.draft.summary.trim(), 48);
  }
  const content = ticket.composer.sourceContent[ticket.composer.sourceType];
  if (content.trim()) {
    const firstLine = content.trim().split(/\n/)[0] ?? content.trim();
    return truncate(firstLine, 48);
  }
  return "New ticket";
}

/** Optional secondary identity (created key already is the title). */
export function ticketSubtitle(ticket: TicketWorkspace): string | null {
  if (ticket.output.created?.key && ticket.output.draft?.summary?.trim()) {
    return truncate(ticket.output.draft.summary.trim(), 40);
  }
  if (ticket.composer.issueType && ticket.composer.issueType !== "Task") {
    return ticket.composer.issueType;
  }
  return null;
}

export type TicketAgentStatus = "running" | "ready" | "error" | "idle" | "done";

export function ticketAgentStatus(phase: Phase): TicketAgentStatus {
  if (isBusy(phase)) return "running";
  if (phase === "error") return "error";
  if (phase === "done") return "done";
  if (phase === "idle") return "idle";
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

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
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
    // Closing a non-active ticket keeps the current selection if it still exists.
    if (previousActiveId && tickets.some((t) => t.id === previousActiveId && t.id !== closedId)) {
      return previousActiveId;
    }
  }
  const remaining = tickets.filter((t) => t.id !== closedId);
  if (remaining.length === 0) return null;
  const closedIndex = tickets.findIndex((t) => t.id === closedId);
  // Prefer the ticket above the closed one; otherwise the one that slides into place.
  if (closedIndex > 0) {
    return tickets[closedIndex - 1]!.id;
  }
  return remaining[0]!.id;
}

export function ticketWorkspacesReducer(
  state: TicketWorkspacesState,
  action: TicketWorkspacesAction,
): TicketWorkspacesState {
  switch (action.type) {
    case "project-loaded": {
      // Fresh project session: one open workspace so the single-ticket path
      // still works; user can open more from the sidebar.
      const id = nextTicketId();
      const ticket = createTicketWorkspace(id, action.defaultComposer);
      return { tickets: [ticket], activeTicketId: id };
    }
    case "project-reset":
      return initialTicketWorkspacesState;
    case "default-project-changed": {
      return {
        ...state,
        tickets: state.tickets.map((ticket) => ({
          ...ticket,
          composer: { ...ticket.composer, projectKey: action.projectKey },
        })),
      };
    }
    case "ticket-opened": {
      const ticket = createTicketWorkspace(action.id, action.composer);
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
    case "composer-patched": {
      return updateTicket(state, action.id, (ticket) => ({
        ...ticket,
        composer: {
          ...ticket.composer,
          ...action.patch,
          // Deep-merge sourceContent when provided so partial patches don't wipe tabs.
          sourceContent: action.patch.sourceContent
            ? { ...ticket.composer.sourceContent, ...action.patch.sourceContent }
            : ticket.composer.sourceContent,
        },
      }));
    }
    case "output-action": {
      return updateTicket(state, action.id, (ticket) => ({
        ...ticket,
        output: outputReducer(ticket.output, action.action),
      }));
    }
    case "agent-chunk": {
      const owner = state.tickets.find((t) => t.output.activeRequestId === action.requestId);
      if (!owner) return state;
      return updateTicket(state, owner.id, (ticket) => ({
        ...ticket,
        output: outputReducer(ticket.output, {
          type: "agent-chunk",
          requestId: action.requestId,
          chunk: action.chunk,
        }),
      }));
    }
  }
}
