import { useEffect, useRef, useState } from "react";

import { EmptyState, FilterGroup } from "@/components/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePoll } from "@/lib/api";
import type { RunOrigin, RunStatus, StatsResponse } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { cn, formatDuration, formatRate } from "@/lib/utils";

const WINDOWS = ["7d", "30d", "90d", "all"] as const;
const WINDOW_LABELS: Record<(typeof WINDOWS)[number], string> = {
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All",
};

type Stats = NonNullable<StatsResponse["stats"]>;

const OUTCOMES: { status: RunStatus; label: string; bar: string; dot: string }[] = [
  { status: "succeeded", label: "Succeeded", bar: "bg-success", dot: "bg-success" },
  { status: "failed", label: "Failed", bar: "bg-danger", dot: "bg-danger" },
  { status: "deferred", label: "Deferred", bar: "bg-warning", dot: "bg-warning" },
  { status: "escalated", label: "Escalated", bar: "bg-attention", dot: "bg-attention" },
  { status: "in_progress", label: "In progress", bar: "bg-info", dot: "bg-info" },
  { status: "abandoned", label: "Abandoned", bar: "bg-neutral", dot: "bg-neutral" },
];

/** Round a max value up to a tidy axis ceiling and step (about 4 intervals). */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 4) {
    return { top: Math.max(max, 1), step: 1 };
  }
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  return { top: Math.ceil(max / step) * step, step };
}

function formatWeek(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return weekStart;
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<(typeof WINDOWS)[number], number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

function parseDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Fill empty weeks so the chart spans the selected range. Buckets are Monday-aligned
 * 7-day steps anchored on the first server bucket; with no buckets there is no anchor.
 */
export function padWeeks(
  weeks: { weekStart: string; count: number }[],
  window: (typeof WINDOWS)[number],
  now: number = Date.now(),
): { weekStart: string; count: number }[] {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  if (!first || !last || Number.isNaN(parseDay(first.weekStart))) {
    return weeks;
  }
  const step = 7 * DAY_MS;
  const anchor = parseDay(first.weekStart);
  const days = WINDOW_DAYS[window];
  const alignDown = (t: number) => anchor + Math.floor((t - anchor) / step) * step;
  const start = Math.min(anchor, days === null ? anchor : alignDown(now - (days - 1) * DAY_MS));
  const end = Math.max(parseDay(last.weekStart), alignDown(now));
  const counts = new Map(weeks.map((week) => [week.weekStart, week.count]));
  const out: { weekStart: string; count: number }[] = [];
  for (let t = start; t <= end && out.length < 200; t += step) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push({ weekStart: key, count: counts.get(key) ?? 0 });
  }
  return out;
}

