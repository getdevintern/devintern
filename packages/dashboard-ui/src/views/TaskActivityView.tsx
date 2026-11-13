import { Activity, ArrowRight, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, StatusBadge } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/lib/api";
import type { TaskActivityResponse, WorkerResponse } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { runPrHref, runWorkLink } from "@/lib/run-work";
import {
  PHASES,
  PHASE_LABELS,
  buildTaskActivity,
  cleanTitle,
  formatClock,
  phaseIndex,
  phaseTrackLabel,
  stepDetail,
  stepLabel,
  stepPhase,
} from "@/lib/task-activity";
import type { TaskActivity, TaskEntry } from "@/lib/task-activity";
import { cn, formatAge, formatTime } from "@/lib/utils";

// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./task-activity.css";

/** Re-render every second while something is running, so clocks stay live. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/** Tasks that are not yet completed, with their phase and exact step. */
export function TaskActivityView({ onOpenRun }: { onOpenRun: (id: number) => void }) {
  const { data, error, loading, refresh } = usePoll<TaskActivityResponse>("/api/task-activity");
  const { data: worker } = usePoll<WorkerResponse>("/api/worker");
  const hasActive = Boolean(data?.runs.some((run) => run.status === "in_progress"));
  const now = useNow(hasActive);

  if (error && !data) {
    return (
      <div role="alert" className="space-y-3">
        <EmptyState
          title="Could not load task activity"
          body={error}
          action={
            <Button variant="outline" onClick={refresh}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  if (loading && !data) return <ActivitySkeleton />;
  if (!data) return null;
  return (
    <TaskActivityList
      activity={buildTaskActivity(data.runs, now)}
      worker={worker}
      now={now}
      onOpenRun={onOpenRun}
    />
  );
}

/** The sectioned list; separate from the view so it renders without polling. */
export function TaskActivityList({
  activity,
  worker,
  now,
  onOpenRun,
}: {
  activity: TaskActivity;
  worker?: WorkerResponse | null;
  now: number;
  onOpenRun: (id: number) => void;
}) {
  const { active, waiting, finished, finishedHidden } = activity;
  const queued = worker ? queuedCount(worker) : 0;
  const idle = active.length === 0;
  const hasMore = waiting.length > 0 || finished.length > 0;
  return (
    <div>
      {idle ? <IdleState worker={worker} queued={queued} compact={hasMore} /> : null}
      {active.length ? (
        <section className="ta-section" aria-labelledby="ta-active">
          <h2 className="ta-heading" id="ta-active">
            In progress <span className="ta-count">{active.length}</span>
          </h2>
          <ul className="ta-list">
            {active.map((entry) => (
              <TaskRow key={entry.key} entry={entry} kind="active" now={now} onOpen={onOpenRun} />
            ))}
          </ul>
        </section>
      ) : null}
      {waiting.length ? (
        <section className="ta-section" aria-labelledby="ta-waiting">
          <h2 className="ta-heading" id="ta-waiting">
            Waiting to retry <span className="ta-count">{waiting.length}</span>
          </h2>
          <ul className="ta-list">
            {waiting.map((entry) => (
              <TaskRow key={entry.key} entry={entry} kind="waiting" now={now} onOpen={onOpenRun} />
            ))}
          </ul>
        </section>
      ) : null}
      {finished.length ? (
        <details className="ta-section ta-finished">
          <summary>
            <ChevronRight className="size-4" aria-hidden="true" />
            Recently finished <span className="ta-count">{finished.length}</span>
          </summary>
          <ul className="ta-list">
            {finished.map((entry) => (
              <TaskRow key={entry.key} entry={entry} kind="finished" now={now} onOpen={onOpenRun} />
            ))}
            <li>
              <a className="ta-footer" href="#/runs">
                {finishedHidden ? `${finishedHidden} more in Runs` : "View all runs"}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </a>
            </li>
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function queuedCount(worker: WorkerResponse): number {
  const { queue } = worker;
  return queue.pending + queue.processing + queue.injected.pending + queue.retries.pending;
}

function IdleState({
  worker,
  queued,
  compact,
}: {
  worker?: WorkerResponse | null;
  queued: number;
  compact: boolean;
}) {
  const state = worker?.worker.status;
  const title =
    state === "stopped"
      ? "Worker is not running"
      : state === "running"
        ? "Worker is idle"
        : "Nothing is running";
  const body =
    state === "stopped"
      ? "Start the worker to pick up queued work."
      : queued
        ? `${queued} ${queued === 1 ? "task is" : "tasks are"} queued for the next pickup.`
        : "Tasks show up here while they are being worked on.";
  if (!compact) return <EmptyState icon={Activity} title={title} body={body} />;
  return (
    <p className="ta-idle">
      <Activity className="size-4" aria-hidden="true" />
      <span className="font-medium text-foreground">{title}.</span> {body}
    </p>
  );
}

type RowKind = "active" | "waiting" | "finished";

function TaskRow({
  entry,
  kind,
  now,
  onOpen,
}: {
  entry: TaskEntry;
  kind: RowKind;
  now: number;
  onOpen: (id: number) => void;
}) {
  const run = entry.latest;
  const work = runWorkLink(run);
  const title = cleanTitle(run.taskTitle);
  const primary = title ?? work.label;
  return (
    <li className="ta-row" data-kind={kind}>
      <div className="ta-main">
        <button
          type="button"
          className="ta-open"
          title={primary}
          onClick={() => onOpen(run.id)}
          aria-label={`Open run ${run.id}: ${primary}`}
        >
          {primary}
        </button>
        <div className="ta-meta">
          {title ? <TicketKey label={work.label} href={work.href} /> : null}
          <span>{run.repo ?? formatRunOrigin(run.origin)}</span>
          {run.harness ? <span>{run.harness}</span> : null}
          {entry.attempts > 1 ? <span>attempt {entry.attempts}</span> : null}
        </div>
      </div>
      <div className="ta-status">
        <StatusCell run={run} kind={kind} now={now} />
      </div>
      <time
        className="ta-time"
        dateTime={new Date(run.startedAt).toISOString()}
        title={`Started ${formatTime(run.startedAt)}`}
      >
        {kind === "active"
          ? formatClock(now - run.startedAt)
          : `${formatAge(run.finishedAt ?? run.startedAt, now)} ago`}
      </time>
    </li>
  );
}

function hasResult(run: TaskEntry["latest"]): boolean {
  return Boolean(run.ticketKey) || run.prNumber !== undefined || Boolean(runPrHref(run));
}

function StatusCell({ run, kind, now }: { run: TaskEntry["latest"]; kind: RowKind; now: number }) {
  if (kind === "finished") {
    const tone = run.status === "failed" ? "text-danger" : "text-attention";
    const showReason = run.outcomeReason && run.status !== "succeeded";
    return (
      <>
        <span className="ta-result">
          <StatusBadge status={run.status} />
          {run.status === "succeeded" && hasResult(run) ? <RunResult run={run} /> : null}
        </span>
        {showReason ? (
          <span
            className={cn("ta-detail", run.status === "abandoned" ? "" : tone)}
            title={run.outcomeReason}
          >
            {run.outcomeReason}
          </span>
        ) : null}
      </>
    );
  }
  if (kind === "waiting") {
    return (
      <>
        <span className="ta-phase text-warning" title={run.outcomeReason}>
          <span className="ta-phase-label">
            <span className="status-dot" aria-hidden="true" />
            <span className="ta-reason">{run.outcomeReason ?? "Deferred"}</span>
          </span>
        </span>
        {run.step ? (
          <span className="ta-detail">Stopped at {stepLabel(run.step).toLowerCase()}</span>
        ) : null}
      </>
    );
  }
  const phase = stepPhase(run.step);
  const index = phaseIndex(run.step);
  return (
    <>
      <span className="ta-phase text-info">
        <span className="ta-phase-label">
          <span
            className={cn("status-dot", run.stepActive && "status-dot-live")}
            aria-hidden="true"
          />
          {PHASE_LABELS[phase]}
        </span>
        {index >= 0 ? (
          <span
            className="ta-track"
            role="img"
            title={phaseTrackLabel(run.step)}
            aria-label={phaseTrackLabel(run.step)}
          >
            <span className="ta-track-bar" aria-hidden="true">
              {PHASES.map((name, position) => (
                <span
                  key={name}
                  className={cn(position < index && "is-done", position === index && "is-current")}
                />
              ))}
            </span>
            <span aria-hidden="true">
              {index + 1}/{PHASES.length}
            </span>
          </span>
        ) : null}
      </span>
      <span className="ta-detail">{stepDetail(run, now)}</span>
    </>
  );
}

function ActivitySkeleton() {
  return (
    <div className="ta-list" aria-busy="true" aria-label="Loading task activity">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="ta-row">
          <div className="space-y-1.5">
            <div className="skeleton h-4 w-56 max-w-full" />
            <div className="skeleton h-3 w-36 max-w-full" />
          </div>
          <div className="skeleton h-4 w-32" />
        </div>
      ))}
    </div>
  );
}
