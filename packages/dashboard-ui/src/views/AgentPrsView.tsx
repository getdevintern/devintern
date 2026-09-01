import { EmptyState } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
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
import type { AgentPrRecord, AgentPrsResponse } from "@/lib/api";
import { formatAge, formatTime } from "@/lib/utils";

/**
 * The open agent PRs, most useful first. Each row links straight to the PR
 * on GitHub so a finished run is one click from review. Registry rows are
 * reconciled with GitHub by the worker's review polling, so merged or closed
 * PRs drop out within one poll cycle.
 */
export function AgentPrsTable({ prs, now = Date.now() }: { prs: AgentPrRecord[]; now?: number }) {
  return (
    <Card className="py-0">
      <Table className="text-sm">
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">Pull request</TableHead>
            <TableHead className="px-4">Branch</TableHead>
            <TableHead className="px-4">Ticket</TableHead>
            <TableHead className="px-4">Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {prs.map((pr) => (
            <TableRow key={`${pr.repo}#${pr.prNumber}`}>
              <TableCell className="px-4 py-2.5 font-medium">
                <a href={pr.prUrl} target="_blank" rel="noreferrer" className="hover:underline">
                  {pr.repo}#{pr.prNumber}
                </a>
              </TableCell>
              <TableCell className="px-4 py-2.5">
                {pr.branch ? (
                  <code className="font-mono text-xs">{pr.branch}</code>
                ) : (
                  <span className="text-muted-foreground">–</span>
                )}
              </TableCell>
              <TableCell className="px-4 py-2.5">
                <TicketKey label={pr.taskKey} href={pr.ticketUrl} />
              </TableCell>
              <TableCell
                className="px-4 py-2.5 tabular-nums text-muted-foreground"
                title={formatTime(pr.createdAt)}
              >
                {formatAge(pr.createdAt, now)} ago
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** List of open agent PRs with direct GitHub links. */
export function AgentPrsView() {
  const { data, error } = usePoll<AgentPrsResponse>("/api/agent-prs");

  return (
    <div className="space-y-4">
      {error ? <EmptyState title="Could not load agent PRs" body={error} /> : null}

      {data && data.prs.length === 0 ? (
        <EmptyState
          title="No open agent PRs"
          body="Pull requests created by the worker are listed here while they await review."
        />
      ) : null}

      {data && data.prs.length > 0 ? <AgentPrsTable prs={data.prs} /> : null}
    </div>
  );
}
