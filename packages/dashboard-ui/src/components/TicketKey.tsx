import { ExternalLink } from "lucide-react";

/**
 * A ticket key label that links to its tracker page when a URL exists,
 * degrading to plain text otherwise (same fallback behavior as `RunResult`,
 * used by both the runs list and the run detail header for consistency).
 *
 * Clicks never bubble so opening a ticket from a table row does not also
 * navigate to the run detail.
 */
export function TicketKey({ label, href }: { label: string | undefined; href?: string }) {
  if (!label) return <span className="text-muted-foreground">–</span>;
  if (!href) return <span>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
}
