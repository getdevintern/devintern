import { useEffect, useMemo, useRef, useState } from "react";

import { X, Search, ArrowDown } from "lucide-react";

import { EmptyState, FilterGroup } from "@/components/shared";
import { usePoll } from "@/lib/api";
import type { LogsResponse, WorkerLogLevel } from "@/lib/api";
import { matchesQuery, severityCounts } from "@/lib/log-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./logs.css";

type LevelFilter = WorkerLogLevel | "all";

const LEVEL_FILTERS = ["all", "warn", "error"] as const;

/**
 * Rows rendered initially and added per "Show older" click. The server window
 * is bounded by the API limit, but at 1000 entries every 5s poll would
 * re-render/reconcile the full list; the cap keeps the DOM small and grows
 * only when the user asks for older history.
 */
const RENDER_STEP = 400;

const LEVEL_LABELS: Record<LevelFilter, string> = {
  all: "All",
  info: "Info",
  warn: "Warnings",
  error: "Errors",
};

const LEVEL_TEXT: Record<WorkerLogLevel, string> = {
  info: "text-subtle-foreground",
  warn: "text-warning",
  error: "text-danger",
};

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Local calendar-day key used to place day separators. */
function dayKey(timestamp: number | null): string {
  if (timestamp === null) {
    return "";
  }
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Global worker log stream, tailed from the machine running the worker. */
export function LogsView() {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);

  const { data, error } = usePoll<LogsResponse>(`/api/logs?level=${encodeURIComponent(level)}`);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(following);
  followRef.current = following;

  const visible = useMemo(
    () =>
      (data?.entries ?? []).filter(
        (entry) => entry.message.trim() !== "" && matchesQuery(entry, query),
      ),
    [data, query],
  );
  // Counts come from the unfiltered window; while a level filter is active
  // the other level's count is the last one seen under "all".
  const windowCounts = useMemo(() => severityCounts(data?.entries ?? []), [data]);
  const allCounts = useRef({ error: 0, warn: 0 });
  if (data && level === "all") {
    allCounts.current = windowCounts;
  }
  const counts = {
    error: level === "warn" ? allCounts.current.error : windowCounts.error,
    warn: level === "error" ? allCounts.current.warn : windowCounts.warn,
  };
  const levelLabel = (option: LevelFilter): string => {
    const count = option === "warn" || option === "error" ? counts[option] : 0;
    return count > 0 ? `${LEVEL_LABELS[option]} ${count}` : LEVEL_LABELS[option];
  };

  const [renderCap, setRenderCap] = useState(RENDER_STEP);
  // Newest entries stay pinned to the bottom (follow mode), so the cap hides
  // the oldest ones. Filters change what matters, so restart the window there.
  const rendered = useMemo(
    () => (visible.length > renderCap ? visible.slice(visible.length - renderCap) : visible),
    [visible, renderCap],
  );
  const hiddenCount = visible.length - rendered.length;

  useEffect(() => {
    setRenderCap(RENDER_STEP);
  }, [query, level]);

  useEffect(() => {
    if (!followRef.current || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [rendered]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const jumpToEnd = (): void => {
    setFollowing(true);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  };

  const unreadable = data?.sources.filter((source) => source.error) ?? [];
  let status = "";
  if (data?.available) {
    const total = data.entries.length;
    status = query ? `${visible.length} of ${total} match` : `${total} entries`;
    if (data.truncated) {
      status += " (newest)";
    }
  }
  let lastDay = "";

  return (
    <div>
      <div className="toolbar">
        <FilterGroup
          options={LEVEL_FILTERS}
          value={level}
          onChange={setLevel}
          formatLabel={levelLabel}
        />
        <div className="logs-search">
          <Search className="logs-search-icon size-4" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this window"
            aria-label="Search log entries"
          />
          {query ? (
            <button
              type="button"
              className="logs-search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="toolbar-spacer flex items-center gap-3">
          {status ? <span className="subtle-text text-xs tabular-nums">{status}</span> : null}
          {!following ? (
            <Button type="button" size="sm" variant="outline" onClick={jumpToEnd}>
              <ArrowDown aria-hidden="true" />
              Latest
            </Button>
          ) : null}
        </div>
      </div>

      {unreadable.length > 0 ? (
        <p className="mb-3 text-xs text-warning">
          Unreadable: {unreadable.map((source) => `${source.path} (${source.error})`).join(", ")}
        </p>
      ) : null}

      {error ? <EmptyState title="Could not load logs" body={error} /> : null}

      {data && !data.available ? (
        <EmptyState
          title="No worker logs yet"
          body={
            "The worker writes no capture files here yet. When it runs as a background " +
            "service (launchd), output is captured into worker.stdout.log and " +
            "worker.stderr.log next to its working directory; a foreground worker logs " +
            "straight to its terminal."
          }
        />
      ) : null}

      {data && data.available && visible.length === 0 ? (
        <EmptyState
          title={query ? "No matching entries" : "No log entries in this window"}
          body={
            query
              ? "Try a different search, or switch the level filter back to all."
              : "Log lines appear here as the worker runs."
          }
        />
      ) : null}

      {data && data.available && visible.length > 0 ? (
        <div className="logs-panel">
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setRenderCap((cap) => cap + RENDER_STEP)}
              className="logs-more"
            >
              Show {Math.min(RENDER_STEP, hiddenCount)} older entries
            </button>
          ) : null}
          <div ref={scrollRef} onScroll={onScroll} className="logs-scroll">
            {rendered.map((entry) => {
              const key = dayKey(entry.timestamp);
              const showDay = entry.timestamp !== null && key !== lastDay;
              if (entry.timestamp !== null) {
                lastDay = key;
              }
              const full =
                entry.timestamp === null
                  ? "unknown time"
                  : new Date(entry.timestamp).toLocaleString();
              return (
                <div key={entry.index}>
                  {showDay && entry.timestamp !== null ? (
                    <div className="logs-day">{dayFormat.format(entry.timestamp)}</div>
                  ) : null}
                  <div className="logs-row" data-level={entry.level}>
                    <span className="logs-time" title={full}>
                      {entry.timestamp === null ? "–" : clockFormat.format(entry.timestamp)}
                    </span>
                    <span
                      className={cn("logs-level", LEVEL_TEXT[entry.level])}
                      title={entry.stream === "err" ? "stderr" : "stdout"}
                    >
                      {entry.level}
                    </span>
                    <span className={cn("logs-msg", entry.level === "error" && "text-danger")}>
                      {entry.message}
                    </span>
                    {entry.runId ? (
                      <a
                        href={`#/runs/${entry.runId}`}
                        className="logs-task ref-link"
                        title={`Open ${entry.runStatus ?? ""} run ${entry.runId}`}
                      >
                        {entry.taskKey ?? `run ${entry.runId}`}
                      </a>
                    ) : entry.taskKey ? (
                      <span className="logs-task subtle-text">{entry.taskKey}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
