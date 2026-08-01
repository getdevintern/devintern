import { Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NoTicketsEmptyStateProps {
  onOpenTicket: () => void;
}

/**
 * Shown when a project is loaded but no ticket workspaces are open.
 * Explains multi-ticket work and how to start.
 */
export function NoTicketsEmptyState({ onOpenTicket }: NoTicketsEmptyStateProps) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="no-tickets-empty"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Layers className="size-6" />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-base font-semibold">No open tickets</h2>
        <p className="text-sm text-muted-foreground">
          Each ticket is its own workspace — composer, agent output, and progress stay separate.
          Open several and switch from the sidebar while an agent is still running on another
          ticket.
        </p>
      </div>
      <Button size="lg" onClick={onOpenTicket} data-testid="open-first-ticket">
        <Plus data-icon="inline-start" />
        Open a ticket
      </Button>
    </section>
  );
}
