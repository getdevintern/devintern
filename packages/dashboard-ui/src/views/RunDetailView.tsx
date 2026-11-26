import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CirclePause,
  CircleX,
  Copy,
  ExternalLink,
  Info,
  OctagonAlert,
  RefreshCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, StatusBadge } from "@/components/shared";
import type { StatusTone } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { Button } from "@/components/ui/button";
import { triggerRunRetry, usePoll } from "@/lib/api";
import { isDemoMode } from "@/lib/demo";
import { Markdown } from "@/lib/markdown";
import { automationHash } from "@/lib/routes";
import { dropHeadline, runReport } from "@/lib/run-report";
import type { RunReport } from "@/lib/run-report";
import type { RunDetailResponse, RunLineageParent, RunRecord } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { runPrHref, runWorkLink } from "@/lib/run-work";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { attemptInfo, runTitle, statusTone } from "./run-detail/helpers";
import { SourcedFrom, SpawnedWorkSection } from "./run-detail/Lineage";
import { Reference } from "./run-detail/Reference";
import { ReportProblem } from "./run-detail/ReportProblem";
import { RetryAuditList, RetryConfirm, RetryFeedback } from "./run-detail/RetryParts";
import { Timeline } from "./run-detail/Timeline";
// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./run-detail.css";

const PANEL_TONES: Record<StatusTone, string> = {
  success: "border-transparent",
  warning: "border-warning-border bg-warning-subtle",
  danger: "border-danger-border bg-danger-subtle",
  info: "border-info-border bg-info-subtle",
  attention: "border-attention-border bg-attention-subtle",
  neutral: "border-border bg-card",
};

const ICON_TONES: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  attention: "text-attention",
  neutral: "text-neutral",
};

const PANEL_ICONS: Record<StatusTone, LucideIcon> = {
  success: CircleCheck,
  warning: CirclePause,
  danger: CircleX,
  info: Info,
  attention: OctagonAlert,
  neutral: Info,
};

/** Whether the Report card, not the outcome panel, carries this run's headline. */
function reportLeadsHeadline(run: RunRecord, report?: RunReport): boolean {
  return Boolean(report?.headline) && run.status === "succeeded" && !run.outcomeReason;
}

/** The one place every run answers "what happened": outcome, why, and retry state. */
function OutcomePanel({
  data,
  retry,
  report,
}: {
  data: RunDetailResponse;
  retry: RetryState;
  report?: RunReport;
}) {
  const { confirming, setConfirming, posting, feedback, handleRetry } = retry;
  const run = data.run;
  const tone = statusTone(run.status);
  const Icon = PANEL_ICONS[tone];
  const prHref = runPrHref(run);
  // A succeeded report run leads its Report card with the headline instead.
  const leads = reportLeadsHeadline(run, report);
  const headline = leads
    ? undefined
    : (run.outcomeReason ??
      report?.headline ??
      (run.status === "succeeded"
        ? prHref && run.prNumber !== undefined
          ? `Pull request #${run.prNumber} opened`
          : "Completed"
        : undefined));
  const notRetriable =
    data.retry.eligible || run.status === "succeeded" ? undefined : data.retry.reason;
  const quiet = tone === "success";
  if (!headline && !notRetriable && !confirming && !feedback) {
    return null;
  }
  return (
    <div className={cn("space-y-2.5 rounded-lg border py-3", !quiet && "px-4", PANEL_TONES[tone])}>
      {headline ? (
        <p
          className={cn(
            "flex max-w-[72ch] items-start gap-2.5 leading-[1.5] text-foreground",
            quiet ? "text-[0.875rem]" : "text-[0.9375rem]",
          )}
        >
          <Icon className={cn("mt-[3px] size-4 shrink-0", ICON_TONES[tone])} aria-hidden="true" />
          <span>{headline}</span>
        </p>
      ) : null}
      {notRetriable ? (
        <p className="flex max-w-[72ch] items-start gap-2.5 text-[0.8125rem] leading-[1.5] text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 opacity-60" aria-hidden="true" />
          <span>Not retriable: {notRetriable}</span>
        </p>
      ) : null}
      {confirming ? (
        <RetryConfirm
          taskKey={run.taskKey}
          kind={data.retry.kind}
          busy={posting}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void handleRetry()}
        />
      ) : null}
      {feedback ? <RetryFeedback {...feedback} /> : null}
    </div>
  );
}

/** Collapsed report height; longer reports get a fade and a "Show full report" toggle. */
const RESULT_COLLAPSED_PX = 360;

/**
 * What a prompt automation delivered: its final report in a card, led by the
 * outcome headline, with the structured briefing behind a toggle. When
 * `leadsHeadline` is false the outcome panel owns the headline, so the body
 * drops its opening sentence instead.
 */
