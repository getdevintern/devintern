/**
 * Zustand-backed multi-ticket workspace store.
 *
 * This wraps the existing `ticketWorkspacesReducer` (kept verbatim — it is
 * well-tested in `ticket-workspaces.test.ts`) so the container changes from
 * `useReducer` to a Zustand store while the reducer logic stays unchanged.
 * Components call typed action creators directly instead of receiving a
 * `dispatch` prop, and leaf components read `tickets` / `activeTicketId`
 * without prop drilling.
 *
 * The reducer remains the single source of truth for state transitions; each
 * action creator forwards into it via `set((s) => reducer(s, action))`.
 */

import { createBoundStore } from "./create-store.ts";
import type { ComposerValues } from "./composer-values.ts";
import type { OutputAction } from "./app-store.ts";
import { initialTicketWorkspacesState, ticketWorkspacesReducer } from "./ticket-workspaces.ts";
import type {
  TicketWorkspace,
  TicketWorkspacesAction,
  TicketWorkspacesState,
} from "./ticket-workspaces.ts";

export interface TicketWorkspacesStore extends TicketWorkspacesState {
  /** Apply a raw reducer action (escape hatch for transitions not covered below). */
  dispatch: (action: TicketWorkspacesAction) => void;
  projectLoaded: (defaultComposer: ComposerValues) => void;
  projectReset: () => void;
  defaultProjectChanged: (projectKey: string) => void;
  openTicket: (id: string, composer: ComposerValues) => void;
  activateTicket: (id: string) => void;
  closeTicket: (id: string) => void;
  patchComposer: (id: string, patch: Partial<ComposerValues>) => void;
  /** Apply an output-panel action to a specific ticket (not necessarily active). */
  applyOutputAction: (id: string, action: OutputAction) => void;
  /** Route a stream chunk to whichever ticket owns the requestId. */
  routeAgentChunk: (requestId: string, chunk: string) => void;
}

export const useTicketWorkspacesStore = createBoundStore<TicketWorkspacesStore>((set) => ({
  ...initialTicketWorkspacesState,
  dispatch: (action) => set((state) => ticketWorkspacesReducer(state, action)),
  projectLoaded: (defaultComposer) =>
    set((state) => ticketWorkspacesReducer(state, { type: "project-loaded", defaultComposer })),
  projectReset: () => set(() => initialTicketWorkspacesState),
  defaultProjectChanged: (projectKey) =>
    set((state) => ticketWorkspacesReducer(state, { type: "default-project-changed", projectKey })),
  openTicket: (id, composer) =>
    set((state) => ticketWorkspacesReducer(state, { type: "ticket-opened", id, composer })),
  activateTicket: (id) =>
    set((state) => ticketWorkspacesReducer(state, { type: "ticket-activated", id })),
  closeTicket: (id) =>
    set((state) => ticketWorkspacesReducer(state, { type: "ticket-closed", id })),
  patchComposer: (id, patch) =>
    set((state) => ticketWorkspacesReducer(state, { type: "composer-patched", id, patch })),
  applyOutputAction: (id, action) =>
    set((state) => ticketWorkspacesReducer(state, { type: "output-action", id, action })),
  routeAgentChunk: (requestId, chunk) =>
    set((state) => ticketWorkspacesReducer(state, { type: "agent-chunk", requestId, chunk })),
}));

/** Reset the store to a pristine state (tests only). */
export function resetTicketWorkspacesStore(): void {
  useTicketWorkspacesStore.setState({ ...initialTicketWorkspacesState });
}

/**
 * Read the active ticket from the store outside React (callbacks that need
 * the current value without subscribing to renders). Kept here so the
 * `getActiveTicket` helper in `ticket-workspaces.ts` stays the single
 * implementation.
 */
export function getActiveTicketFromStore(): TicketWorkspace | null {
  const state = useTicketWorkspacesStore.getState();
  if (!state.activeTicketId) return null;
  return state.tickets.find((t) => t.id === state.activeTicketId) ?? null;
}
