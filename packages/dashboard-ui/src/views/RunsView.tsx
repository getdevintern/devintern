import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, FilterGroup, StatusBadge } from "@/components/shared";
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
import type { RunOrigin, RunStatus, RunsResponse } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
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
  "pr_mention",
  "conflict_resolution",
  "scheduled",
  "ci_fix",
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterGroup
          options={STATUS_FILTERS}
          value={status}
          onChange={(next) => {
            setStatus(next);
            setPage(0);
          }}
        />
        <FilterGroup
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
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Status</TableHead>
                <TableHead className="px-4">Work</TableHead>
                <TableHead className="px-4">Origin</TableHead>
                <TableHead className="px-4">Harness</TableHead>
                <TableHead className="px-4">Result</TableHead>
                <TableHead className="px-4">Duration</TableHead>
                <TableHead className="px-4">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((run) => (
                <TableRow key={run.id} onClick={() => onOpenRun(run.id)} className="cursor-pointer">
                  <TableCell className="px-4 py-2.5">
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5 font-medium">
                    {run.taskKey ??
                      run.automationId ??
                      (run.prNumber ? `PR #${run.prNumber}` : `run ${run.id}`)}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-muted-foreground">
                    {formatRunOrigin(run.origin)}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-muted-foreground">
                    {run.harness ?? "–"}
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <RunResult run={run} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : "…"}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {formatTime(run.startedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
