import { ExternalLink } from "lucide-react";

import type { RunRecord } from "@/lib/api";
import { runPrHref } from "@/lib/run-work";

/**
 * Link to a run result when possible, retaining ticket keys without tracker
 * URLs. PR references (pr mentions, conflict resolutions, created PRs) link
 * straight to the affected PR; runs whose PR does not exist yet show no PR
 * text or placeholder at all.
 */
export function RunResult({
  run,
}: {
  run: Pick<RunRecord, "prNumber" | "prUrl" | "repo" | "ticketKey" | "ticketUrl">;
}) {
  const prHref = runPrHref(run);
  const url = prHref ?? run.ticketUrl;
  const label =
    run.ticketKey ?? (run.prNumber !== undefined ? `#${run.prNumber}` : prHref ? "#PR" : undefined);
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