/** Weekly run counts as an HTML/CSS column chart with gridlines and value labels. */
export function WeeklyChart({ weeks }: { weeks: { weekStart: string; count: number }[] }) {
  const { top, step } = niceScale(Math.max(...weeks.map((week) => week.count), 0));
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) {
    ticks.push(value);
  }
  const scroller = useRef<HTMLDivElement>(null);
  // Narrow screens scroll horizontally: start at the most recent weeks.
  useEffect(() => {
    const el = scroller.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [weeks.length]);
  return (
    <div ref={scroller} className="flex-1 overflow-x-auto pt-6">
      <div className="flex h-full min-w-[20rem]">
        <div className="mr-2 flex w-8 shrink-0 flex-col" aria-hidden="true">
          <div className="relative min-h-60 flex-1">
            {ticks.map((tick) => (
              <span
                key={tick}
                className="absolute right-0 translate-y-1/2 text-xs tabular-nums text-subtle-foreground"
                style={{ bottom: `${(tick / top) * 100}%` }}
              >
                {tick}
              </span>
            ))}
          </div>
          <div className="h-6" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-60 flex-1">
            {ticks.map((tick) => (
              <div
                key={tick}
                className={cn(
                  "absolute inset-x-0 border-t",
                  tick === 0 ? "border-border-strong" : "border-border border-dashed",
                )}
                style={{ bottom: `${(tick / top) * 100}%` }}
              />
            ))}
            <ul className="absolute inset-0 flex items-end">
              {weeks.map((week) => (
                <li
                  key={week.weekStart}
                  className="group relative flex h-full max-w-24 min-w-12 flex-1 basis-12 items-end justify-center px-1.5"
                  title={`Week of ${week.weekStart}: ${week.count} run${week.count === 1 ? "" : "s"}`}
                >
                  <div
                    className={cn(
                      "relative w-full max-w-12 rounded-t-sm transition-opacity group-hover:opacity-80",
                      week.count > 0 ? "bg-chart-1" : "bg-border-strong",
                    )}
                    style={{
                      height: `${(week.count / top) * 100}%`,
                      minHeight: week.count > 0 ? 2 : 1,
                    }}
                  >
                    <span
                      className={cn(
                        "absolute inset-x-0 bottom-full mb-1 text-center text-xs tabular-nums",
                        week.count > 0 ? "font-medium text-foreground" : "text-subtle-foreground",
                      )}
                    >
                      {week.count}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <ul className="flex h-6 pt-1.5">
            {weeks.map((week) => (
              <li
                key={week.weekStart}
                className="max-w-24 min-w-12 flex-1 basis-12 text-center text-xs tabular-nums whitespace-nowrap text-subtle-foreground"
              >
                {formatWeek(week.weekStart)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function OutcomeBreakdown({
  byStatus,
  total,
}: {
  byStatus: Record<RunStatus, number>;
  total: number;
}) {
  const rows = OUTCOMES.filter((outcome) => (byStatus[outcome.status] ?? 0) > 0);
  return (
    <div>
      <div
        className="flex h-2 gap-px overflow-hidden rounded-full bg-raised"
        role="img"
        aria-label={rows
          .map((row) => `${byStatus[row.status]} ${row.label.toLowerCase()}`)
          .join(", ")}
      >
        {rows.map((row) => (
          <div
            key={row.status}
            className={row.bar}
            style={{ width: `${(byStatus[row.status] / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <li key={row.status} className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", row.dot)} aria-hidden="true" />
            <span className="text-muted-foreground">{row.label}</span>
            <span className="ml-auto font-medium tabular-nums">{byStatus[row.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OriginList({ byOrigin }: { byOrigin: Record<RunOrigin, number> }) {
  const entries = (Object.entries(byOrigin) as [RunOrigin, number][])
    .filter(([, count]) => count > 0)
    .slice()
    .sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] ?? 1;
  const zero = (Object.entries(byOrigin) as [RunOrigin, number][])
    .filter(([, count]) => count === 0)
    .map(([origin]) => formatRunOrigin(origin));
  return (
    <div>
      <ul className="space-y-2">
        {entries.map(([origin, count]) => (
          <li key={origin} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-muted-foreground">{formatRunOrigin(origin)}</span>
              <span className="font-medium tabular-nums">{count}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full bg-chart-1"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {zero.length > 0 ? <p className="subtle-text mt-3 text-xs">None: {zero.join(", ")}</p> : null}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs font-medium text-subtle-foreground">{label}</div>
      <div className="mt-0.5 text-xl leading-tight font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-xs text-subtle-foreground">{detail}</div>
    </div>
  );
}

function SummaryRow({ stats }: { stats: Stats }) {
  const { byStatus } = stats.totals;
  const finished = byStatus.succeeded + byStatus.failed + byStatus.escalated;
  const weeks = stats.runsPerWeek.length;
  return (
    <div
      data-slot="stats-summary"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4 [&>div]:bg-card"
    >
      <Metric
        label="Runs"
        value={String(stats.totals.runs)}
        detail={`${weeks} week${weeks === 1 ? "" : "s"} · ${byStatus.in_progress} in progress`}
      />
      <Metric
        label="Success rate"
        value={formatRate(stats.successRate)}
        detail={`${byStatus.succeeded} of ${finished} finished`}
      />
      <Metric
        label="Escalation rate"
        value={formatRate(stats.escalationRate)}
        detail={`${byStatus.escalated} handed to a human`}
      />
      <Metric
        label="Median duration"
        value={stats.medianDurationMs === null ? "–" : formatDuration(stats.medianDurationMs)}
        detail="succeeded runs, pickup to PR"
      />
    </div>
  );
}

function HarnessTable({ rows }: { rows: Stats["byHarness"] }) {
  const num = "px-2 text-right tabular-nums sm:px-4";
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-2 sm:px-4">Harness</TableHead>
            <TableHead className={num}>Runs</TableHead>
            <TableHead className={cn(num, "hidden sm:table-cell")}>Succeeded</TableHead>
            <TableHead className={cn(num, "hidden sm:table-cell")}>Failed</TableHead>
            <TableHead className={cn(num, "hidden md:table-cell")}>Escalated</TableHead>
            <TableHead className="w-28 px-2 sm:w-40 sm:px-4">Success rate</TableHead>
            <TableHead className={cn(num, "hidden sm:table-cell")}>Median</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((harness) => {
            const finished = harness.succeeded + harness.failed + harness.escalated;
            const rate = finished > 0 ? harness.succeeded / finished : null;
            const unknown = harness.harness === "unknown";
            return (
              <TableRow key={harness.harness} className={unknown ? "opacity-60" : undefined}>
                <TableCell className="px-2 py-2.5 font-medium sm:px-4">{harness.harness}</TableCell>
                <TableCell className={cn(num, "py-2.5")}>{harness.runs}</TableCell>
                <TableCell className={cn(num, "hidden py-2.5 sm:table-cell")}>
                  {harness.succeeded}
                </TableCell>
                <TableCell className={cn(num, "hidden py-2.5 sm:table-cell")}>
                  {harness.failed}
                </TableCell>
                <TableCell className={cn(num, "hidden py-2.5 md:table-cell")}>
                  {harness.escalated}
                </TableCell>
                <TableCell className="px-2 py-2.5 sm:px-4">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-success"
                        style={{ width: `${(rate ?? 0) * 100}%` }}
                      />
                    </div>
                    <span className="w-9 text-right tabular-nums">{formatRate(rate)}</span>
                  </div>
                </TableCell>
                <TableCell className={cn(num, "hidden py-2.5 sm:table-cell")}>
                  {harness.medianDurationMs === null
                    ? "–"
                    : formatDuration(harness.medianDurationMs)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading stats">
      <div className="skeleton h-[5.5rem] w-full" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="skeleton h-72 lg:col-span-2" />
        <div className="skeleton h-72" />
      </div>
      <div className="skeleton h-48 w-full" />
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
      <div>
        <FilterGroup
          options={WINDOWS}
          value={window}
          onChange={setWindow}
          formatLabel={(option) => WINDOW_LABELS[option]}
        />
      </div>

      {error ? <EmptyState title="Could not load stats" body={error} /> : null}

      {!data && !error ? <StatsSkeleton /> : null}

      {data && (!stats || stats.totals.runs === 0) ? (
        <EmptyState
          title="No runs in this window"
          body="Stats appear after the worker records its first runs. Try a wider range."
        />
      ) : null}

      {stats && stats.totals.runs > 0 ? (
        <>
          <SummaryRow stats={stats} />

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4 lg:col-span-2">
              <h2 className="section-title">Runs per week</h2>
              <WeeklyChart weeks={padWeeks(stats.runsPerWeek, window)} />
            </section>
            <section className="space-y-5 rounded-lg border border-border bg-card p-4">
              <div>
                <h2 className="section-title mb-3">Outcomes</h2>
                <OutcomeBreakdown byStatus={stats.totals.byStatus} total={stats.totals.runs} />
              </div>
              <div>
                <h2 className="section-title mb-3">Run origin</h2>
                <OriginList byOrigin={stats.byOrigin} />
              </div>
            </section>
          </div>

          {stats.byHarness.length > 0 ? (
            <section>
              <h2 className="section-title mb-2">By harness</h2>
              <HarnessTable rows={stats.byHarness} />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