function ResultSection({
  report,
  leadsHeadline,
  showsHeadline,
}: {
  report: RunReport;
  leadsHeadline: boolean;
  showsHeadline: boolean;
}) {
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = showsHeadline ? dropHeadline(report.body) : report.body;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > RESULT_COLLAPSED_PX + 80);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body]);

  if (!body && !report.briefing && !leadsHeadline) return null;
  const clamped = overflowing && !expanded;
  const hasFooter = overflowing || Boolean(report.briefing);
  return (
    <section
      aria-labelledby="rd-result-heading"
      className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5"
    >
      {leadsHeadline ? (
        <h3
          id="rd-result-heading"
          className="flex items-start gap-2.5 text-base leading-snug font-semibold tracking-tight"
        >
          <CircleCheck className="mt-[3px] size-4 shrink-0 text-success" aria-hidden="true" />
          <span>{report.headline}</span>
        </h3>
      ) : (
        <h3 id="rd-result-heading" className="section-title">
          Report
        </h3>
      )}
      {body ? (
        <div className="relative mt-3">
          <div
            ref={bodyRef}
            id="rd-result-body"
            className={cn(
              "min-w-0 overflow-hidden",
              "[overflow-wrap:anywhere] [&_pre]:[overflow-wrap:normal]",
              leadsHeadline && "sm:pl-[26px]",
            )}
            style={clamped ? { maxHeight: RESULT_COLLAPSED_PX } : undefined}
          >
            <Markdown>{body}</Markdown>
          </div>
          {clamped ? <div className="rd-result-fade" aria-hidden="true" /> : null}
        </div>
      ) : null}
      {hasFooter ? (
        <div className="mt-3 flex items-center gap-1 border-t border-border pt-2.5">
          {overflowing ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-controls="rd-result-body"
              className="-ml-2 text-muted-foreground"
            >
              <ChevronDown className={expanded ? "rotate-180" : undefined} />
              {expanded ? "Show less" : "Show full report"}
            </Button>
          ) : null}
          {report.briefing ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setBriefingOpen((open) => !open)}
              aria-expanded={briefingOpen}
              aria-controls="rd-result-briefing"
              className={cn("text-muted-foreground", overflowing ? "ml-auto" : "-ml-2")}
            >
              {briefingOpen ? <ChevronDown /> : <ChevronRight />}
              Briefing
            </Button>
          ) : null}
        </div>
      ) : null}
      {report.briefing && briefingOpen ? (
        <div
          id="rd-result-briefing"
          className="mt-3 min-w-0 [overflow-wrap:anywhere] [&_pre]:[overflow-wrap:normal]"
        >
          <Markdown>{report.briefing}</Markdown>
        </div>
      ) : null}
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context): leave the value selectable.
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? `${label} copied` : label}
      title={label}
      onClick={() => void copy()}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 lg:flex lg:items-baseline lg:justify-between lg:gap-4">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-[0.8125rem] lg:mt-0 lg:text-right">
        {children}
      </dd>
    </div>
  );
}

