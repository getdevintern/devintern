/**
 * Rows of Overview's "Active work" section: tasks in progress with their
 * phase track and exact step, tasks waiting to retry, and a closed list of
 * recently finished tasks. Rendered inside the section's panel, so the lists
 * carry no border or card of their own.
 */

import { ArrowRight, ChevronRight } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { StatusBadge } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { formatRunOrigin } from "@/lib/run-origin";
import { runPrHref, runWorkLink } from "@/lib/run-work";
import {
  PHASES,
  PHASE_LABELS,
  cleanTitle,
  phaseIndex,
  phaseTrackLabel,
  stepDetail,
  stepLabel,
  stepPhase,
} from "@/lib/task-activity";
import type { TaskEntry } from "@/lib/task-activity";
import {
  cn,
  formatAgo,
  formatClockTime,
  formatPastTime,
  formatSpan,
  formatTime,
} from "@/lib/utils";

type RowKind = "active" | "waiting" | "finished";

/** Why active rows are not advancing, e.g. "the worker is stopped"; absent when live. */
type StallReason = string | undefined;

/** "Started 9:25 PM" today, "Started Nov 11, 9:25 PM" before. */
function startedTitle(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return `Started ${sameDay ? formatClockTime(at) : formatTime(at)}`;
}

function TaskRow({
  entry,
  kind,
  now,
  stalled,
  onOpen,
}: {
  entry: TaskEntry;
  kind: RowKind;
  now: number;
  stalled?: StallReason;
  onOpen: (id: number) => void;
}) {
  const run = entry.latest;
  const work = runWorkLink(run);
  const title = cleanTitle(run.taskTitle);
  const primary = title ?? work.label;
  // Same short repo name as the capacity rows; the full `owner/name` is the tooltip.
  const repo = entry.repoLabel ?? run.repo?.split("/").pop();
  const settledAt = run.finishedAt ?? run.startedAt;
  return (
    <li className="aw-row" data-kind={kind} data-stalled={stalled ? "" : undefined}>
      <div className="aw-main">
        <button
          type="button"
          className="aw-open"
          title={primary}
          onClick={() => onOpen(run.id)}
          aria-label={`Open run ${run.id}: ${primary}`}
        >
          {primary}
        </button>
        <div className="aw-meta">
          {title ? <TicketKey label={work.label} href={work.href} /> : null}
          <span title={run.repo}>{repo ?? formatRunOrigin(run.origin)}</span>
          {run.harness ? <span>{run.harness}</span> : null}
          {entry.attempts > 1 ? <span>attempt {entry.attempts}</span> : null}
        </div>
      </div>
      <div className="aw-status">
        <StatusCell run={run} kind={kind} now={now} stalled={stalled} />
      </div>
      {kind === "active" ? (
        <time
          className="aw-time"
          dateTime={new Date(run.startedAt).toISOString()}
          title={
            stalled
              ? `${startedTitle(run.startedAt, now)}; not advancing while ${stalled}`
              : startedTitle(run.startedAt, now)
          }
        >
          {stalled ? formatAgo(run.startedAt, now) : formatSpan(now - run.startedAt)}
        </time>
      ) : (
        <time
          className="aw-time"
          dateTime={new Date(settledAt).toISOString()}
          title={`${kind === "waiting" ? "Deferred" : "Finished"} ${formatTime(settledAt)}`}
        >
          {formatPastTime(settledAt, now)}
        </time>
      )}
    </li>
  );
}

function hasResult(run: TaskEntry["latest"]): boolean {
  return Boolean(run.ticketKey) || run.prNumber !== undefined || Boolean(runPrHref(run));
}

function StatusCell({
  run,
  kind,
  now,
  stalled,
}: {
  run: TaskEntry["latest"];
  kind: RowKind;
  now: number;
  stalled?: StallReason;
}) {
  if (kind === "finished") {
    const tone = run.status === "failed" ? "text-danger" : "text-attention";
    const showReason = run.outcomeReason && run.status !== "succeeded";
    return (
      <>
        <span className="aw-result">
          <StatusBadge status={run.status} />
          {run.status === "succeeded" && hasResult(run) ? <RunResult run={run} /> : null}
        </span>
        {showReason ? (
          <span
            className={cn("aw-detail", run.status === "abandoned" ? "" : tone)}
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
        <span className="aw-phase text-warning" title={run.outcomeReason}>
          <span className="aw-phase-label">
            <span className="status-dot" aria-hidden="true" />
            <span className="aw-reason">{run.outcomeReason ?? "Deferred"}</span>
          </span>
        </span>
        {run.step ? (
          <span className="aw-detail">Stopped at {stepLabel(run.step).toLowerCase()}</span>
        ) : null}
      </>
    );
  }
  const phase = stepPhase(run.step);
  const index = phaseIndex(run.step);
  const track = phaseTrackLabel(run.step);
  const detail = stepDetail(run, now, Boolean(stalled));
  return (
    <>
      <span
        className={cn("aw-phase", stalled ? "text-subtle-foreground" : "text-info")}
        title={stalled ? `${PHASE_LABELS[phase]} · not advancing while ${stalled}` : undefined}
      >
        <span className="aw-phase-label">
          <span
            className={cn("status-dot", !stalled && run.stepActive && "status-dot-live")}
            aria-hidden="true"
          />
          {PHASE_LABELS[phase]}
        </span>
        {index >= 0 ? (
          <span
            className="aw-track"
            role="img"
            title={stalled ? undefined : track}
            aria-label={stalled ? `${track} Not advancing while ${stalled}.` : track}
          >
            <span className="aw-track-bar" aria-hidden="true">
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
      <span className="aw-detail" title={detail}>
        {detail}
      </span>
    </>
  );
}

/** In-progress rows; `stalled` names why none of them is advancing. */
export function ActiveRows({
  entries,
  now,
  stalled,
  onOpen,
}: {
  entries: TaskEntry[];
  now: number;
  stalled?: StallReason;
  onOpen: (id: number) => void;
}) {
  return (
    <ul className="aw-list" aria-label="Runs in progress">
      {entries.map((entry) => (
        <TaskRow
          key={entry.key}
          entry={entry}
          kind="active"
          now={now}
          stalled={stalled}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

/** Deferred tasks whose retry is still due; renders nothing when there are none. */
export function WaitingRows({
  entries,
  now,
  onOpen,
}: {
  entries: TaskEntry[];
  now: number;
  onOpen: (id: number) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="aw-group" role="group" aria-labelledby="aw-waiting">
      <h3 className="aw-subhead" id="aw-waiting">
        Waiting to retry <span className="aw-count">{entries.length}</span>
      </h3>
      <ul className="aw-list">
        {entries.map((entry) => (
          <TaskRow key={entry.key} entry={entry} kind="waiting" now={now} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}

/** A closed disclosure of the last few finished tasks, ending in the Runs link. */
export function RecentlyFinished({
  entries,
  hidden,
  now,
  onOpen,
}: {
  entries: TaskEntry[];
  /** Finished tasks beyond the ones listed. */
  hidden: number;
  now: number;
  onOpen: (id: number) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <details className="aw-finished">
      <summary>
        <ChevronRight className="size-4" aria-hidden="true" />
        Recently finished <span className="aw-count">{entries.length}</span>
      </summary>
      <ul className="aw-list">
        {entries.map((entry) => (
          <TaskRow key={entry.key} entry={entry} kind="finished" now={now} onOpen={onOpen} />
        ))}
        <li>
          <a className="aw-footer" href="#/runs">
            {hidden ? `View all runs · ${hidden} more` : "View all runs"}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        </li>
      </ul>
    </details>
  );
}
