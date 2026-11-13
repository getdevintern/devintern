import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  CirclePause,
  Copy,
  FileWarning,
  FileX,
  PowerOff,
  RadioTower,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { queueTitle } from "@/components/StatusStrip";
import { EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ActiveRows, RecentlyFinished, WaitingRows } from "@/components/overview/ActiveWork";
import {
  consumeHarnessFocus,
  HARNESS_SECTION_ID,
  revealElement,
} from "@/components/overview/focus";
import {
  capacityRatio,
  formatAgo,
  formatClock,
  formatIn,
  formatInterval,
  formatSpan,
  formatTracker,
  harnessSummary,
  overviewAlerts,
  pollFreshness,
  resumingHarness,
  windowSpec,
  workerUptime,
} from "@/components/overview/overview-model";
import type { OverviewAlert } from "@/components/overview/overview-model";
import { InfoHint } from "@/components/overview/InfoHint";
import { useOverviewPoll } from "@/components/overview/overview-store";
import { useNow } from "@/components/overview/use-now";
import { usePoll } from "@/lib/api";
import type {
  OverviewCapacity,
  OverviewHarnessEntry,
  OverviewHarnesses,
  OverviewResponse,
  OverviewTrackerSource,
  OverviewTrackers,
  RunRecord,
  ScheduleSnapshot,
  TaskActivityResponse,
  WorkerResponse,
} from "@/lib/api";
import { runHash } from "@/lib/routes";
import { buildActiveWork } from "@/lib/task-activity";
import { cn, formatPastTime } from "@/lib/utils";
// oxlint-disable-next-line import/no-unassigned-import -- meter and chain styles
import "./overview.css";

const PANEL = "overflow-hidden rounded-lg border border-border bg-card";

/* ---------- Building blocks ---------- */

