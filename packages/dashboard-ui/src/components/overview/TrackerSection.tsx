import { TriangleAlert } from "lucide-react";
import {
  formatAgo,
  formatInterval,
  formatTracker,
  pollFreshness,
} from "@/components/overview/overview-model";
import type { OverviewTrackerSource, OverviewTrackers } from "@/lib/api-overview";
import { cn } from "@/lib/utils";
import { PANEL, Section } from "@/components/overview/OverviewPanel";

/** DOM id of a tracker source row (target of the stale-poll banner links). */
export function trackerRowId(source: OverviewTrackerSource): string {
  return `ov-tracker-${source.cursorSource.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function sourceName(source: OverviewTrackerSource): string {
  return source.team ?? formatTracker(source.tracker);
}

/* ---------- Alerts ---------- */

function TrackerRow({
  source,
  intervalSeconds,
  workerRunning,
  now,
}: {
  source: OverviewTrackerSource;
  intervalSeconds?: number;
  workerRunning: boolean;
  now: number;
}) {
  const freshness = pollFreshness(source.lastPolledAt, intervalSeconds, now);
  // A stopped worker explains every old cursor; only flag polls it should be making.
  const stale = freshness === "stale" && workerRunning;
  const routing = source.repo ?? "routed by rules";
  return (
    <li
      id={trackerRowId(source)}
      tabIndex={-1}
      data-freshness={stale ? "stale" : freshness === "never" ? "never" : "fresh"}
      className={cn(
        "ov-focus-target grid min-h-13 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2",
        stale && "bg-warning-subtle",
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground" title={source.taskQuery}>
          {sourceName(source)}
        </span>
        <span className="truncate text-xs text-subtle-foreground">
          {source.team ? `${formatTracker(source.tracker)} · ${routing}` : routing}
        </span>
      </span>
      <span
        className="flex flex-col items-end text-[0.8125rem] whitespace-nowrap"
        title={
          source.lastPolledAt !== undefined
            ? `Last polled ${new Date(source.lastPolledAt).toLocaleString()}`
            : undefined
        }
      >
        {freshness === "never" || source.lastPolledAt === undefined ? (
          <span className="text-subtle-foreground">not polled yet</span>
        ) : (
          <>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 tabular-nums",
                stale ? "font-semibold text-warning" : "text-muted-foreground",
              )}
            >
              {stale ? <TriangleAlert className="size-3.5" aria-hidden="true" /> : null}
              {formatAgo(source.lastPolledAt, now)}
            </span>
            {stale ? (
              <span className="text-xs text-[color-mix(in_srgb,var(--foreground)_70%,var(--warning))]">
                expected {formatInterval(intervalSeconds ?? 60)}
              </span>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}

export function TrackerSection({
  trackers,
  configOk,
  workerRunning,
  now,
}: {
  trackers: OverviewTrackers;
  configOk: boolean;
  workerRunning: boolean;
  now: number;
}) {
  return (
    <Section
      id="ov-trackers"
      title="Tracker sources"
      meta={
        trackers.pollIntervalSeconds !== undefined && trackers.sources.length > 0
          ? `polled ${formatInterval(trackers.pollIntervalSeconds)}`
          : undefined
      }
    >
      {trackers.sources.length > 0 ? (
        <ul className={cn(PANEL, "divide-y divide-border")}>
          {trackers.sources.map((source) => (
            <TrackerRow
              key={source.cursorSource}
              source={source}
              intervalSeconds={trackers.pollIntervalSeconds}
              workerRunning={workerRunning}
              now={now}
            />
          ))}
        </ul>
      ) : (
        <p className={cn(PANEL, "px-4 py-3.5 text-[0.8125rem] text-muted-foreground")}>
          {configOk
            ? "No tracker polling configured. Add [[teams]], or a tracker and task_query under [defaults], to workspace.toml."
            : "Tracker sources appear once workspace.toml loads."}
        </p>
      )}
    </Section>
  );
}

/* ---------- Screen ---------- */
