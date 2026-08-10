import { Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ticketAgentStatus,
  ticketAgentStatusLabel,
  ticketSubtitle,
  ticketTitle,
  type TicketAgentStatus,
  type TicketWorkspace,
} from "../state/ticket-workspaces.ts";
import { CodeDiscoveryCard } from "./CodeDiscoveryCard.tsx";

interface TicketSidebarProps {
  tickets: TicketWorkspace[];
  activeTicketId: string | null;
  onOpenTicket: () => void;
  /** When false, New is disabled (e.g. git folder still awaiting PM setup). */
  canOpenTicket?: boolean;
  onActivateTicket: (id: string) => void;
  onCloseTicket: (id: string) => void;
  /** Soft Code discovery strip in the sidebar footer. */
  showCodeDiscovery?: boolean;
  onLearnMoreCode?: (url: string) => void;
  onDismissCodeDiscovery?: () => void;
  codeDiscoveryDismissError?: string | null;
}

function statusBadgeVariant(
  status: TicketAgentStatus,
): "default" | "secondary" | "destructive" | "outline" | "tint" {
  switch (status) {
    case "running":
      return "tint";
    case "error":
      return "destructive";
    case "done":
      return "secondary";
    case "ready":
      return "outline";
    case "idle":
      return "outline";
  }
}

function TicketRow({
  ticket,
  active,
  onActivate,
  onClose,
}: {
  ticket: TicketWorkspace;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const status = ticketAgentStatus(ticket.output.phase);
  const title = ticketTitle(ticket);
  const subtitle = ticketSubtitle(ticket);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-primary/40 bg-primary/8 ring-1 ring-primary/20"
          : "border-transparent bg-transparent hover:bg-muted/80",
      )}
      aria-current={active ? "true" : undefined}
      data-testid={`ticket-row-${ticket.id}`}
    >
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground" title={title}>
            {title}
          </div>
          {subtitle && (
            <div className="truncate text-[0.65rem] text-muted-foreground" title={subtitle}>
              {subtitle}
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          title="Close ticket"
          aria-label={`Close ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X />
        </Button>
      </div>
      <Badge variant={statusBadgeVariant(status)} className="w-fit gap-1">
        {status === "running" && <Loader2 className="size-2.5 animate-spin" />}
        {ticketAgentStatusLabel(status)}
      </Badge>
    </div>
  );
}

/**
 * Sidebar of open ticket workspaces. Switching does not cancel agent runs —
 * each row reflects that ticket's own phase so users know when to jump back.
 */
export function TicketSidebar({
  tickets,
  activeTicketId,
  onOpenTicket,
  canOpenTicket = true,
  onActivateTicket,
  onCloseTicket,
  showCodeDiscovery = false,
  onLearnMoreCode,
  onDismissCodeDiscovery,
  codeDiscoveryDismissError = null,
}: TicketSidebarProps) {
  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r bg-card/40"
      aria-label="Open tickets"
      data-testid="ticket-sidebar"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold">Open tickets</div>
          <div className="text-[0.65rem] text-muted-foreground">
            {tickets.length === 0 ? "None yet" : `${tickets.length} open · switch anytime`}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onOpenTicket}
          disabled={!canOpenTicket}
          title={
            canOpenTicket
              ? "Open a new ticket workspace"
              : "Finish project setup before opening a ticket"
          }
          data-testid="open-ticket"
        >
          <Plus data-icon="inline-start" />
          New
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {tickets.length === 0 ? (
          <p className="px-1 py-3 text-[0.7rem] leading-relaxed text-muted-foreground">
            Open a ticket to start generating. Keep several open and switch while agents run in the
            background.
          </p>
        ) : (
          tickets.map((ticket) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              active={ticket.id === activeTicketId}
              onActivate={() => onActivateTicket(ticket.id)}
              onClose={() => onCloseTicket(ticket.id)}
            />
          ))
        )}
      </div>

      {showCodeDiscovery && onLearnMoreCode && onDismissCodeDiscovery && (
        <CodeDiscoveryCard
          variant="sidebar"
          onLearnMore={onLearnMoreCode}
          onDismiss={onDismissCodeDiscovery}
          dismissError={codeDiscoveryDismissError}
        />
      )}
    </aside>
  );
}
