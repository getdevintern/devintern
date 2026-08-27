import { useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCcw } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, StageBadge, StatusBadge } from "@/components/shared";
import { StageDetailFields } from "@/components/StageDetailFields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Markdown } from "@/lib/markdown";
import { triggerRunRetry, usePoll } from "@/lib/api";
import type { RetryAuditEntry, RunDetailResponse, RunStageRecord } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { parseStageDetail } from "@/lib/stage-detail";
import { cn, formatDuration, formatTime } from "@/lib/utils";

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

/** Outcome banner after a retry attempt (success and failure are terminal). */
function RetryFeedback({ kind, message }: { kind: "success" | "error"; message: string }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        kind === "success"
          ? "border-chart-4/30 bg-chart-4/10 text-chart-4"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {message}
    </div>
  );
}

/** Inline confirmation strip shown between the first click and the POST. */
function RetryConfirm({
  taskKey,
  busy,
  onCancel,
  onConfirm,
}: {
  taskKey?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded-md border bg-muted/50 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        Start a fresh run of {taskKey ? <code className="font-mono">{taskKey}</code> : "this task"}{" "}
        with <code className="font-mono">--force</code>? This skips the retry gate and runs the full
        implementation pipeline again.
      </p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="destructive" onClick={onConfirm} disabled={busy}>
          {busy ? "Retrying…" : "Yes, retry"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Audited retry history: who re-ran this run's task, when, and how. */
function RetryAuditList({ entries }: { entries: RetryAuditEntry[] }) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader className="text-sm font-medium">Retry history</CardHeader>
      <CardContent className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className={entry.action === "failed" ? "text-destructive" : "text-chart-4"}>
              {entry.action}
            </span>
            <span>by {entry.actor}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTime(entry.createdAt)}
            </span>
            {entry.pid !== undefined ? (
              <span className="text-xs tabular-nums text-muted-foreground">pid {entry.pid}</span>
            ) : null}
            {entry.message ? (
              <span className="basis-full pl-4 text-xs text-muted-foreground">{entry.message}</span>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** One run: metadata card plus a stage-by-stage timeline. */
export function RunDetailView({ runId, onBack }: { runId: number; onBack: () => void }) {
  const { data, error, loading, refresh } = usePoll<RunDetailResponse>(`/api/runs/${runId}`);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );

  async function handleRetry() {
    if (!data) {
      return;
    }
    setPosting(true);
    try {
      const { ok, body } = await triggerRunRetry(data.run.id);
      if (ok) {
        const pidSuffix = body.pid !== undefined ? ` (pid ${body.pid})` : "";
        setFeedback({
          kind: "success",
          message: `Retry triggered${pidSuffix}. A fresh run for ${data.run.taskKey} will appear in the run list shortly.`,
        });
        setConfirming(false);
        refresh();
      } else {
        setFeedback({ kind: "error", message: body.error ?? "Could not trigger the retry." });
      }
    } catch (cause: unknown) {
      setFeedback({
        kind: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setPosting(false);
    }
  }

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
                    data.run.automationId ??
                    (data.run.prNumber ? `PR #${data.run.prNumber}` : `Run ${data.run.id}`)}
                </h2>
                <StatusBadge status={data.run.status} />
                {data.retry.eligible && !confirming ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setFeedback(null);
                      setConfirming(true);
                    }}
                  >
                    <RefreshCcw /> Retry this run
                  </Button>
                ) : null}
              </div>
              {!data.retry.eligible && data.retry.reason ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Not retriable: {data.retry.reason}
                </p>
              ) : null}
              {confirming ? (
                <div className="mt-2">
                  <RetryConfirm
                    taskKey={data.run.taskKey}
                    busy={posting}
                    onCancel={() => setConfirming(false)}
                    onConfirm={() => void handleRetry()}
                  />
                </div>
              ) : null}
              {feedback ? (
                <div className="mt-2">
                  <RetryFeedback {...feedback} />
                </div>
              ) : null}
              {data.run.outcomeReason ? (
                <p className="mt-1 text-sm text-muted-foreground">{data.run.outcomeReason}</p>
              ) : null}
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <MetaItem label="Origin" value={formatRunOrigin(data.run.origin)} />
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
              <MetaItem label="Result" value={<RunResult run={data.run} />} />
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

          <RetryAuditList entries={data.retry.audit} />

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
