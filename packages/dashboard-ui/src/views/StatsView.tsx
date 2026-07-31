import { useState } from "react";

import { EmptyState, FilterGroup, StatTile } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePoll, type StatsResponse } from "@/lib/api";
import { formatDuration, formatRate } from "@/lib/utils";

const WINDOWS = ["7d", "30d", "90d", "all"] as const;

/** Hand-rolled SVG bar chart of runs per week (keeps dependencies minimal). */
function WeeklyBars({ weeks }: { weeks: { weekStart: string; count: number }[] }) {
  if (weeks.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs in this window.</p>;
  }
  const max = Math.max(...weeks.map((week) => week.count));
  const barWidth = 100 / weeks.length;
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-40 w-full">
        {weeks.map((week, index) => {
          const height = (week.count / max) * 36;
          return (
            <rect
              key={week.weekStart}
              x={index * barWidth + barWidth * 0.125}
              y={40 - height}
              width={barWidth * 0.75}
              height={height}
              rx={0.8}
              className="fill-chart-1"
            >
              <title>{`week of ${week.weekStart}: ${week.count} run${week.count === 1 ? "" : "s"}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{weeks[0]?.weekStart}</span>
        {weeks.length > 1 ? <span>{weeks[weeks.length - 1]?.weekStart}</span> : null}
      </div>
    </div>
  );
}

/** Aggregate stats over a selectable window. */
export function StatsView() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("30d");
  const { data, error } = usePoll<StatsResponse>(`/api/stats?window=${window}`);
  const stats = data?.stats ?? null;

  return (
    <div className="space-y-4">
      <FilterGroup
        options={WINDOWS}
        value={window}
        onChange={setWindow}
        formatLabel={(option) => (option === "all" ? "all time" : `last ${option}`)}
      />

      {error ? <EmptyState title="Could not load stats" body={error} /> : null}

      {data && !stats ? (
        <EmptyState
          title="No data yet"
          body="Stats appear after the worker records its first runs."
        />
      ) : null}

      {stats ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Runs"
              value={stats.totals.runs}
              hint={`${stats.byOrigin.task} task${stats.byOrigin.task === 1 ? "" : "s"}, ${stats.byOrigin.pr_mention} PR mention${stats.byOrigin.pr_mention === 1 ? "" : "s"}`}
            />
            <StatTile
              label="Success rate"
              value={formatRate(stats.successRate)}
              hint="of finished runs"
            />
            <StatTile
              label="Escalation rate"
              value={formatRate(stats.escalationRate)}
              hint="handed back to a human"
            />
            <StatTile
              label="Median run duration"
              value={stats.medianDurationMs === null ? "–" : formatDuration(stats.medianDurationMs)}
              hint="succeeded runs, pickup to PR"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Runs per week
              </CardTitle>
            </CardHeader>
            <CardContent>
              <WeeklyBars weeks={stats.runsPerWeek} />
            </CardContent>
          </Card>

          {stats.byHarness.length > 0 ? (
            <Card className="py-0">
              <Table className="text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4">Harness</TableHead>
                    <TableHead className="px-4">Runs</TableHead>
                    <TableHead className="px-4">Succeeded</TableHead>
                    <TableHead className="px-4">Failed</TableHead>
                    <TableHead className="px-4">Escalated</TableHead>
                    <TableHead className="px-4">Median duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.byHarness.map((harness) => (
                    <TableRow key={harness.harness}>
                      <TableCell className="px-4 py-2.5 font-medium">{harness.harness}</TableCell>
                      <TableCell className="px-4 py-2.5 tabular-nums">{harness.runs}</TableCell>
                      <TableCell className="px-4 py-2.5 tabular-nums">
                        {harness.succeeded}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 tabular-nums">{harness.failed}</TableCell>
                      <TableCell className="px-4 py-2.5 tabular-nums">
                        {harness.escalated}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 tabular-nums">
                        {harness.medianDurationMs === null
                          ? "–"
                          : formatDuration(harness.medianDurationMs)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
