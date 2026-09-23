/** Close-confirm flow for tickets with in-flight work, extracted from `App.tsx`. */

import { useCallback, useState } from "react";
import { isBusy } from "./app-store.ts";
import { useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";

export function useCloseTicketConfirm() {
  /** Pending close when the ticket still has an agent/operation in flight. */
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const closeConfirmTicket = useTicketWorkspacesStore((s) =>
    closeConfirmId ? (s.tickets.find((t) => t.id === closeConfirmId) ?? null) : null,
  );

  const requestCloseTicket = useCallback((id: string) => {
    const ticket = useTicketWorkspacesStore.getState().tickets.find((t) => t.id === id);
    if (!ticket) return;
    if (isBusy(ticket.output.phase)) {
      setCloseConfirmId(id);
      return;
    }
    useTicketWorkspacesStore.getState().closeTicket(id);
  }, []);

  const confirmCloseTicket = useCallback(() => {
    if (!closeConfirmId) return;
    useTicketWorkspacesStore.getState().closeTicket(closeConfirmId);
    setCloseConfirmId(null);
  }, [closeConfirmId]);

  return {
    closeConfirmId,
    setCloseConfirmId,
    closeConfirmTicket,
    requestCloseTicket,
    confirmCloseTicket,
  };
}
