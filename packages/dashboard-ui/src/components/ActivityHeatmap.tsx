import { useMemo, useState } from "react";

import { FilterGroup, FilterSelect } from "@/components/shared";
import type { RunActivity, RunOrigin } from "@/lib/api";
import {
  activeOrigins,
  activityGrid,
  formatHour,
  hourTotals,
  intensityStep,
  quietestWindow,
  WEEKDAY_LABELS,
} from "@/lib/run-activity";
import type { ActivityMetric } from "@/lib/run-activity";
import { formatRunOrigin } from "@/lib/run-origin";
import { cn, formatDuration } from "@/lib/utils";

const METRICS = ["starts", "busyMs"] as const;
const METRIC_LABELS: Record<ActivityMetric, string> = {
  starts: "Runs started",
  busyMs: "Agent time",
};

/** Sequential single-hue ramp: empty cells stay neutral, activity steps up in chart-1. */
const STEP_BACKGROUND = [
  "var(--raised)",
  "color-mix(in srgb, var(--chart-1) 28%, transparent)",
  "color-mix(in srgb, var(--chart-1) 52%, transparent)",
  "color-mix(in srgb, var(--chart-1) 76%, transparent)",
  "var(--chart-1)",
];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const GRID_COLUMNS = "2.25rem repeat(24, minmax(1.125rem, 1fr))";

function formatMetric(metric: ActivityMetric, value: number): string {
  if (metric === "starts") {
    return `${value} run${value === 1 ? "" : "s"} started`;
  }
  return value > 0 ? `${formatDuration(value)} agent time` : "no agent time";
}

function cellLabel(weekday: number, hour: number, starts: number, busyMs: number): string {
  return `${WEEKDAY_LABELS[weekday]} ${formatHour(hour)}–${formatHour(hour + 1)}: ${formatMetric("starts", starts)}, ${formatMetric("busyMs", busyMs)}`;
}

/**
 * Weekday × hour heatmap of when runs start and when agents are busy, with an
 * hour-of-day profile and the quietest block to place new automations in.
 */
