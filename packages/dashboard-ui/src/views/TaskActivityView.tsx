import { useState } from "react";

import { EmptyState, FilterSelect, StatusBadge } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/lib/api";
import type { RunRecord, RunStatus, TaskActivityResponse } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { runWorkLink } from "@/lib/run-work";
import { activityDescription, activityLane, activityLanes, stepLabel } from "@/lib/task-activity";
import { cn, formatDuration, formatTime } from "@/lib/utils";

const STATUSES: (RunStatus | "all")[] = [
  "all",
  "in_progress",
  "deferred",
  "failed",
  "escalated",
  "abandoned",
  "succeeded",
];

export function TaskActivityView({ onOpenRun }: { onOpenRun: (id: number) => void }) {
  const { data, error, loading, refresh } = usePoll<TaskActivityResponse>("/api/task-activity");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const runs = (data?.runs ?? []).filter(
    (run) =>
      (status === "all" || run.status === status) &&
      [
        runWorkLink(run).label,
        run.taskTitle,
        run.repo,
        run.branch,
        run.harness,
        run.step,
        run.outcomeReason,
        formatRunOrigin(run.origin),
      ].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="activity-search"
          type="search"
          aria-label="Find a task or repository"
          placeholder="Find a task or repository…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <FilterSelect label="Status" options={STATUSES} value={status} onChange={setStatus} />
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {runs.length} runs shown
        </span>
      </div>
      {error ? (
        <div role="alert" className="space-y-2">
          <EmptyState title="Could not refresh task activity" body={error} />
          <Button variant="outline" onClick={refresh}>
            Try again
          </Button>
        </div>
      ) : null}
      {loading && !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading task activity…
        </p>
      ) : null}
      {data && runs.length === 0 ? (
        <div className="space-y-3">
          <EmptyState
            title={data.runs.length ? "No matching runs" : "No task activity yet"}
            body={
              data.runs.length
                ? "Try another search or status."
                : "Runs appear when the worker starts work."
            }
          />
          {data.runs.length ? (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
      {runs.length ? (
        <>
          <StepBoard runs={runs} selectedId={selected?.id} onSelect={setSelectedId} />
          {selected ? (
            <section className="activity-selection" aria-label="Selected run">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <strong>{runWorkLink(selected).label}</strong>
                  <StatusBadge status={selected.status} />
                </div>
                <p className="text-sm">{activityDescription(selected)}</p>
                {selected.outcomeReason ? (
                  <p className="activity-reason">{selected.outcomeReason}</p>
                ) : null}
                <p className="text-xs text-muted-foreground break-all">
                  {selected.repo ?? formatRunOrigin(selected.origin)}
                  {selected.branch ? ` · ${selected.branch}` : ""} · Started{" "}
                  {formatTime(selected.startedAt)}
                </p>
              </div>
              <Button variant="outline" onClick={() => onOpenRun(selected.id)}>
                Show run details
              </Button>
            </section>
          ) : null}
        </>
      ) : null}
      {data ? (
        <p className="text-xs text-muted-foreground">
          All in-progress runs and the latest {data.recentLimit} runs. Cards show the explicitly
          recorded current or last step; older runs and workflows without step tracking appear under
          Step unavailable. Open a run for its transcript, artifacts, and completed stages.
        </p>
      ) : null}
    </div>
  );
}

export function StepBoard({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunRecord[];
  selectedId?: number;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="activity-board" role="region" aria-label="Runs by step" tabIndex={0}>
      {activityLanes(runs).map((lane) => {
        const group = runs.filter((run) => activityLane(run) === lane);
        return (
          <section
            className="activity-lane"
            key={lane}
            aria-label={lane === "unknown" ? "Step unavailable" : stepLabel(lane)}
          >
            <h2>
              {lane === "unknown" ? "Step unavailable" : stepLabel(lane)}{" "}
              <span>{group.length}</span>
            </h2>
            {group.length ? (
              group.map((run) => {
                const work = runWorkLink(run);
                return (
                  <article
                    className={cn(
                      "activity-task",
                      selectedId === run.id && "activity-task-selected",
                    )}
                    key={run.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <TicketKey label={work.label} href={work.href} />
                      <span className="text-xs text-muted-foreground">#{run.id}</span>
                    </div>
                    <button
                      type="button"
                      className="activity-task-select"
                      aria-pressed={selectedId === run.id}
                      onClick={() => onSelect(run.id)}
                      aria-label={`Inspect ${work.label}, run ${run.id}`}
                    >
                      <span className="font-medium break-words">
                        {run.taskTitle ?? run.repo ?? formatRunOrigin(run.origin)}
                      </span>
                      {run.taskTitle ? (
                        <span className="text-xs text-muted-foreground">
                          {run.repo ?? formatRunOrigin(run.origin)}
                        </span>
                      ) : null}
                      <StatusBadge status={run.status} />
                      <span className="text-xs text-muted-foreground">
                        {activityDescription(run)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {run.harness ?? "Agent unspecified"} ·{" "}
                        {formatDuration((run.finishedAt ?? Date.now()) - run.startedAt)} elapsed
                      </span>
                    </button>
                  </article>
                );
              })
            ) : (
              <p className="activity-lane-empty">No runs at this step</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
