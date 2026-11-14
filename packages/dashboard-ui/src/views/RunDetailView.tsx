import { useState } from "react";
import {
  Check,
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
import type { RunDetailResponse, RunRecord } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { runPrHref, runWorkLink } from "@/lib/run-work";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { attemptInfo, runTitle, statusTone } from "./run-detail/helpers";
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

/** The one place every run answers "what happened": outcome, why, and retry state. */
function OutcomePanel({ data, retry }: { data: RunDetailResponse; retry: RetryState }) {
  const { confirming, setConfirming, posting, feedback, handleRetry } = retry;
  const run = data.run;
  const tone = statusTone(run.status);
  const Icon = PANEL_ICONS[tone];
  const prHref = runPrHref(run);
  const headline =
    run.outcomeReason ??
    (run.status === "succeeded"
      ? prHref && run.prNumber !== undefined
        ? `Pull request #${run.prNumber} opened`
        : "Completed"
      : undefined);
  const notRetriable = data.retry.eligible ? undefined : data.retry.reason;
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

function Facts({ run, attempt, total }: { run: RunRecord; attempt?: number; total?: number }) {
  const prHref = runPrHref(run);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1 lg:gap-y-2.5">
      <Fact label="Origin">{formatRunOrigin(run.origin)}</Fact>
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
function RunHeader({ data, retry }: { data: RunDetailResponse; retry: RetryState }) {
  const { confirming, setConfirming, setFeedback } = retry;
  const run = data.run;
  const title = runTitle(run);
  const prHref = runPrHref(run);
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {/* Same label rule as the runs list; PR-affected runs link
                  the PR they operate on. */}
              <TicketKey {...runWorkLink(run)} />
            </h2>
            <StatusBadge status={run.status} />
          </div>
          {title ? (
            <p className="mt-1.5 max-w-[72ch] text-[0.9375rem] text-muted-foreground">{title}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.retry.eligible && !confirming ? (
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
          <ReportProblem run={run} />
        </div>
      </div>

      <OutcomePanel data={data} retry={retry} />
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
          <RunHeader data={data} retry={retry} />

          <div className="rd-grid">
            <div className="rd-timeline-area min-w-0">
              <Timeline run={run} stages={data.stages} />
            </div>
            <aside aria-label="Run facts" className="rd-rail space-y-6">
              <Facts run={run} attempt={attempt} total={total} />
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
