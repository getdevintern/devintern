import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Minus,
  OctagonAlert,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { EmptyState, StageBadge } from "@/components/shared";
import type { StatusTone } from "@/components/shared";
import { FieldBlocks, FieldChips, splitFields } from "@/components/StageDetailFields";
import { Button } from "@/components/ui/button";
import type { RunRecord, RunStageRecord, StageStatus } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { parseStageDetail } from "@/lib/stage-detail";
import type { ParsedStageDetail } from "@/lib/stage-detail";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { STAGE_LABELS, isLongSummary, reportedDuration, statusTone } from "./helpers";

const STAGE_ICONS: Record<StageStatus, LucideIcon> = {
  succeeded: Check,
  failed: X,
  skipped: Minus,
  deferred: CirclePause,
  escalated: OctagonAlert,
  abandoned: CircleAlert,
};

const NODE_TONES: Record<StatusTone, string> = {
  success: "border-success-border bg-success-subtle text-success",
  warning: "border-warning-border bg-warning-subtle text-warning",
  danger: "border-danger-border bg-danger-subtle text-danger",
  info: "border-info-border bg-info-subtle text-info",
  attention: "border-attention-border bg-attention-subtle text-attention",
  neutral: "border-neutral-border bg-neutral-subtle text-neutral",
};

function hasParsedContent(parsed: ParsedStageDetail): boolean {
  return Boolean(
    parsed.markdown?.trim() ||
    (parsed.fields && parsed.fields.length > 0) ||
    parsed.fallback?.trim(),
  );
}

/** A stage opens by default when it ended badly and has something to show. */
function defaultOpen(stage: RunStageRecord, expandable: boolean): boolean {
  return expandable && stage.status !== "succeeded" && stage.status !== "skipped";
}

function isExpandable(stage: RunStageRecord): boolean {
  if (isLongSummary(stage.summary)) {
    return true;
  }
  return stage.detail ? hasParsedContent(parseStageDetail(stage.stage, stage.detail)) : false;
}

/**
 * Body of an expanded stage: scalar facts, prose (the stage summary when it is
 * the same text as the report), then rich blocks. Raw payload stays reachable
 * behind a quiet toggle.
 */
function StageBody({ stage }: { stage: RunStageRecord }) {
  const [rawOpen, setRawOpen] = useState(false);
  const parsed = stage.detail ? parseStageDetail(stage.stage, stage.detail) : {};
  const summary = stage.summary?.trim();

  if (parsed.fallback !== undefined && parsed.markdown === undefined && !parsed.fields) {
    return (
      <div className="space-y-3">
        {isLongSummary(summary) ? <SummaryText text={summary!} /> : null}
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 font-mono text-xs">
          {parsed.fallback}
        </pre>
      </div>
    );
  }

  const markdown = parsed.markdown?.trim() ? parsed.markdown : undefined;
  const summaryIsReport = markdown !== undefined && markdown.trim() === summary;
  const { compact, blocks } = splitFields(parsed.fields ?? []);

  return (
    <div className="space-y-4">
      <FieldChips fields={compact} />
      {isLongSummary(summary) && !summaryIsReport ? <SummaryText text={summary!} /> : null}
      {markdown ? <Markdown>{markdown}</Markdown> : null}
      <FieldBlocks fields={blocks} />
      {parsed.raw ? (
        <div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setRawOpen((v) => !v)}
            aria-expanded={rawOpen}
            className="-ml-2 text-subtle-foreground"
          >
            {rawOpen ? <ChevronDown /> : <ChevronRight />}
            Raw payload
          </Button>
          {rawOpen ? (
            <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">
              {parsed.raw}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SummaryText({ text }: { text: string }) {
  return (
    <p className="max-w-[72ch] whitespace-pre-wrap break-words text-[0.875rem] leading-[1.6] text-foreground/90">
      {text}
    </p>
  );
}

function StageRow({
  stage,
  run,
  last,
  open,
  onToggle,
}: {
  stage: RunStageRecord;
  run: RunRecord;
  last: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = statusTone(stage.status);
  const duration = reportedDuration(stage);
  const Icon = STAGE_ICONS[stage.status];
  const expandable = isExpandable(stage);
  const long = isLongSummary(stage.summary);
  // The outcome stage repeats the run's outcome reason, which the header owns.
  const redundant = stage.stage === "outcome" && stage.summary === run.outcomeReason;
  const showHeadline = Boolean(stage.summary) && !redundant && (!open || !long);

  const heading = (
    <>
      <span className="font-medium text-foreground">{STAGE_LABELS[stage.stage]}</span>
      {stage.status !== "succeeded" ? <StageBadge status={stage.status} /> : null}
      <span className="tabular ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
        <span className="text-subtle-foreground">{formatTime(stage.createdAt)}</span>
        {expandable ? (
          open ? (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          )
        ) : null}
      </span>
    </>
  );

  return (
    <li className="rd-stage" data-last={last || undefined}>
      <span className={cn("rd-node", NODE_TONES[tone])} aria-hidden="true">
        <Icon className="size-3" strokeWidth={2.5} />
      </span>
      <div className="min-w-0">
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="rd-stage-head -mx-2 w-[calc(100%+1rem)] rounded-md px-2 hover:bg-hover"
          >
            {heading}
          </button>
        ) : (
          <div className="rd-stage-head">{heading}</div>
        )}
        {showHeadline ? (
          <p
            className={cn(
              "mt-0.5 max-w-[72ch] text-[0.8125rem] leading-[1.5] text-muted-foreground",
              !open && "line-clamp-2",
            )}
          >
            {stage.summary}
          </p>
        ) : null}
        {expandable && open ? (
          <div className="mt-3 border-l border-border pl-4">
            <StageBody stage={stage} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Vertical stage timeline: one line per stage, full detail on demand. */
export function Timeline({ run, stages }: { run: RunRecord; stages: RunStageRecord[] }) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const expandableIds = stages.filter(isExpandable).map((stage) => stage.id);

  function isOpen(stage: RunStageRecord): boolean {
    return overrides[stage.id] ?? defaultOpen(stage, isExpandable(stage));
  }
  const anyOpen = stages.some((stage) => isExpandable(stage) && isOpen(stage));

  function setAll(open: boolean): void {
    setOverrides(Object.fromEntries(expandableIds.map((id) => [id, open])));
  }

  return (
    <section aria-labelledby="rd-timeline-heading">
      <div className="mb-3 flex items-center gap-3">
        <h3 id="rd-timeline-heading" className="section-title">
          Timeline
        </h3>
        {expandableIds.length > 0 ? (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setAll(!anyOpen)}>
            {anyOpen ? "Collapse all" : "Expand all"}
          </Button>
        ) : null}
      </div>
      {stages.length === 0 ? (
        <EmptyState title="No stages recorded" body="This run has no stage records yet." />
      ) : (
        <ol className="rd-timeline">
          {stages.map((stage, index) => (
            <StageRow
              key={stage.id}
              stage={stage}
              run={run}
              last={index === stages.length - 1}
              open={isOpen(stage)}
              onToggle={() => setOverrides((prev) => ({ ...prev, [stage.id]: !isOpen(stage) }))}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
