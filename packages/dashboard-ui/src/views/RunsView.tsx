import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, FilterSelect, StatusBadge } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePoll } from "@/lib/api";
import type { RunOrigin, RunRecord, RunStatus, RunsResponse } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { runPrHref, runWorkLink } from "@/lib/run-work";
import { cn, formatDuration, formatTime } from "@/lib/utils";

const PAGE_SIZE = 25;

const STATUS_FILTERS: (RunStatus | "all")[] = [
  "all",
  "in_progress",
  "succeeded",
  "failed",
  "escalated",
  "deferred",
  "abandoned",
];
const ORIGIN_FILTERS: (RunOrigin | "all")[] = [
  "all",
  "task",
  "error_monitor",
  "pr_mention",
  "ci_fix",
  "conflict_resolution",
  "scheduled",
  "estimate",
  "manual",
  "local",
];

/** Paginated, filterable list of worker runs. */
export function RunsView({ onOpenRun }: { onOpenRun: (id: number) => void }) {
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [origin, setOrigin] = useState<RunOrigin | "all">("all");
  const [page, setPage] = useState(0);

  const url = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (status !== "all") params.set("status", status);
    if (origin !== "all") params.set("origin", origin);
    return `/api/runs?${params}`;
  }, [status, origin, page]);

  const { data, error } = usePoll<RunsResponse>(url);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="toolbar">
        <FilterSelect
          label="Status"
          options={STATUS_FILTERS}
          value={status}
          onChange={(next) => {
            setStatus(next);
            setPage(0);
          }}
        />
        <FilterSelect
          label="Origin"
          options={ORIGIN_FILTERS}
          value={origin}
          formatLabel={(option) => (option === "all" ? "all" : formatRunOrigin(option))}
          onChange={(next) => {
            setOrigin(next);
            setPage(0);
          }}
        />
        {data ? (
          <>
            <span className="toolbar-spacer" />
            <span className="subtle-text tabular">
              {data.total} {data.total === 1 ? "run" : "runs"}
            </span>
          </>
        ) : null}
      </div>

      {error ? <EmptyState title="Could not load runs" body={error} /> : null}

      {!data && !error ? <RunsSkeleton /> : null}

      {data && data.runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body="Runs appear here as the worker picks up tasks, PR mentions, and scheduled automations."
        />
      ) : null}

      {data && data.runs.length > 0 ? <RunsTable runs={data.runs} onOpenRun={onOpenRun} /> : null}

      {data && data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span className="tabular">
            {page * PAGE_SIZE + 1}–{Math.min(data.total, (page + 1) * PAGE_SIZE)} of {data.total}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function runAttempt(run: RunRecord): number | undefined {
  return run.attempt && run.attempt > 0 ? run.attempt : undefined;
}

function formatFullTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Relative time for recent starts, clock time for yesterday, date beyond that. */
export function formatStarted(epochMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - epochMs);
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  const time = new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (epochMs >= startOfToday - DAY_MS && epochMs < startOfToday) return `Yesterday ${time}`;
  return formatTime(epochMs);
}

const OUTCOME_TONE: Partial<Record<RunStatus, string>> = {
  failed: "text-danger",
  escalated: "text-attention",
};

function hasResultLink(run: RunRecord): boolean {
  return Boolean(run.ticketKey) || run.prNumber !== undefined || Boolean(runPrHref(run));
}

/** Outcome reason for non-successful runs, live step for running ones, plus any PR link. */
function RunOutcome({ run, wrap = false }: { run: RunRecord; wrap?: boolean }) {
  const reason =
    run.status === "in_progress"
      ? run.step
        ? `Step: ${run.step}`
        : undefined
      : run.status === "succeeded"
        ? undefined
        : run.outcomeReason;
  const link = hasResultLink(run);
  if (!reason && !link) return <span className="subtle-text">–</span>;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {reason ? (
        <span
          className={cn(
            "min-w-0 text-[0.8125rem]",
            wrap ? "line-clamp-2" : "truncate",
            OUTCOME_TONE[run.status] ?? "text-muted-foreground",
          )}
          title={reason}
        >
          {reason}
        </span>
      ) : null}
      {link ? (
        <span className="shrink-0">
          <RunResult run={run} />
        </span>
      ) : null}
    </span>
  );
}

function runContext(run: RunRecord): string {
  const attempt = runAttempt(run);
  return [formatRunOrigin(run.origin), attempt ? `attempt ${attempt}` : undefined, run.repo]
    .filter(Boolean)
    .join(" · ");
}

function RunsSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-busy="true"
      aria-label="Loading runs"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="skeleton h-4 w-48 max-w-full" />
            <div className="skeleton h-3 w-32 max-w-full" />
          </div>
          <div className="skeleton h-6 w-20" />
          <div className="skeleton hidden h-4 w-40 md:block" />
        </div>
      ))}
    </div>
  );
}

/**
 * The runs list. Desktop reads in scanning order — work (with origin, attempt
 * and repo underneath), status, outcome, when, how long. Narrow screens get a
 * stacked list instead of a truncated table. Repeated attempts at the same
 * work stay visible but the follow-up rows quiet their repeated name.
 */
export function RunsTable({
  runs,
  onOpenRun,
  now = Date.now(),
}: {
  runs: RunRecord[];
  onOpenRun: (id: number) => void;
  now?: number;
}) {
  const isRepeat = (index: number): boolean => {
    const prev = runs[index - 1];
    const cur = runs[index];
    if (!prev || !cur) return false;
    return runWorkLink(prev).label === runWorkLink(cur).label && prev.repo === cur.repo;
  };

  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border border-border bg-card md:block">
        <Table className="table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-[24%]" />
            <col className="w-24" />
            <col className="w-36" />
            <col className="w-24" />
            <col className="w-10" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Work</TableHead>
              <TableHead className="px-4">Status</TableHead>
              <TableHead className="px-4">Outcome</TableHead>
              <TableHead className="px-4">Harness</TableHead>
              <TableHead className="px-4 text-right">Started</TableHead>
              <TableHead className="pl-4 pr-2 text-right">Duration</TableHead>
              <TableHead className="w-10 px-2">
                <span className="sr-only">Open run</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run, index) => {
              const work = runWorkLink(run);
              return (
                <TableRow key={run.id} onClick={() => onOpenRun(run.id)} className="cursor-pointer">
                  <TableCell className="px-4 py-2.5">
                    <div
                      className={cn(
                        "flex items-start gap-1.5 font-medium",
                        isRepeat(index) && "text-subtle-foreground",
                      )}
                      title={work.label}
                    >
                      {isRepeat(index) ? (
                        <CornerDownRight
                          className="size-3.5 shrink-0"
                          aria-label="Repeat attempt"
                        />
                      ) : null}
                      <span className="line-clamp-2 min-w-0 whitespace-normal [overflow-wrap:anywhere] [&_.ref-link]:inline!">
                        <TicketKey label={work.label} href={work.href} />
                      </span>
                    </div>
                    <div
                      className="truncate text-xs text-subtle-foreground"
                      title={run.branch ?? runContext(run)}
                    >
                      {runContext(run)}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <RunOutcome run={run} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-[0.8125rem] text-subtle-foreground">
                    {run.harness ?? "–"}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground"
                    title={formatFullTime(run.startedAt)}
                  >
                    {formatStarted(run.startedAt, now)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2.5 pl-4 pr-2 text-right tabular-nums text-muted-foreground">
                    {run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : "…"}
                  </TableCell>
                  <TableCell className="px-1 py-2.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Open run ${work.label ?? run.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenRun(run.id);
                      }}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className="overflow-hidden rounded-lg border border-border bg-card md:hidden">
        {runs.map((run, index) => {
          const work = runWorkLink(run);
          const showOutcome =
            hasResultLink(run) ||
            (run.status === "in_progress"
              ? Boolean(run.step)
              : run.status !== "succeeded" && Boolean(run.outcomeReason));
          return (
            <li
              key={run.id}
              onClick={() => onOpenRun(run.id)}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-3 last:border-b-0 hover:bg-hover"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div
                  className={cn(
                    "line-clamp-2 break-words font-medium [&_.ref-link]:inline!",
                    isRepeat(index) && "text-subtle-foreground",
                  )}
                >
                  {isRepeat(index) ? (
                    <CornerDownRight
                      className="mr-1 inline size-3.5 align-[-2px]"
                      aria-label="Repeat attempt"
                    />
                  ) : null}
                  <TicketKey label={work.label} href={work.href} />
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <StatusBadge status={run.status} />
                  <span className="tabular-nums" title={formatFullTime(run.startedAt)}>
                    {formatStarted(run.startedAt, now)}
                  </span>
                  {run.finishedAt ? (
                    <span className="tabular-nums text-subtle-foreground">
                      {formatDuration(run.finishedAt - run.startedAt)}
                    </span>
                  ) : null}
                </div>
                {showOutcome ? <RunOutcome run={run} wrap /> : null}
                <div className="truncate text-xs text-subtle-foreground">
                  {[runContext(run), run.harness].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Open run ${work.label ?? run.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenRun(run.id);
                }}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
