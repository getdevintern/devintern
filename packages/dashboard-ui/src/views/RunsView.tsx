import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react";

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
import { groupRunAttempts } from "@/lib/run-groups";
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

function runDuration(run: RunRecord): string {
  return run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : "…";
}

/** "3 earlier" toggle that reveals the earlier attempts folded under a run. */
function AttemptsToggle({
  count,
  expanded,
  onToggle,
  label,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} ${count} earlier ${count === 1 ? "attempt" : "attempts"} of ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-raised px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ChevronDown
        aria-hidden="true"
        className={cn("size-3 transition-transform duration-150", !expanded && "-rotate-90")}
      />
      <span className="tabular-nums">{count} earlier</span>
    </button>
  );
}

function attemptLabel(run: RunRecord): string {
  const attempt = runAttempt(run);
  return attempt ? `Attempt ${attempt}` : "Earlier attempt";
}

/**
 * The runs list. Desktop reads in scanning order — work (with origin, attempt
 * and repo underneath), status, outcome, when, how long. Narrow screens get a
 * stacked list instead of a truncated table. Repeated attempts at the same
 * work fold under their newest run; an "N earlier" toggle reveals them.
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
  const groups = useMemo(() => groupRunAttempts(runs), [runs]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openButton = (run: RunRecord, label: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Open run ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpenRun(run.id);
      }}
    >
      <ChevronRight aria-hidden="true" />
    </Button>
  );

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
            {groups.map((group) => {
              const run = group.latest;
              const work = runWorkLink(run);
              const isOpen = expanded.has(group.key);
              return (
                <Fragment key={group.key}>
                  <TableRow onClick={() => onOpenRun(run.id)} className="cursor-pointer">
                    <TableCell className="px-4 py-2.5">
                      <div className="flex items-start gap-2 font-medium" title={work.label}>
                        <span className="line-clamp-2 min-w-0 whitespace-normal [overflow-wrap:anywhere] [&_.ref-link]:inline!">
                          <TicketKey label={work.label} href={work.href} />
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2">
                        <span
                          className="truncate text-xs text-subtle-foreground"
                          title={run.branch ?? runContext(run)}
                        >
                          {runContext(run)}
                        </span>
                        {group.earlier.length > 0 ? (
                          <AttemptsToggle
                            count={group.earlier.length}
                            expanded={isOpen}
                            label={work.label}
                            onToggle={() => toggle(group.key)}
                          />
                        ) : null}
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
                      {runDuration(run)}
                    </TableCell>
                    <TableCell className="px-1 py-2.5">{openButton(run, work.label)}</TableCell>
                  </TableRow>
                  {isOpen
                    ? group.earlier.map((attempt) => (
                        <TableRow
                          key={attempt.id}
                          onClick={() => onOpenRun(attempt.id)}
                          className="cursor-pointer bg-muted/60"
                        >
                          <TableCell className="py-2 pl-6 pr-4">
                            <div className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
                              <CornerDownRight
                                className="size-3.5 shrink-0 text-subtle-foreground"
                                aria-hidden="true"
                              />
                              <span>{attemptLabel(attempt)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="px-4 py-2">
                            <StatusBadge status={attempt.status} />
                          </TableCell>
                          <TableCell className="px-4 py-2">
                            <RunOutcome run={attempt} />
                          </TableCell>
                          <TableCell className="px-4 py-2 text-[0.8125rem] text-subtle-foreground">
                            {attempt.harness ?? "–"}
                          </TableCell>
                          <TableCell
                            className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-foreground"
                            title={formatFullTime(attempt.startedAt)}
                          >
                            {formatStarted(attempt.startedAt, now)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap py-2 pl-4 pr-2 text-right tabular-nums text-muted-foreground">
                            {runDuration(attempt)}
                          </TableCell>
                          <TableCell className="px-1 py-2">
                            {openButton(
                              attempt,
                              `${work.label} ${attemptLabel(attempt).toLowerCase()}`,
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className="overflow-hidden rounded-lg border border-border bg-card md:hidden">
        {groups.map((group) => {
          const run = group.latest;
          const work = runWorkLink(run);
          const isOpen = expanded.has(group.key);
          const showOutcome =
            hasResultLink(run) ||
            (run.status === "in_progress"
              ? Boolean(run.step)
              : run.status !== "succeeded" && Boolean(run.outcomeReason));
          return (
            <li key={group.key} className="border-b border-border last:border-b-0">
              <div
                onClick={() => onOpenRun(run.id)}
                className="flex cursor-pointer items-center gap-2 px-3 py-3 hover:bg-hover"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="line-clamp-2 break-words font-medium [&_.ref-link]:inline!">
                    <TicketKey label={work.label} href={work.href} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <StatusBadge status={run.status} />
                    <span className="tabular-nums" title={formatFullTime(run.startedAt)}>
                      {formatStarted(run.startedAt, now)}
                    </span>
                    {run.finishedAt ? (
                      <span className="tabular-nums text-subtle-foreground">
                        {runDuration(run)}
                      </span>
                    ) : null}
                    {group.earlier.length > 0 ? (
                      <AttemptsToggle
                        count={group.earlier.length}
                        expanded={isOpen}
                        label={work.label}
                        onToggle={() => toggle(group.key)}
                      />
                    ) : null}
                  </div>
                  {showOutcome ? <RunOutcome run={run} wrap /> : null}
                  <div className="truncate text-xs text-subtle-foreground">
                    {[runContext(run), run.harness].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {openButton(run, work.label)}
              </div>
              {isOpen ? (
                <ul className="border-t border-border bg-muted/60">
                  {group.earlier.map((attempt) => (
                    <li
                      key={attempt.id}
                      onClick={() => onOpenRun(attempt.id)}
                      className="flex cursor-pointer items-center gap-2 border-b border-border/70 py-2 pl-6 pr-3 last:border-b-0 hover:bg-hover"
                    >
                      <CornerDownRight
                        className="size-3.5 shrink-0 text-subtle-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="text-[0.8125rem]">{attemptLabel(attempt)}</span>
                          <StatusBadge status={attempt.status} />
                          <span className="tabular-nums">
                            {formatStarted(attempt.startedAt, now)}
                          </span>
                        </div>
                        {attempt.status !== "succeeded" && attempt.outcomeReason ? (
                          <RunOutcome run={attempt} wrap />
                        ) : null}
                      </div>
                      {openButton(attempt, `${work.label} ${attemptLabel(attempt).toLowerCase()}`)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