export function ActivityHeatmap({
  activity,
  timeZoneControl,
}: {
  activity: RunActivity;
  /** Optional control (e.g. worker vs browser timezone) rendered in the toolbar. */
  timeZoneControl?: React.ReactNode;
}) {
  const [metric, setMetric] = useState<ActivityMetric>("starts");
  const [origin, setOrigin] = useState<RunOrigin | "all">("all");
  const [focus, setFocus] = useState<{ weekday: number; hour: number } | null>(null);

  const origins = useMemo(() => activeOrigins(activity), [activity]);
  const effectiveOrigin = origin === "all" || origins.includes(origin) ? origin : "all";
  const starts = useMemo(
    () => activityGrid(activity, "starts", effectiveOrigin),
    [activity, effectiveOrigin],
  );
  const busy = useMemo(
    () => activityGrid(activity, "busyMs", effectiveOrigin),
    [activity, effectiveOrigin],
  );
  const grid = metric === "starts" ? starts : busy;
  const max = Math.max(0, ...grid.flat());
  const hours = hourTotals(grid);
  const hourMax = Math.max(0, ...hours);
  const busyHours = hourTotals(busy);
  const totalBusy = busyHours.reduce((sum, ms) => sum + ms, 0);
  const quiet = quietestWindow(busyHours, 4);
  const idleHours = busyHours.filter((ms) => ms === 0).length;
  const startHours = hourTotals(starts);
  const peakHour = startHours.indexOf(Math.max(...startHours));

  const readout = focus
    ? cellLabel(
        focus.weekday,
        focus.hour,
        starts[focus.weekday]?.[focus.hour] ?? 0,
        busy[focus.weekday]?.[focus.hour] ?? 0,
      )
    : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterGroup
          options={METRICS}
          value={metric}
          onChange={setMetric}
          formatLabel={(option) => METRIC_LABELS[option]}
        />
        {origins.length > 1 ? (
          <FilterSelect
            label="Origin"
            options={["all", ...origins] as const}
            value={effectiveOrigin}
            onChange={setOrigin}
            formatLabel={(option) => (option === "all" ? "All" : formatRunOrigin(option))}
          />
        ) : null}
        {timeZoneControl}
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-slot="activity-insights">
        <div className="flex gap-1.5">
          <dt className="text-subtle-foreground">Peak pickup</dt>
          <dd className="font-medium tabular-nums">
            {startHours[peakHour] ? formatHour(peakHour) : "–"}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-subtle-foreground">Quietest 4h</dt>
          <dd className="font-medium tabular-nums">
            {formatHour(quiet.startHour)}–{formatHour(quiet.startHour + 4)}
            <span className="ml-1 font-normal text-subtle-foreground">
              ({totalBusy > 0 ? Math.round((quiet.total / totalBusy) * 100) : 0}% of agent time)
            </span>
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-subtle-foreground">Idle hours</dt>
          <dd className="font-medium tabular-nums">{idleHours} of 24</dd>
        </div>
      </dl>

      <div className="overflow-x-auto">
        <div className="min-w-[34rem]" onMouseLeave={() => setFocus(null)}>
          <div
            role="grid"
            aria-label={`${METRIC_LABELS[metric]} by weekday and hour (${activity.timezone})`}
            className="grid gap-0.5"
            style={{ gridTemplateColumns: GRID_COLUMNS }}
          >
            {WEEKDAY_LABELS.map((day, weekday) => (
              <div key={day} role="row" className="contents">
                <div
                  role="rowheader"
                  className="pr-2 text-right text-xs leading-5 text-subtle-foreground"
                >
                  {day}
                </div>
                {HOURS.map((hour) => {
                  const value = grid[weekday]?.[hour] ?? 0;
                  const active = focus?.weekday === weekday && focus.hour === hour;
                  return (
                    <div
                      key={hour}
                      role="gridcell"
                      tabIndex={weekday === 0 && hour === 0 ? 0 : -1}
                      aria-label={cellLabel(
                        weekday,
                        hour,
                        starts[weekday]?.[hour] ?? 0,
                        busy[weekday]?.[hour] ?? 0,
                      )}
                      onMouseEnter={() => setFocus({ weekday, hour })}
                      onFocus={() => setFocus({ weekday, hour })}
                      onBlur={() => setFocus(null)}
                      className={cn(
                        "h-5 rounded-[3px] outline-none",
                        active && "ring-2 ring-foreground/60",
                      )}
                      style={{ background: STEP_BACKGROUND[intensityStep(value, max)] }}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          {/* Hour-of-day profile: the column totals, aligned under the grid. */}
          <div className="mt-2 grid gap-0.5" style={{ gridTemplateColumns: GRID_COLUMNS }}>
            <div className="pr-2 text-right text-xs leading-4 text-subtle-foreground">All</div>
            {HOURS.map((hour) => {
              const value = hours[hour] ?? 0;
              return (
                <div
                  key={hour}
                  className="flex h-10 items-end"
                  title={`${formatHour(hour)}–${formatHour(hour + 1)}: ${formatMetric(metric, value)}`}
                >
                  <div
                    className={cn("w-full rounded-t-[3px]", value > 0 ? "bg-chart-1" : "bg-border")}
                    style={{
                      height: hourMax > 0 ? `${(value / hourMax) * 100}%` : 0,
                      minHeight: 1,
                    }}
                  />
                </div>
              );
            })}
            <div />
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="text-center text-[0.6875rem] tabular-nums text-subtle-foreground"
              >
                {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-subtle-foreground">
        <span aria-live="polite" className="min-h-4 tabular-nums">
          {readout ?? `Hours in ${activity.timezone}. Hover a cell for details.`}
        </span>
        <span className="flex items-center gap-1" aria-hidden="true">
          Less
          {STEP_BACKGROUND.map((background) => (
            <span key={background} className="size-3 rounded-[3px]" style={{ background }} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}
