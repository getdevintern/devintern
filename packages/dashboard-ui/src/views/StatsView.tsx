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
import { usePoll } from "@/lib/api";
import type { StatsResponse } from "@/lib/api";
import { formatDuration, formatRate } from "@/lib/utils";

const WINDOWS = ["7d", "30d", "90d", "all"] as const;

/** Format a token count compactly (12.3k, 4.5M). */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

/**
 * Known-spend label that never presents unknown data as $0.
 * Returns null when nothing is priced in the window.
 */
function formatSpend(knownSpendUsd: number | null): string | null {
  return knownSpendUsd === null ? null : `$${knownSpendUsd.toFixed(2)}`;
}

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

          {(() => {
            const usage = stats.usage;
            const spend = formatSpend(usage.knownSpendUsd);
            const unknownExposure =
              usage.runsWithoutUsage + usage.runsWithIncompleteUsage > 0 || spend === null;
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Token &amp; cost usage
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <StatTile
                      label="Known spend (USD)"
                      value={spend ?? "unknown"}
                      hint={
                        spend === null
                          ? "no priced runs in this window"
                          : `${usage.runsWithUsage} run${usage.runsWithUsage === 1 ? "" : "s"} with usage`
                      }
                    />
                    <StatTile
                      label="Input tokens"
                      value={usage.inputTokens === null ? "–" : formatTokens(usage.inputTokens)}
                      hint={
                        usage.cachedInputTokens === null
                          ? undefined
                          : `${formatTokens(usage.cachedInputTokens)} cached`
                      }
                    />
                    <StatTile
                      label="Output tokens"
                      value={usage.outputTokens === null ? "–" : formatTokens(usage.outputTokens)}
                    />
                    <StatTile
                      label="Total tokens"
                      value={usage.totalTokens === null ? "–" : formatTokens(usage.totalTokens)}
                      hint={
                        usage.reasoningTokens === null
                          ? undefined
                          : `${formatTokens(usage.reasoningTokens)} reasoning`
                      }
                    />
                  </div>
                  {unknownExposure ? (
                    <p className="text-xs text-muted-foreground">
                      ⚠️ Partial data:{" "}
                      {usage.runsWithoutUsage > 0
                        ? `${usage.runsWithoutUsage} finished run${usage.runsWithoutUsage === 1 ? "" : "s"} without usage reporting`
                        : null}
                      {usage.runsWithoutUsage > 0 && usage.runsWithIncompleteUsage > 0
                        ? "; "
                        : null}
                      {usage.runsWithIncompleteUsage > 0
                        ? `${usage.runsWithIncompleteUsage} with incomplete accounting or unpriced model${usage.runsWithIncompleteUsage === 1 ? "" : "s"}`
                        : null}
                      . Totals cover known values only — unknown runs are not counted as $0.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })()}

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
                    <TableHead className="px-4">Spend (USD)</TableHead>
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
                      <TableCell className="px-4 py-2.5 tabular-nums text-muted-foreground">
                        {harness.spendUsd === null
                          ? harness.runsWithUnknownCost > 0
                            ? `unknown (${harness.runsWithUnknownCost})`
                            : "–"
                          : `$${harness.spendUsd.toFixed(2)}`}
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
