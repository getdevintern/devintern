import { Fragment } from "react";
import type { ReactNode } from "react";
import { queueTitle } from "@/components/StatusStrip";
import {
  formatIn,
  formatSpan,
  windowSpec,
  workerUptime,
} from "@/components/overview/overview-model";
import type { ScheduleSnapshot, WorkerResponse } from "@/lib/api";
import type { OverviewResponse } from "@/lib/api-overview";
import { cn, formatPastTime } from "@/lib/utils";

export function queueTotal(queue: WorkerResponse["queue"]): number {
  return (
    queue.pending +
    queue.processing +
    queue.injected.pending +
    queue.injected.running +
    queue.retries.pending +
    queue.retries.running
  );
}

/** "1 picked up" or "none picked up yet": progress the strip's total does not show. */
export function queueProgress(queue: WorkerResponse["queue"]): string {
  // The strip already shows the total; this only says whether any of it has started.
  const active = queue.processing + queue.injected.running + queue.retries.running;
  return active > 0 ? `${active} picked up` : "none picked up yet";
}

/** Only the non-empty parts of the queue, e.g. "2 webhook · 1 ad-hoc". */
export function queueBreakdown(queue: WorkerResponse["queue"]): string {
  return queueParts(queue).join(" · ") || "nothing waiting";
}

/** Each non-empty queue part as one "N label" unit, so wrapping never splits a count from its label. */
export function queueParts(queue: WorkerResponse["queue"]): string[] {
  const retries = queue.retries.pending + queue.retries.running;
  const parts: [number, string][] = [
    [queue.pending + queue.processing, "webhook"],
    [queue.injected.pending + queue.injected.running, "ad-hoc"],
    [retries, retries === 1 ? "retry" : "retries"],
  ];
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
}

function Fact({
  label,
  value,
  detail,
  title,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  title?: string;
  tone?: "danger" | "muted";
}) {
  return (
    <div className="min-w-0 px-5 py-3.5" title={title}>
      <dt className="text-xs font-medium text-subtle-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] tabular-nums",
          tone === "danger"
            ? "text-danger"
            : tone === "muted"
              ? "text-muted-foreground"
              : "text-foreground",
        )}
      >
        {value}
      </dd>
      {detail ? (
        <dd className="mt-px text-xs [overflow-wrap:anywhere] text-subtle-foreground tabular-nums">
          {detail}
        </dd>
      ) : null}
    </div>
  );
}

/** The one "no value" mark used across the page. */
const PLACEHOLDER = "–";

function windowFact(schedule: ScheduleSnapshot | null | undefined, configOk: boolean, now: number) {
  // Without a loaded config nothing is known about the window, let alone "always on".
  if (!configOk)
    return { value: PLACEHOLDER, detail: "set in workspace.toml", tone: "muted" as const };
  if (!schedule?.enabled) {
    return { value: "No window", detail: "picks up work around the clock" };
  }
  const spec = windowSpec(schedule);
  const next = schedule.nextChange;
  if (schedule.manualRequested) return { value: spec, detail: "manual run requested" };
  // The strip shows the next clock time; the band adds the spec and the countdown.
  if (schedule.pickupAllowed) {
    return {
      value: spec,
      detail: next ? `open for another ${formatSpan(Math.max(0, next.at - now))}` : "open",
    };
  }
  return {
    value: spec,
    detail: next ? `closed · reopens ${formatIn(next.at, now)}` : "closed",
    tone: "muted" as const,
  };
}

/**
 * What the status strip does not say: how long the worker has been up, the
 * window it works in, and what the queue is made of.
 */
export function WorkerFacts({
  overview,
  workerInfo,
  now,
}: {
  overview: OverviewResponse;
  workerInfo: WorkerResponse | null;
  now: number;
}) {
  const { worker } = overview;
  const uptime = workerUptime(worker, now);
  const started = worker.startedAt ? Date.parse(worker.startedAt) : Number.NaN;
  const window = workerInfo
    ? windowFact(workerInfo.schedule, overview.config.status === "ok", now)
    : null;
  const queue = workerInfo?.queue;
  const total = queue ? queueTotal(queue) : 0;
  // An empty queue is already "0 queued" in the strip; only show the mix when there is one.
  const showQueue = queue !== undefined && total > 0;
  return (
    <dl
      aria-label="Worker"
      className={cn(
        "grid divide-y divide-border rounded-lg border border-border bg-card sm:divide-x sm:divide-y-0",
        showQueue ? "sm:grid-cols-3" : "sm:grid-cols-2",
      )}
    >
      <Fact
        label="Uptime"
        value={uptime !== null ? formatSpan(uptime) : PLACEHOLDER}
        tone={uptime === null ? "muted" : undefined}
        detail={
          uptime !== null && !Number.isNaN(started)
            ? `started ${formatPastTime(started, now)}`
            : worker.status === "running"
              ? "start time unknown"
              : worker.status === "stopped"
                ? "worker stopped"
                : "liveness unknown"
        }
        title={worker.lockFile ? `Read from ${worker.lockFile}` : undefined}
      />
      <Fact
        label="Working window"
        value={window?.value ?? PLACEHOLDER}
        detail={window?.detail ?? "loading…"}
        tone={window?.tone}
      />
      {showQueue ? (
        <Fact
          label="Queue mix"
          value={queueParts(queue).map((part, index) => (
            <Fragment key={part}>
              {index > 0 ? " · " : null}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
          title={queueTitle(queue)}
          detail={
            queue.failed > 0 ? (
              <span className="text-danger">
                {queue.failed} failed {queue.failed === 1 ? "delivery" : "deliveries"}
              </span>
            ) : (
              queueProgress(queue)
            )
          }
        />
      ) : null}
    </dl>
  );
}

/* ---------- Active work ---------- */
