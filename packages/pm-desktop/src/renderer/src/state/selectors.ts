/**
 * Cross-store derived selectors for the desktop PM app.
 *
 * Each leaf store (`project-store`, `ticket-workspaces-store`) stays leaf-level
 * (no imports between them). Cross-cutting derivations that read both —
 * `contextBusy`, `anyTicketBusy`, the active ticket — live here so the stores
 * remain independently testable and free of import cycles.
 *
 * Busy guards (two scopes):
 * - **Chrome** (`isChromeBusy` / project load / remote update): app-wide; blocks
 *   ticket actions and project chrome.
 * - **Per-ticket** (`isBusy(ticket.output.phase)`): only that ticket's Generate /
 *   Create / Edit / Decompose. Concurrent runs on other tickets stay allowed.
 * - **Context** (`isContextBusy` = chrome || any ticket): project chrome only
 *   (switch project/tracker/harness, Get updates) — not per-ticket agent actions.
 */

import { isBusy } from "./app-store.ts";
import { useProjectStore } from "./project-store.ts";
import { getActiveTicketFromStore, useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";
import type { TicketWorkspace } from "./ticket-workspaces.ts";

/** True when any open ticket has an agent/operation in flight. */
export function anyTicketBusy(tickets: TicketWorkspace[]): boolean {
  return tickets.some((t) => isBusy(t.output.phase));
}

/**
 * True while project chrome is tearing down or applying a remote update.
 * Blocks per-ticket agent actions and project-wide chrome ops.
 */
export function isChromeBusy(): boolean {
  const { loadingProject, updatingFromRemote } = useProjectStore.getState();
  return loadingProject || updatingFromRemote;
}

/**
 * Non-hook helper for project-wide chrome that must pause while *any* agent run
 * (or chrome load/update) is in flight. Reads both stores' current snapshot.
 *
 * For Generate / Create Task / Edit / Decompose on a ticket, use
 * {@link isTicketActionBlocked} instead so an idle ticket is not locked by a
 * background run on another ticket.
 */
export function isContextBusy(): boolean {
  return isChromeBusy() || anyTicketBusy(useTicketWorkspacesStore.getState().tickets);
}

/**
 * True when Generate / Create Task / Edit / Decompose must no-op for this ticket:
 * app-wide chrome is busy, or *this* ticket already has an operation in flight.
 * Another ticket generating does not block an idle ticket.
 */
export function isTicketActionBlocked(ticket: TicketWorkspace): boolean {
  return isChromeBusy() || isBusy(ticket.output.phase);
}

/** Subscribe to "any ticket busy" (sidebar badges, UpdateNotifier, ProjectBar). */
export function useAnyTicketBusy(): boolean {
  return useTicketWorkspacesStore((state) => anyTicketBusy(state.tickets));
}

/** Subscribe to the active ticket (null when no ticket is open). */
export function useActiveTicket(): TicketWorkspace | null {
  return useTicketWorkspacesStore((state) =>
    state.activeTicketId
      ? (state.tickets.find((t) => t.id === state.activeTicketId) ?? null)
      : null,
  );
}

/** Subscribe to the active ticket's busy flag (false when no active ticket). */
export function useActiveTicketBusy(): boolean {
  return useTicketWorkspacesStore((state) => {
    if (!state.activeTicketId) return false;
    const ticket = state.tickets.find((t) => t.id === state.activeTicketId);
    return ticket ? isBusy(ticket.output.phase) : false;
  });
}

/**
 * Subscribe to the composer/output busy flag: the active ticket's phase is in
 * flight OR the project chrome is tearing down / updating. This is the
 * combination `App.tsx` previously passed to `ComposerForm` / `OutputPanel` as
 * `busy={activeTicketBusy || loadingProject || updatingFromRemote}`.
 */
export function useComposerBusy(): boolean {
  const activeBusy = useActiveTicketBusy();
  const chromeBusy = useProjectStore((s) => s.loadingProject || s.updatingFromRemote);
  return activeBusy || chromeBusy;
}

/** Read the active ticket snapshot outside React (callbacks / effects). */
export { getActiveTicketFromStore };
