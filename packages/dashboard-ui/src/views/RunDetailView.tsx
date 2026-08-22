import { useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { EmptyState, StageBadge, StatusBadge } from "@/components/shared";
import { StageDetailFields } from "@/components/StageDetailFields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Markdown } from "@/lib/markdown";
import { usePoll } from "@/lib/api";
import type { RunDetailResponse, RunStageRecord } from "@/lib/api";
import { parseStageDetail } from "@/lib/stage-detail";
import { formatDuration, formatTime } from "@/lib/utils";

const STAGE_LABELS: Record<RunStageRecord["stage"], string> = {
  feasibility: "Feasibility check",
  implementation: "Implementation",
  auto_review: "Self-review",
  change_request: "Change request",
  outcome: "Outcome",
};

/**
 * Human-readable rendering of a stage's detail blob, surfaced directly under
 * the stage so the full content (markdown prose + structured fields) is
 * visible without expanding a toggle or scrolling inside a boxed region.
 *
 * The friendly view is always shown; the underlying raw JSON/text is available
 * behind a "raw" toggle so the original payload is never lost.
 *
 * `summary` is the stage's summary column (already rendered above the detail);
 * when the parsed markdown matches it we skip re-rendering the prose to avoid
 * duplicating the same text (notably the feasibility stage, where the detail
 * blob's `summary` field is the same string as the stage summary).
 */
function StageDetail({
  stage,
  detail,
  summary,
}: {
  stage: RunStageRecord["stage"];
  detail: string;
  summary?: string;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const parsed = parseStageDetail(stage, detail);

  if (
    parsed.fallback !== undefined &&
    parsed.markdown === undefined &&
    parsed.fields === undefined
  ) {
    return <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{parsed.fallback}</pre>;
  }

  const markdown =
    parsed.markdown !== undefined && parsed.markdown.trim() === (summary ?? "").trim()
      ? undefined
      : parsed.markdown;

  return (
    <div className="mt-2">
      {markdown ? <Markdown>{markdown}</Markdown> : null}
      {parsed.fields && parsed.fields.length > 0 ? (
        <div className={markdown ? "mt-3" : ""}>
          <StageDetailFields fields={parsed.fields} />
        </div>
      ) : null}
      {parsed.raw ? (
        <div className={markdown || parsed.fields ? "mt-3" : ""}>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setRawOpen((v) => !v)}
            aria-expanded={rawOpen}
            className="-ml-1 text-muted-foreground"
          >
            {rawOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            raw
          </Button>
          {rawOpen ? (
            <pre className="mt-1 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {parsed.raw}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
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
              <MetaItem
                label="Cost"
                value={
                  data.run.usage?.costUsd != null ? (
                    <>
                      ${data.run.usage.costUsd.toFixed(4)}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {data.run.usage.costSource === "estimated" ? "est." : "reported"}
                      </span>
                    </>
                  ) : data.run.usage ? (
                    <span className="text-muted-foreground">unknown</span>
                  ) : (
                    "–"
                  )
                }
              />
              {data.run.usage?.model ? (
                <MetaItem
                  label="Model"
                  value={<code className="font-mono text-xs">{data.run.usage.model}</code>}
                />
              ) : null}
              {data.run.usage?.inputTokens != null || data.run.usage?.outputTokens != null ? (
                <MetaItem
                  label="Tokens (in / out)"
                  value={
                    <span className="tabular-nums">
                      {data.run.usage.inputTokens ?? "?"} / {data.run.usage.outputTokens ?? "?"}
                      {data.run.usage.complete === false ? (
                        <span className="ml-1 text-xs text-muted-foreground">(partial)</span>
                      ) : null}
                    </span>
                  }
                />
              ) : null}
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
                  {stage.detail ? (
                    <StageDetail
                      stage={stage.stage}
                      detail={stage.detail}
                      summary={stage.summary}
                    />
                  ) : null}
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
