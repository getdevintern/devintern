import { ExternalLink } from "lucide-react";

import type { RunRecord } from "@/lib/api";

/** Link to a run result when possible, retaining ticket keys without tracker URLs. */
export function RunResult({
  run,
}: {
  run: Pick<RunRecord, "prNumber" | "prUrl" | "ticketKey" | "ticketUrl">;
}) {
  const url = run.prUrl ?? run.ticketUrl;
  const label = run.ticketKey ?? (run.prNumber ? `#${run.prNumber}` : url ? "#PR" : undefined);
  if (!label) return <span className="text-muted-foreground">–</span>;
  if (!url) return <span>{label}</span>;
  return (
    <a
      href={url}
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
