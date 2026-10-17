import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, FilterSelect, StatusBadge } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { runWorkLink } from "@/lib/run-work";
import { formatDuration, formatTime } from "@/lib/utils";

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
      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      {error ? <EmptyState title="Could not load runs" body={error} /> : null}

      {data && data.runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body="Runs appear here as the worker picks up tasks, PR mentions, and scheduled automations."
        />
      ) : null}

      {data && data.runs.length > 0 ? (
        <Card className="py-0">
          <RunsTable runs={data.runs} onOpenRun={onOpenRun} />
        </Card>
      ) : null}

      {data && data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span>
            page {page + 1} of {totalPages} ({data.total} runs)
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

/**
 * The runs table itself. Columns read in scanning order — what is the work,
 * where did it come from, how is it going, when — and intentionally leave
 * the branch to the run detail view (low-signal in a compact list).
 */
export function RunsTable({
  runs,
  onOpenRun,
}: {
  runs: RunRecord[];
  onOpenRun: (id: number) => void;
}) {
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="px-2 md:px-4">Work</TableHead>
          <TableHead className="hidden px-4 md:table-cell">Origin</TableHead>
          <TableHead className="hidden px-4 md:table-cell">Harness</TableHead>
          <TableHead className="px-2 md:px-4">Status</TableHead>
          <TableHead className="px-2 md:px-4">Result</TableHead>
          <TableHead className="hidden px-4 md:table-cell">Started</TableHead>
          <TableHead className="hidden px-4 md:table-cell">Duration</TableHead>
          <TableHead className="w-10 px-2">
            <span className="sr-only">Open run</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const work = runWorkLink(run);
          return (
            <TableRow key={run.id} onClick={() => onOpenRun(run.id)} className="cursor-pointer">
              <TableCell className="max-w-36 px-2 py-2.5 font-medium md:max-w-none md:px-4">
                <div className="truncate" title={work.label}>
                  <TicketKey label={work.label} href={work.href} />
                </div>
              </TableCell>
              <TableCell className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
                {formatRunOrigin(run.origin)}
              </TableCell>
              <TableCell className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
                {run.harness ?? "–"}
              </TableCell>
              <TableCell className="px-2 py-2.5 md:px-4">
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell className="px-2 py-2.5 md:px-4">
                <RunResult run={run} />
              </TableCell>
              <TableCell className="hidden px-4 py-2.5 tabular-nums text-muted-foreground md:table-cell">
                {formatTime(run.startedAt)}
              </TableCell>
              <TableCell className="hidden px-4 py-2.5 tabular-nums text-muted-foreground md:table-cell">
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
  );
}