function Facts({
  run,
  attempt,
  total,
  parent,
}: {
  run: RunRecord;
  attempt?: number;
  total?: number;
  parent?: RunLineageParent | null;
}) {
  const prHref = runPrHref(run);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1 lg:gap-y-2.5">
      <Fact label="Origin">{formatRunOrigin(run.origin)}</Fact>
      {parent ? (
        <Fact label="Sourced from">
          <SourcedFrom parent={parent} />
        </Fact>
      ) : null}
      {run.tracker ? <Fact label="Tracker">{run.tracker}</Fact> : null}
      {run.harness ? <Fact label="Harness">{run.harness}</Fact> : null}
      {attempt !== undefined ? (
        <Fact label="Attempt">
          <span className="tabular">
            {attempt}
            {total ? <span className="text-muted-foreground"> of {total}</span> : null}
          </span>
        </Fact>
      ) : null}
      <Fact label="Started">
        <span className="tabular">{formatTime(run.startedAt)}</span>
      </Fact>
      <Fact label="Duration">
        <span className="tabular">
          {run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : "in progress"}
        </span>
      </Fact>
      {run.repo ? <Fact label="Repository">{run.repo}</Fact> : null}
      {prHref ? (
        <Fact label="Pull request">
          <RunResult run={{ prNumber: run.prNumber, prUrl: run.prUrl, repo: run.repo }} />
        </Fact>
      ) : null}
      {run.ticketKey ? (
        <Fact label="Ticket">
          <RunResult run={{ ticketKey: run.ticketKey, ticketUrl: run.ticketUrl }} />
        </Fact>
      ) : null}
      {run.branch ? (
        <div className="col-span-full min-w-0">
          <dt className="text-xs text-subtle-foreground">Branch</dt>
          <dd className="mt-0.5 flex items-start gap-1">
            <code className="min-w-0 break-all font-mono text-xs leading-5">{run.branch}</code>
            <CopyButton text={run.branch} label="Copy branch name" />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Retry confirmation/POST state for a run, including terminal feedback. */
function useRetry(data: RunDetailResponse | null | undefined, refresh: () => void) {
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
        const scheduled = body.status === "scheduled";
        const pidSuffix = body.pid !== undefined ? ` (pid ${body.pid})` : "";
        if (data.retry.kind === "automation") {
          const triggered = body.status === "triggered";
          setFeedback({
            kind: triggered ? "success" : "error",
            message: triggered
              ? `Automation re-run triggered. A fresh run will appear in the run list shortly.`
              : "Could not trigger the automation re-run.",
          });
        } else if (data.retry.kind === "injected") {
          setFeedback({
            kind: "success",
            message: `Re-queued. The worker will resume ${data.run.taskKey} on its next poll.`,
          });
        } else {
          setFeedback({
            kind: "success",
            message: scheduled
              ? `Retry scheduled. The worker will start a fresh run for ${data.run.taskKey} shortly.`
              : `Retry triggered${pidSuffix}. A fresh run for ${data.run.taskKey} will appear in the run list shortly.`,
          });
        }
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

  return { confirming, setConfirming, posting, feedback, setFeedback, handleRetry };
}

type RetryState = ReturnType<typeof useRetry>;

/** Answer-first header: identity, outcome and why, what to do next. */
function RunHeader({
  data,
  retry,
  report,
}: {
  data: RunDetailResponse;
  retry: RetryState;
  report?: RunReport;
}) {
  const { confirming, setConfirming, setFeedback } = retry;
  const run = data.run;
  const work = runWorkLink(run);
  const rawTitle = runTitle(run);
  // Automation runs title their prompt with the automation id, which the
  // heading already shows; don't print it twice.
  const title =
    rawTitle && rawTitle.toLowerCase() !== work.label.toLowerCase() ? rawTitle : undefined;
  const automationLink =
    run.automationId && work.label === run.automationId && !work.href
      ? automationHash(run.automationId)
      : undefined;
  const prHref = runPrHref(run);
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-52 sm:basis-80">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {/* Same label rule as the runs list; PR-affected runs link
                  the PR they operate on. */}
              {automationLink ? (
                <a href={automationLink} className="ref-link" title="Open this automation">
                  {work.label}
                </a>
              ) : (
                <TicketKey {...work} />
              )}
            </h2>
            <StatusBadge status={run.status} />
          </div>
          {title ? (
            <p className="mt-1.5 max-w-[72ch] text-[0.9375rem] text-muted-foreground">{title}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.retry.eligible && !confirming && !isDemoMode() ? (
            <Button
              onClick={() => {
                setFeedback(null);
                setConfirming(true);
              }}
            >
              <RefreshCcw />
              {data.retry.kind === "automation"
                ? "Re-run automation"
                : data.retry.kind === "injected"
                  ? "Re-queue task"
                  : "Retry this run"}
            </Button>
          ) : null}
          {prHref ? (
            <Button variant="outline" asChild>
              <a href={prHref} target="_blank" rel="noreferrer">
                Open PR
                <ExternalLink />
              </a>
            </Button>
          ) : null}
          {run.ticketUrl && run.ticketKey ? (
            <Button variant="outline" asChild>
              <a href={run.ticketUrl} target="_blank" rel="noreferrer">
                Open ticket
                <ExternalLink />
              </a>
            </Button>
          ) : null}
          {isDemoMode() ? null : <ReportProblem run={run} />}
        </div>
      </div>

      <OutcomePanel data={data} retry={retry} report={report} />
    </header>
  );
}

/** One run: answer-first header, stage timeline, and reference tabs. */
export function RunDetailView({ runId }: { runId: number; onBack?: () => void }) {
  const { data, error, loading, refresh } = usePoll<RunDetailResponse>(`/api/runs/${runId}`);
  const retry = useRetry(data, refresh);

  const run = data?.run;
  const logs = data?.harnessLogs ?? [];
  const { attempt, total } = run ? attemptInfo(run, logs) : {};
  const report = run && data ? runReport(run, data.stages) : undefined;

  return (
    <div className="space-y-6">
      {!data && loading ? (
        <div role="status" aria-label="Loading run details" className="space-y-3 py-2">
          <div className="skeleton h-7 w-64" />
          <div className="skeleton h-16 w-full" />
          <div className="skeleton h-40 w-full" />
        </div>
      ) : null}

      {error ? (
        data ? (
          <div
            role="status"
            className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm"
          >
            Could not refresh this run. Showing the last loaded details. {error}
          </div>
        ) : (
          <div className="space-y-3">
            <EmptyState title="Could not load run" body={error} />
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCcw /> Try again
            </Button>
          </div>
        )
      ) : null}

      {data && run ? (
        <>
          <RunHeader data={data} retry={retry} report={report} />

          <div className="rd-grid" data-report={report ? "" : undefined}>
            <div className="rd-main-area min-w-0 space-y-6">
              {report ? (
                <ResultSection
                  report={report}
                  leadsHeadline={reportLeadsHeadline(run, report)}
                  showsHeadline={!run.outcomeReason}
                />
              ) : null}
              <SpawnedWorkSection spawned={data.lineage?.spawned} />
              <Timeline run={run} stages={data.stages} compact={Boolean(report)} />
            </div>
            <aside aria-label="Run facts" className="rd-rail space-y-6">
              <Facts run={run} attempt={attempt} total={total} parent={data.lineage?.parent} />
              <RetryAuditList entries={data.retry.audit} />
            </aside>
            <div className="rd-reference-area min-w-0">
              <Reference run={run} logs={logs} artifacts={data.artifacts ?? []} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
