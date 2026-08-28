import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState, FilterGroup } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { usePoll } from "@/lib/api";
import type { LogsResponse, WorkerLogLevel } from "@/lib/api";
import { levelDotClass, matchesQuery, severityCounts } from "@/lib/log-view";
import { cn, formatTime } from "@/lib/utils";

type LevelFilter = WorkerLogLevel | "all";

const LEVEL_FILTERS = ["all", "warn", "error"] as const;

/**
 * Rows rendered initially and added per "Show older" click. The server window
 * is bounded by the API limit, but at 1000 entries every 5s poll would
 * re-render/reconcile the full list; the cap keeps the DOM small and grows
 * only when the user asks for older history.
 */
const RENDER_STEP = 400;

function levelFilterLabel(level: LevelFilter): string {
  if (level === "all") {
    return "everything";
  }
  return level === "warn" ? "warnings" : "errors";
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
    () => (data?.entries ?? []).filter((entry) => matchesQuery(entry, query)),
    [data, query],
  );
  const counts = useMemo(() => severityCounts(data?.entries ?? []), [data]);

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterGroup
            options={LEVEL_FILTERS}
            value={level}
            onChange={setLevel}
            formatLabel={levelFilterLabel}
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this window…"
            aria-label="Search log entries"
            className="w-56 rounded-md border bg-background px-2.5 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {counts.error} error{counts.error === 1 ? "" : "s"} · {counts.warn} warning
            {counts.warn === 1 ? "" : "s"}
          </span>
          {!following ? (
            <button
              type="button"
              onClick={jumpToEnd}
              className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
            >
              ↓ Jump to latest
            </button>
          ) : null}
        </div>
      </div>

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
              ? "Try a different search, or switch the level filter back to everything."
              : "Log lines appear here as the worker runs."
          }
        />
      ) : null}

      {data && data.available && visible.length > 0 ? (
        <Card className="py-0">
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setRenderCap((cap) => cap + RENDER_STEP)}
              className="w-full border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              ↑ Show {Math.min(RENDER_STEP, hiddenCount)} older entries
            </button>
          ) : null}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="max-h-[60vh] overflow-auto font-mono text-xs leading-relaxed"
          >
            {rendered.map((entry) => (
              <div
                key={entry.index}
                className="flex gap-3 border-b border-border/50 px-3 py-1 last:border-b-0"
              >
                <span
                  className={cn(
                    "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                    levelDotClass(entry.level),
                  )}
                  title={`${entry.level}${entry.stream === "err" ? " (stderr)" : ""}`}
                />
                <span
                  className="w-28 shrink-0 tabular-nums text-muted-foreground"
                  title={
                    entry.timestamp === null
                      ? "unknown time"
                      : new Date(entry.timestamp).toLocaleString()
                  }
                >
                  {entry.timestamp === null ? "–" : formatTime(entry.timestamp)}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                  {entry.message}
                </span>
                {entry.runId ? (
                  <a
                    href={`#/runs/${entry.runId}`}
                    className="shrink-0 self-center"
                    title={`Open ${entry.runStatus ?? ""} run ${entry.runId}`}
                  >
                    {entry.taskKey ? (
                      <Badge variant="outline">{entry.taskKey}</Badge>
                    ) : (
                      `run ${entry.runId}`
                    )}
                  </a>
                ) : entry.taskKey ? (
                  <Badge variant="outline" className="shrink-0 self-center opacity-70">
                    {entry.taskKey}
                  </Badge>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {data && data.available ? (
        <div className="text-xs text-muted-foreground">
          {query ? `Matching ${visible.length} of ` : ""}
          {data.entries.length}
          {data.entries.length === 1 ? " entry" : " entries"} read from disk.
          {hiddenCount > 0 ? ` Showing the newest ${rendered.length}.` : ""}
          {data.truncated ? " Older history beyond this tail window is not loaded." : null}
          {data.sources.some((source) => source.error) ? (
            <>
              {" "}
              Unreadable:{" "}
              {data.sources
                .filter((source) => source.error)
                .map((source) => `${source.path} (${source.error})`)
                .join(", ")}
              .
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
