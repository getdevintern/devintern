import { useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { EmptyState, StageBadge, StatusBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { usePoll, type RunDetailResponse, type RunStageRecord } from "@/lib/api";
import { formatDuration, formatTime } from "@/lib/utils";

const STAGE_LABELS: Record<RunStageRecord["stage"], string> = {
  feasibility: "Feasibility check",
  implementation: "Implementation",
  auto_review: "Self-review",
  change_request: "Change request",
  outcome: "Outcome",
};

/**
 * Split a stage's detail blob into a free-text report (the agent's own
 * markdown summary, stored under `report`) and the remaining structured
 * fields, so prose is not shown as an escaped JSON string.
 */
function parseDetail(detail: string): { report?: string; json?: string } {
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && typeof parsed.report === "string") {
      const { report, ...rest } = parsed as { report: string } & Record<string, unknown>;
      return {
        report,
        json: Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : undefined,
      };
    }
    return { json: JSON.stringify(parsed, null, 2) };
  } catch {
    // Not JSON; show as-is.
    return { json: detail };
  }
}

function StageDetail({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  const { report, json } = parseDetail(detail);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        detail
      </CollapsibleTrigger>
      <CollapsibleContent>
        {report ? (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {report}
          </pre>
        ) : null}
        {json ? (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
            {json}
          </pre>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MetaItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm">{value}</div>
    </div>
  );
}

/** One run: metadata card plus a stage-by-stage timeline. */
export function RunDetailView({ runId, onBack }: { runId: number; onBack: () => void }) {
  const { data, error, loading } = usePoll<RunDetailResponse>(`/api/runs/${runId}`);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted-foreground">
        <ArrowLeft /> All runs
      </Button>

      {error ? (
        <EmptyState title={loading ? "Loading…" : "Could not load run"} body={error} />
      ) : null}

      {data ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold">
                  {data.run.taskKey ??
                    (data.run.prNumber ? `PR #${data.run.prNumber}` : `Run ${data.run.id}`)}
                </h2>
                <StatusBadge status={data.run.status} />
              </div>
              {data.run.outcomeReason ? (
                <p className="text-sm text-muted-foreground">{data.run.outcomeReason}</p>
              ) : null}
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <MetaItem
                label="Origin"
                value={data.run.origin === "task" ? "tracker task" : "PR mention"}
              />
              <MetaItem label="Tracker" value={data.run.tracker ?? "–"} />
              <MetaItem label="Harness" value={data.run.harness ?? "–"} />
              <MetaItem
                label="Branch"
                value={
                  data.run.branch ? (
                    <code className="font-mono text-xs">{data.run.branch}</code>
                  ) : (
                    "–"
                  )
                }
              />
              <MetaItem
                label="PR"
                value={
                  data.run.prUrl ? (
                    <a
                      href={data.run.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      #{data.run.prNumber ?? "PR"}
                      <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    "–"
                  )
                }
              />
              <MetaItem
                label="Duration"
                value={
                  data.run.finishedAt
                    ? formatDuration(data.run.finishedAt - data.run.startedAt)
                    : "in progress"
                }
              />
            </CardContent>
          </Card>

          <div className="space-y-0">
            {data.stages.map((stage, index) => (
              <div key={stage.id} className="relative flex gap-4 pb-6">
                {index < data.stages.length - 1 ? (
                  <div className="absolute top-5 bottom-0 left-[7px] w-px bg-border" />
                ) : null}
                <div className="relative mt-1.5 size-[15px] shrink-0 rounded-full border-2 border-primary bg-background" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{STAGE_LABELS[stage.stage]}</span>
                    <StageBadge status={stage.status} />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatTime(stage.createdAt)}
                    </span>
                  </div>
                  {stage.summary ? (
                    <p className="mt-1 text-sm text-muted-foreground">{stage.summary}</p>
                  ) : null}
                  {stage.detail ? <StageDetail detail={stage.detail} /> : null}
                </div>
              </div>
            ))}
            {data.stages.length === 0 ? (
              <EmptyState title="No stages recorded" body="This run has no stage records yet." />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