function Section({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0">
      <header className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 id={`${id}-title`} className="section-title">
          {title}
        </h2>
        {meta ? (
          <div className="min-w-0 truncate text-xs text-subtle-foreground tabular-nums">{meta}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/**
 * Segmented usage meter: one segment per slot up to 24 slots, a continuous bar
 * beyond that. Only over-capacity (orphaned rows) turns it amber.
 */
function Meter({
  running,
  max,
  label,
  size = "md",
  stalled = false,
}: {
  running: number;
  max: number;
  label: string;
  size?: "md" | "sm";
  /** The worker is stopped: the fill is neutral, not a healthy blue. */
  stalled?: boolean;
}) {
  const ratio = capacityRatio(running, max) ?? 0;
  return (
    <div
      className="ov-meter"
      data-size={size}
      data-segmented={max <= 24 ? "" : undefined}
      data-over={running > max ? "" : undefined}
      data-stalled={stalled ? "" : undefined}
      style={{ "--ov-segments": max, "--ov-fill": `${ratio * 100}%` } as React.CSSProperties}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(running, max)}
      aria-valuetext={`${running} of ${max}`}
    >
      <span className="ov-meter-fill" />
    </div>
  );
}

function CapacityBadge({ running, max }: { running: number; max: number | null }) {
  if (max === null || running < max) return null;
  return running > max ? (
    <Badge variant="warning">over capacity</Badge>
  ) : (
    <Badge variant="neutral">at capacity</Badge>
  );
}

function queueTotal(queue: WorkerResponse["queue"]): number {
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

/** DOM id of a tracker source row (target of the stale-poll banner links). */
function trackerRowId(source: OverviewTrackerSource): string {
  return `ov-tracker-${source.cursorSource.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function sourceName(source: OverviewTrackerSource): string {
  return source.team ?? formatTracker(source.tracker);
}

/* ---------- Alerts ---------- */

const ALERT_TONES = {
  danger: {
    box: "border-danger-border bg-danger-subtle",
    icon: "bg-danger/15 text-danger",
    text: "text-[color-mix(in_srgb,var(--foreground)_82%,var(--danger))]",
  },
  warning: {
    box: "border-warning-border bg-warning-subtle",
    icon: "bg-warning/15 text-warning",
    text: "text-[color-mix(in_srgb,var(--foreground)_82%,var(--warning))]",
  },
} as const;

function AlertBanner({
  tone,
  icon: Icon,
  title,
  children,
  aside,
  action,
  prominent = false,
}: {
  tone: "danger" | "warning";
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
  prominent?: boolean;
}) {
  const colors = ALERT_TONES[tone];
  return (
    <div
      data-slot="overview-alert"
      data-tone={tone}
      data-prominent={prominent ? "" : undefined}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2 rounded-lg border sm:grid-cols-[auto_minmax(0,1fr)_auto]",
        prominent ? "items-center px-5 py-4" : "items-start px-4 py-3.5",
        colors.box,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center",
          prominent ? "size-10 rounded-[10px]" : "size-7 rounded-md",
          colors.icon,
        )}
      >
        <Icon className={prominent ? "size-5" : "size-4"} />
      </span>
      <div className={cn("min-w-0", !prominent && "pt-0.5")}>
        <p
          className={cn(
            "font-semibold text-foreground",
            prominent ? "text-base tracking-[-0.01em]" : "text-sm",
          )}
        >
          {title}
        </p>
        {children ? (
          <div className={cn("mt-0.5 max-w-[75ch] text-[0.8125rem] leading-relaxed", colors.text)}>
            {children}
          </div>
        ) : null}
      </div>
      {aside ?? null}
      {action ? <div className="col-start-2 self-center sm:col-start-auto">{action}</div> : null}
    </div>
  );
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href}>
        {children}
        <ArrowRight aria-hidden="true" />
      </a>
    </Button>
  );
}

function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      title={command}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => setCopied(true));
      }}
    >
      {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy command"}</span>
    </Button>
  );
}

function Code({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  return (
    <code
      className={cn(
        "rounded bg-background/55 px-1 py-px font-mono text-xs text-foreground",
        wrap ? "[overflow-wrap:anywhere]" : "whitespace-nowrap",
      )}
    >
      {children}
    </code>
  );
}

/** One banner per degraded state; exported for tests. */
export function OverviewAlertBanner({
  alert,
  now,
  pollIntervalSeconds,
  queued,
}: {
  alert: OverviewAlert;
  now: number;
  pollIntervalSeconds?: number;
  /** Total queued work, when known (from `/api/worker`). */
  queued?: number;
}) {
  switch (alert.kind) {
    case "config-missing":
      return (
        <AlertBanner
          tone="warning"
          icon={FileX}
          title="No workspace configuration"
          action={<CopyCommandButton command="devintern worker init" />}
        >
          Nothing exists at <Code wrap>{alert.path}</Code>. Run <Code>devintern worker init</Code>{" "}
          to create it; capacity limits and tracker sources appear here once it loads.
        </AlertBanner>
      );
    case "config-invalid":
      return (
        <AlertBanner
          tone="danger"
          icon={FileWarning}
          title="workspace.toml could not be loaded"
          action={<LinkButton href="#/workspace">Open workspace</LinkButton>}
        >
          <p>
            Fix <Code wrap>{alert.path}</Code>. A running worker keeps its last valid configuration
            until the file loads again.
          </p>
          {alert.error ? (
            <pre className="mt-2 overflow-x-auto rounded-md border border-danger-border bg-background/70 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-foreground">
              {alert.error}
            </pre>
          ) : null}
        </AlertBanner>
      );
    case "worker-stopped":
      return (
        <AlertBanner
          tone="danger"
          icon={PowerOff}
          title="Worker is not running"
          action={<LinkButton href="#/logs">Open worker logs</LinkButton>}
        >
          New tickets are not being picked up
          {alert.pid !== undefined ? ` (the lock left by pid ${alert.pid} is stale)` : ""}. Start it
          with <Code>devintern worker</Code>, or restart its service.
        </AlertBanner>
      );
    case "harnesses-exhausted": {
      const waiting =
        queued !== undefined && queued > 0
          ? `${queued} queued ${queued === 1 ? "task waits" : "tasks wait"}`
          : "New agent work waits";
      return (
        <AlertBanner
          tone="warning"
          icon={CirclePause}
          prominent
          title={
            alert.resumesAt !== undefined
              ? `Agent work is paused until ${formatClock(alert.resumesAt, now)}`
              : "Agent work is paused"
          }
          aside={
            alert.resumesAt !== undefined ? (
              <div className="col-start-2 flex flex-col sm:col-start-auto sm:items-end sm:border-l sm:border-warning-border sm:pl-5 sm:text-right">
                <span className="text-2xl leading-tight font-semibold tracking-[-0.02em] whitespace-nowrap text-warning tabular-nums">
                  {formatIn(alert.resumesAt, now)}
                </span>
                <span className="text-xs whitespace-nowrap text-[color-mix(in_srgb,var(--foreground)_70%,var(--warning))]">
                  resumes automatically
                </span>
              </div>
            ) : undefined
          }
        >
          Every harness in the chain has hit its usage limit. {waiting}
          {alert.resumesWith ? (
            <>
              {" "}
              and the worker resumes with{" "}
              <strong className="text-foreground">{alert.resumesWith}</strong> when its window ends.
            </>
          ) : (
            " until a window ends."
          )}
        </AlertBanner>
      );
    }
    case "stale-polls": {
      const interval = formatInterval(pollIntervalSeconds ?? 60);
      const [first] = alert.sources;
      return (
        <AlertBanner
          tone="warning"
          icon={RadioTower}
          title={
            alert.sources.length === 1
              ? "Tracker polling has stalled"
              : `Tracker polling has stalled for ${alert.sources.length} sources`
          }
          action={<LinkButton href="#/logs">Check worker logs</LinkButton>}
        >
          {alert.sources.map((source, index) => (
            <span key={source.cursorSource}>
              {index > 0 ? ", " : ""}
              <button
                type="button"
                className="rounded-sm font-semibold text-foreground underline decoration-dotted underline-offset-3 hover:decoration-solid"
                onClick={() => revealElement(trackerRowId(source))}
              >
                {sourceName(source)}
              </button>
            </span>
          ))}
          {alert.sources.length === 1 && first?.lastPolledAt !== undefined
            ? ` last polled ${formatAgo(first.lastPolledAt, now)}; polls are expected ${interval}.`
            : ` have not polled on schedule; polls are expected ${interval}.`}{" "}
          Tracker credentials or network errors usually show up in the worker logs.
        </AlertBanner>
      );
    }
  }
}

/* ---------- Worker facts ---------- */

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
function WorkerFacts({
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

function openRun(id: number): void {
  window.location.hash = runHash(id);
}

const CAPACITY_HINT =
  "Counts every in-progress run against the workspace's max_concurrency, including PR review, CI fix and conflict runs.";

/** Info hint carrying the capacity semantics, instead of an always-on footnote. */
function CapacityHint() {
  return <InfoHint label="How capacity is counted" text={CAPACITY_HINT} />;
}

/** What starts the next run, given how work can reach this worker. */
function idleNext({
  configOk,
  hasTrackers,
  schedule,
  now,
}: {
  configOk: boolean;
  hasTrackers: boolean;
  schedule?: ScheduleSnapshot | null;
  now: number;
}): string | null {
  // Without a config the capacity line and the banner already say what is missing.
  if (!configOk) return null;
  // Outside the working window nothing is picked up, whatever the trackers say.
  if (schedule?.enabled && !schedule.pickupAllowed && !schedule.manualRequested) {
    return schedule.nextChange
      ? `new work starts when the window opens at ${formatClock(schedule.nextChange.at, now)}`
      : "new work starts when the working window opens";
  }
  return hasTrackers
    ? "new work starts on the next tracker poll or queued task"
    : "new work starts when a task is queued";
}

function ActiveWorkSection({
  capacity,
  activityRuns,
  configOk,
  hasTrackers,
  workerStopped,
  workerRunning,
  paused,
  schedule,
  now,
}: {
  capacity: OverviewCapacity;
  /** `/api/task-activity` runs that enrich the rows; null until it loads. */
  activityRuns: RunRecord[] | null;
  configOk: boolean;
  hasTrackers: boolean;
  schedule?: ScheduleSnapshot | null;
  workerStopped: boolean;
  workerRunning: boolean;
  /** Agent work is paused: the pause countdown owns the hero size. */
  paused: boolean;
  now: number;
}) {
  const work = buildActiveWork(capacity.runs, activityRuns ?? [], now);
  const { running, maxConcurrency: max } = capacity;
  const limit = configOk ? "no limit set" : "limit unknown until workspace.toml loads";
  const slots =
    max !== null
      ? `${running} of ${max} ${max === 1 ? "slot" : "slots"} in use`
      : `${running} running · ${limit}`;
  // The capacity count is the page's hero only while work is genuinely moving.
  const quiet = paused || workerStopped;
  // Paused runs are parked like a stopped worker's: neutral, no pulse, not "live".
  const stalled = quiet;
  const reason = workerStopped ? "the worker is stopped" : "agent work is paused";

  return (
    <Section
      id="ov-running"
      title="Active work"
      meta={
        running > 0 || work.waiting.length > 0 ? (
          <a href="#/runs" className="font-medium text-primary hover:underline">
            All runs
          </a>
        ) : undefined
      }
    >
      <div className={PANEL}>
        {running === 0 ? (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3.5 text-[0.8125rem]">
            <span className="font-semibold text-foreground">
              {paused ? "Paused" : workerRunning ? "Idle" : "Nothing running"}
            </span>
            <span className="text-muted-foreground tabular-nums">· {slots}</span>
            <CapacityHint />
            <span className="text-subtle-foreground sm:ml-auto">
              {workerStopped
                ? "work resumes when the worker starts"
                : paused
                  ? "work resumes when a usage window ends"
                  : idleNext({ configOk, hasTrackers, schedule, now })}
            </span>
          </div>
        ) : (
          <div className="grid gap-3 px-4 pt-3.5 pb-4">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {quiet ? (
                <span className="text-[0.9375rem] font-semibold text-foreground tabular-nums">
                  {max !== null ? `${running} of ${max}` : running}{" "}
                  <span className="font-normal text-muted-foreground">
                    {workerStopped
                      ? "stalled · not advancing while the worker is stopped"
                      : paused
                        ? "waiting · paused until a usage window ends"
                        : "in progress"}
                    {max === null ? ` · ${limit}` : ""}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground tabular-nums">
                  <strong className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
                    {running}
                  </strong>
                  {max !== null ? <span className="text-lg"> of {max}</span> : null}
                  <span className="ml-2.5 text-[0.8125rem] text-subtle-foreground">
                    {max !== null ? "in progress" : `in progress · ${limit}`}
                  </span>
                </span>
              )}
              <CapacityHint />
              <span className="ml-auto">
                {stalled ? null : <CapacityBadge running={running} max={max} />}
              </span>
            </div>
            {max !== null ? (
              <Meter running={running} max={max} label="Worker capacity" stalled={stalled} />
            ) : null}
          </div>
        )}
        {work.active.length > 0 ? (
          <ActiveRows
            entries={work.active}
            now={now}
            stalled={stalled ? reason : undefined}
            onOpen={openRun}
          />
        ) : null}
        <WaitingRows entries={work.waiting} now={now} onOpen={openRun} />
        <RecentlyFinished
          entries={work.finished}
          hidden={work.finishedHidden}
          now={now}
          onOpen={openRun}
        />
      </div>
    </Section>
  );
}

function RepoSection({
  capacity,
  stalled,
  configOk,
}: {
  capacity: OverviewCapacity;
  stalled: boolean;
  configOk: boolean;
}) {
  if (capacity.perRepo.length === 0 && capacity.unattributed === 0) return null;
  const perRepoMax = capacity.perRepo[0]?.maxConcurrency ?? null;
  const busy = capacity.perRepo.filter((repo) => repo.running > 0);
  const idle = capacity.perRepo.filter((repo) => repo.running === 0);
  return (
    <Section
      id="ov-repos"
      title="By repository"
      meta={perRepoMax !== null ? `up to ${perRepoMax} runs per repo` : undefined}
    >
      <ul className={cn(PANEL, "divide-y divide-border")}>
        {busy.map((repo) => (
          <li
            key={repo.repo}
            className="grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(5rem,11rem)_3rem] items-center gap-4 px-4 py-2 text-[0.8125rem]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-foreground" title={repo.repo}>
                {repo.repo}
              </span>
              {!repo.configured && configOk ? (
                <span title="Runs recorded this repo, but it is not declared in workspace.toml">
                  <Badge variant="outline">not in workspace</Badge>
                </span>
              ) : null}
              {stalled ? null : <CapacityBadge running={repo.running} max={repo.maxConcurrency} />}
            </span>
            {repo.maxConcurrency !== null ? (
              <Meter
                running={repo.running}
                max={repo.maxConcurrency}
                label={`${repo.repo} capacity`}
                size="sm"
                stalled={stalled}
              />
            ) : (
              <span />
            )}
            <span className="text-right font-semibold text-foreground tabular-nums">
              {repo.running}
              {repo.maxConcurrency !== null ? (
                <span className="font-normal text-subtle-foreground"> / {repo.maxConcurrency}</span>
              ) : null}
            </span>
          </li>
        ))}
        {capacity.unattributed > 0 ? (
          <li className="flex min-h-11 items-center justify-between gap-4 px-4 py-2 text-[0.8125rem]">
            <span className="text-muted-foreground">No repository recorded</span>
            <span className="font-semibold text-foreground tabular-nums">
              {capacity.unattributed}
            </span>
          </li>
        ) : null}
        {idle.length > 0 ? (
          <li className="flex min-h-11 items-center gap-3 px-4 py-2 text-[0.8125rem]">
            <span className="shrink-0 text-muted-foreground">
              {busy.length > 0 ? `${idle.length} more` : idle.length}{" "}
              {idle.length === 1 ? "repo" : "repos"} idle
            </span>
            <span
              className="min-w-0 truncate text-subtle-foreground"
              title={idle.map((repo) => repo.repo).join(", ")}
            >
              {idle.map((repo) => repo.repo).join(", ")}
            </span>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/* ---------- Harness chain ---------- */

const HARNESS_SOURCE_LABELS: Record<OverviewHarnesses["source"], string> = {
  workspace_env: "Chain from AGENT_HARNESS in the workspace .env",
  process_env: "Chain from AGENT_HARNESS in the dashboard's environment",
  default: "Default chain (AGENT_HARNESS is not set)",
};

function HarnessRow({
  entry,
  last,
  resumesFirst,
  workerRunning,
  busy,
  now,
}: {
  entry: OverviewHarnessEntry;
  last: boolean;
  resumesFirst: boolean;
  workerRunning: boolean;
  busy: boolean;
  now: number;
}) {
  // While every entry is limited the backend still marks the primary active;
  // nothing is actually in use, so the tag moves to the harness that resumes.
  // A stopped worker uses nothing.
  const inUse = workerRunning && entry.active && entry.state !== "limited";
  return (
    <li
      className="ov-harness grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5"
      data-state={entry.state}
      data-active={inUse ? "" : undefined}
      data-last={last ? "" : undefined}
    >
      <span className="ov-harness-node" aria-hidden="true">
        {entry.priority + 1}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <span className="truncate">{entry.name}</span>
          {inUse ? (
            busy ? (
              <span className="text-xs font-medium text-primary">in use</span>
            ) : (
              <span className="text-xs text-subtle-foreground">next up</span>
            )
          ) : null}
          {resumesFirst ? (
            <span className="text-xs font-medium text-warning">resumes first</span>
          ) : null}
        </span>
        <span className="text-xs text-subtle-foreground">
          {!entry.known ? (
            <span className="text-danger">not a registered harness</span>
          ) : entry.priority === 0 ? (
            "primary"
          ) : (
            `fallback ${entry.priority}`
          )}
        </span>
      </span>
      <span className="flex flex-col items-end text-[0.8125rem] whitespace-nowrap">
        {entry.state === "healthy" ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="status-dot text-success" aria-hidden="true" />
            healthy
          </span>
        ) : entry.state === "limited" ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-medium text-warning">
              <span className="status-dot" aria-hidden="true" />
              {entry.limitedUntil !== undefined
                ? `limited until ${formatClock(entry.limitedUntil, now)}`
                : "limited"}
            </span>
            {entry.limitedUntil !== undefined ? (
              <span className="text-xs text-subtle-foreground tabular-nums">
                {formatIn(entry.limitedUntil, now)}
              </span>
            ) : null}
          </>
        ) : entry.state === "unconfirmed" ? (
          <>
            <span
              className="inline-flex items-center gap-1.5 font-medium text-warning"
              title="The worker only learns the quota is back when an agent run succeeds; it has not run on this harness since the limit."
            >
              <span className="status-dot" aria-hidden="true" />
              quota unconfirmed
            </span>
            <span className="text-xs text-subtle-foreground tabular-nums">
              {entry.limitEndedAt !== undefined
                ? `limit window ended ${formatClock(entry.limitEndedAt, now)} · no run since`
                : "no run since its last limit"}
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-neutral">
            <span className="status-dot" aria-hidden="true" />
            unknown
          </span>
        )}
      </span>
    </li>
  );
}

function HarnessSection({
  harnesses,
  configMissing,
  queueDbMissing,
  workerRunning,
  busy,
  now,
}: {
  harnesses: OverviewHarnesses;
  workerRunning: boolean;
  /** The worker is running and at least one run is in flight. */
  busy: boolean;
  configMissing: boolean;
  queueDbMissing: boolean;
  now: number;
}) {
  useEffect(() => consumeHarnessFocus(), []);
  const summary = harnessSummary(harnesses);
  const resumesWith = harnesses.allExhausted ? resumingHarness(harnesses) : undefined;
  const drift =
    harnesses.persistedActive &&
    harnesses.active &&
    !harnesses.allExhausted &&
    harnesses.persistedActive !== harnesses.active;
  return (
    <div id={HARNESS_SECTION_ID} tabIndex={-1} className="ov-focus-target rounded-lg">
      <Section
        id="ov-harness"
        title="Agent harnesses"
        meta={
          <span
            className={summary.tone === "warning" ? "font-medium text-warning" : undefined}
            title={HARNESS_SOURCE_LABELS[harnesses.source]}
          >
            {summary.label}
          </span>
        }
      >
        <div className={PANEL}>
          {!harnesses.stateAvailable ? (
            <p className="border-b border-border bg-neutral-subtle px-4 py-2.5 text-xs text-muted-foreground">
              {queueDbMissing
                ? `Usage limits are unknown: the worker records them in its queue database, which does not exist yet${
                    configMissing ? ". Create workspace.toml and start the worker once." : "."
                  }`
                : "Usage limits could not be read from the queue database, so health is unknown."}
            </p>
          ) : null}
          {harnesses.entries.length > 0 ? (
            <ol className="py-1.5" aria-label="Failover order">
              {harnesses.entries.map((entry, index) => (
                <HarnessRow
                  key={entry.name}
                  entry={entry}
                  now={now}
                  resumesFirst={entry.name === resumesWith}
                  workerRunning={workerRunning}
                  busy={busy}
                  last={index === harnesses.entries.length - 1}
                />
              ))}
            </ol>
          ) : (
            <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">
              No harness chain resolved.
            </p>
          )}
        </div>
        {drift ? (
          <p className="mt-2 text-xs text-subtle-foreground">
            The worker last reported{" "}
            <strong className="font-semibold text-muted-foreground">
              {harnesses.persistedActive}
            </strong>{" "}
            as active; it switches on its next run.
          </p>
        ) : harnesses.entries.length > 1 && !harnesses.allExhausted ? (
          <p className="mt-2 text-xs text-subtle-foreground">
            Work falls back down the chain when a harness hits its usage limit.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

/* ---------- Tracker sources ---------- */

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

function TrackerSection({
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

/** The overview for one snapshot; separated from polling for tests. */
export function OverviewScreen({
  overview,
  workerInfo,
  activityRuns = null,
  now,
}: {
  overview: OverviewResponse;
  workerInfo: WorkerResponse | null;
  /** `/api/task-activity` runs: row detail plus the waiting and finished lists. */
  activityRuns?: RunRecord[] | null;
  now: number;
}) {
  const alerts = overviewAlerts(overview, now);
  const workerRunning = overview.worker.status === "running";
  const configOk = overview.config.status === "ok";
  const queued = workerInfo ? queueTotal(workerInfo.queue) : undefined;
  return (
    <div className="grid min-w-0 gap-7">
      {/* Polite, additions only: a banner is announced when it appears, not on every poll. */}
      <div aria-live="polite" aria-relevant="additions" className="grid gap-2.5 empty:hidden">
        {alerts.map((alert) => (
          <OverviewAlertBanner
            key={alert.kind}
            alert={alert}
            now={now}
            queued={queued}
            pollIntervalSeconds={overview.trackers.pollIntervalSeconds}
          />
        ))}
      </div>

      <WorkerFacts overview={overview} workerInfo={workerInfo} now={now} />

      <div className="grid min-w-0 gap-7 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] min-[1180px]:gap-x-8">
        <div className="grid min-w-0 content-start gap-7">
          <ActiveWorkSection
            capacity={overview.capacity}
            activityRuns={activityRuns}
            configOk={configOk}
            hasTrackers={overview.trackers.sources.length > 0}
            workerStopped={overview.worker.status === "stopped"}
            workerRunning={workerRunning}
            paused={overview.harnesses.allExhausted}
            schedule={workerInfo?.schedule}
            now={now}
          />
          <RepoSection
            capacity={overview.capacity}
            stalled={overview.worker.status === "stopped" || overview.harnesses.allExhausted}
            configOk={configOk}
          />
        </div>
        <div className="grid min-w-0 content-start gap-7 min-[900px]:max-[1179px]:grid-cols-2 min-[900px]:max-[1179px]:gap-x-6">
          <HarnessSection
            harnesses={overview.harnesses}
            configMissing={overview.config.status === "missing"}
            queueDbMissing={workerInfo?.queueDbMissing ?? false}
            workerRunning={workerRunning}
            busy={workerRunning && overview.capacity.running > 0}
            now={now}
          />
          <TrackerSection
            trackers={overview.trackers}
            configOk={configOk}
            workerRunning={workerRunning}
            now={now}
          />
        </div>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-7" aria-busy="true" aria-label="Loading overview">
      <div className="grid divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {["uptime", "window", "queue"].map((key) => (
          <div key={key} className="px-5 py-3.5">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton mt-2 h-5 w-24" />
            <div className="skeleton mt-2 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid gap-7 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] min-[1180px]:gap-x-8">
        <div>
          <div className="skeleton h-4 w-28" />
          <div className="skeleton mt-3 h-40 w-full" />
        </div>
        <div>
          <div className="skeleton h-4 w-32" />
          <div className="skeleton mt-3 h-28 w-full" />
        </div>
      </div>
    </div>
  );
}

/** Landing page: is the worker healthy, and what is it doing right now? */
export function OverviewView() {
  // Shared with the status strip's harness pill: one request, one truth.
  const { data, error } = useOverviewPoll();
  const { data: workerInfo } = usePoll<WorkerResponse>("/api/worker");
  // Row detail, waiting and finished tasks; the in-progress set stays the overview's.
  const { data: activity } = usePoll<TaskActivityResponse>("/api/task-activity");
  // Elapsed times and countdowns tick between polls.
  const now = useNow(5_000);
  if (!data) {
    return error ? (
      <EmptyState title="Could not load the overview" body={error} />
    ) : (
      <OverviewSkeleton />
    );
  }
  return (
    <OverviewScreen
      overview={data}
      workerInfo={workerInfo}
      activityRuns={activity?.runs ?? null}
      now={Math.max(now, data.generatedAt)}
    />
  );
}
