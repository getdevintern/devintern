import { useLayoutEffect, useRef } from "react";
import {
  Activity,
  CircleHelp,
  CirclePause,
  Clock,
  GitPullRequest,
  Inbox,
  TriangleAlert,
} from "lucide-react";

import { requestHarnessFocus } from "@/components/overview/focus";
import {
  formatClock,
  formatIn,
  harnessAlert,
  windowSpec,
} from "@/components/overview/overview-model";
import type { HarnessAlert } from "@/components/overview/overview-model";
import { useNow } from "@/components/overview/use-now";
import { useOverviewPoll } from "@/components/overview/overview-store";
import { usePoll } from "@/lib/api";
import type { ScheduleSnapshot, WorkerResponse, WorkerStatus } from "@/lib/api";
import { parseHash } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * Short working-window state for the one-row strip ("window closes 7:00 PM");
 * the window spec and its zone go in the tooltip.
 */
export function scheduleLabel(schedule: ScheduleSnapshot, now: number = Date.now()): string {
  if (schedule.manualRequested) return "manual run requested";
  const next = schedule.nextChange ? formatClock(schedule.nextChange.at, now) : undefined;
  if (schedule.pickupAllowed) return next ? `window closes ${next}` : "in working window";
  return next ? `paused · window opens ${next}` : "outside working window";
}

export function scheduleTitle(schedule: ScheduleSnapshot): string {
  return `Working window ${windowSpec(schedule)}${
    schedule.pickupAllowed ? "" : ": new work is picked up only inside the window"
  }`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Total waiting work across webhook deliveries, ad-hoc tasks, and scheduled retries. */
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

/**
 * The visible queue label: every waiting work item, with failures appended when
 * any exist so a broken delivery does not hide behind a healthy queue count.
 */
export function queueLabel(queue: WorkerResponse["queue"]): string {
  const total = queueTotal(queue);
  return queue.failed > 0 ? `${total} queued, ${queue.failed} failed` : `${total} queued`;
}

/** Tooltip breakdown explaining where the queued work sits. */
export function queueTitle(queue: WorkerResponse["queue"]): string {
  // Tracker and code-host webhook events, delivered directly or via the relay.
  const webhook = queue.pending + queue.processing;
  const adHoc = queue.injected.pending + queue.injected.running;
  const retries = queue.retries.pending + queue.retries.running;
  const parts = [
    pluralize(webhook, "webhook delivery", "webhook deliveries"),
    pluralize(adHoc, "ad-hoc task", "ad-hoc tasks"),
    pluralize(retries, "scheduled retry", "scheduled retries"),
  ];
  if (queue.failed > 0) {
    parts.push(pluralize(queue.failed, "failed delivery", "failed deliveries"));
  }
  return parts.join(", ");
}

/**
 * Whether to show the "no database yet" banner.
 *
 * Run history and the durable queue can live in different files. Claiming no
 * database while the queue DB is recording work would contradict the non-zero
 * "N queued" label next to it, so only show the banner when BOTH are absent.
 */
export function showMissingDatabaseBanner(
  data: Pick<WorkerResponse, "dbMissing" | "queueDbMissing">,
): boolean {
  return data.dbMissing && data.queueDbMissing;
}

function Item({
  icon,
  label,
  className,
  title,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn("strip-item", className)}>
      {icon}
      <span className="strip-label">{label}</span>
    </span>
  );
}

type WorkerChipState = "running" | "stopped" | "unknown";

function WorkerChip({
  state,
  label,
  detail,
  title,
}: {
  state: WorkerChipState;
  label: string;
  detail?: string;
  title?: string;
}) {
  return (
    <span className="worker-chip" data-state={state} title={title}>
      <span
        className={cn("status-dot", state === "running" && "status-dot-live")}
        aria-hidden="true"
      />
      <span>
        {label}
        {detail ? (
          <span className="worker-chip-detail font-normal text-subtle-foreground">{detail}</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Worker liveness indicator. When liveness cannot be determined (no readable
 * worker lock in any known location — the worker may run from a different
 * directory), it says so explicitly instead of claiming "stopped".
 */
export function WorkerStatusIndicator({ worker }: { worker: WorkerStatus }) {
  if (worker.status === "running") {
    return (
      <WorkerChip
        state="running"
        label="worker running"
        detail={` (pid ${worker.pid ?? "?"})`}
        title={`Worker running as pid ${worker.pid ?? "?"}`}
      />
    );
  }
  if (worker.status === "stopped") {
    return <WorkerChip state="stopped" label="worker stopped" />;
  }
  return (
    <WorkerChip
      state="unknown"
      label="worker status unknown"
      title="No worker lock file was found in this project or the workspace home, so liveness cannot be determined. The worker may be running from a different directory, or it has never run here."
    />
  );
}

/**
 * Warning pill for a degraded harness chain, linking to the overview. All
 * exhausted pauses agent work, so it reads louder than a single limited entry.
 */
export function HarnessAlertPill({ alert, now }: { alert: HarnessAlert; now: number }) {
  const exhausted = alert.kind === "exhausted";
  const label = exhausted
    ? alert.resumesAt !== undefined
      ? `agents paused until ${formatClock(alert.resumesAt, now)}`
      : "agents paused"
    : alert.kind === "unconfirmed"
      ? alert.names.length === 1
        ? `${alert.names[0]} quota unconfirmed`
        : `${alert.names.length} quotas unconfirmed`
      : alert.names.length === 1
        ? `${alert.names[0]} limited`
        : `${alert.names.length} harnesses limited`;
  const title = exhausted
    ? `Every agent harness hit its usage limit${
        alert.resumesAt !== undefined ? `; work resumes ${formatIn(alert.resumesAt, now)}` : ""
      }. Open the overview for details.`
    : alert.kind === "unconfirmed"
      ? `The usage-limit window for ${alert.names.join(", ")} ended, but nothing has run since, so the quota may still be exhausted. Open the overview for details.`
      : `Usage limit reached for ${alert.names.join(", ")}; the worker falls back down the chain. Open the overview for details.`;
  return (
    <a
      href="#/"
      className="harness-pill"
      data-state={alert.kind}
      title={title}
      onClick={(event) => {
        // Already on the overview: the hash would not change, so scroll to
        // the chain directly. Elsewhere the section focuses once it mounts.
        if (parseHash(window.location.hash).view === "overview") event.preventDefault();
        requestHarnessFocus();
      }}
    >
      {exhausted ? (
        <CirclePause className="size-3.5" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-3.5" aria-hidden="true" />
      )}
      <span className="strip-label">{label}</span>
    </a>
  );
}

/** Harness chain pill, fed by the shared overview poller. */
function HarnessStatus() {
  // Same snapshot as the Overview page, so the pill and its banner always agree.
  const { data } = useOverviewPoll();
  // Tick faster than the poll so the "until" time and countdown stay right.
  const now = useNow(15_000);
  const alert = data ? harnessAlert(data.harnesses) : null;
  return alert ? <HarnessAlertPill alert={alert} now={now} /> : null;
}

/** Polling indicator: pulses while the dashboard is refreshing every 5 seconds. */
function LiveIndicator({ error }: { error: string | null }) {
  if (error) {
    return (
      <span className="live-indicator" data-state="error" title={error} role="status">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        <span className="strip-wide">Connection interrupted; showing last known status</span>
      </span>
    );
  }
  return (
    <span className="live-indicator" title="Status refreshes every 5 seconds">
      <span className="status-dot status-dot-live text-secondary" aria-hidden="true" />
      <span className="strip-wide">Live · 5s</span>
    </span>
  );
}

/**
 * Keep the strip on one row: raise `data-compact` (see styles.css) until the
 * content fits, re-checking on resize and whenever any item's text changes.
 */
function useStripFit(ref: React.RefObject<HTMLDivElement | null>, ready: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Compare item edges rather than scrollWidth: the visually hidden labels
    // are absolutely positioned and would count as phantom overflow.
    const fits = () => {
      const right = element.getBoundingClientRect().right + 0.5;
      return Array.from(element.children).every(
        (child) => child.getBoundingClientRect().right <= right,
      );
    };
    const fit = () => {
      for (let level = 0; level <= 4; level += 1) {
        element.dataset.compact = String(level);
        if (fits()) return;
      }
    };
    fit();
    // Web fonts change text widths after the first measurement.
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) fit();
    });
    const resize = new ResizeObserver(fit);
    resize.observe(element);
    const mutations = new MutationObserver(fit);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      disposed = true;
      resize.disconnect();
      mutations.disconnect();
    };
  }, [ref, ready]);
}

/** Header strip: worker liveness, queue counts, open agent PRs, and polling state. */
export function StatusStrip() {
  const { data, error } = usePoll<WorkerResponse>("/api/worker");
  const stripRef = useRef<HTMLDivElement>(null);
  useStripFit(stripRef, data !== null);
  if (!data) {
    return (
      <div className="dashboard-status-strip">
        <Item
          icon={<CircleHelp className="size-4" />}
          label={error ? "Worker status unavailable" : "Checking worker status…"}
          title={error ?? undefined}
        />
      </div>
    );
  }

  const queueLabelText = queueLabel(data.queue);

  return (
    <div className="dashboard-status-strip" ref={stripRef}>
      <WorkerStatusIndicator worker={data.worker} />
      <HarnessStatus />
      {data.schedule?.enabled ? (
        <Item
          icon={
            <Clock
              className={cn("size-4", !data.schedule.pickupAllowed && "text-muted-foreground/50")}
            />
          }
          label={scheduleLabel(data.schedule)}
          title={scheduleTitle(data.schedule)}
          className="strip-item-shrink"
        />
      ) : null}
      <Item
        icon={<Inbox className="size-4" />}
        label={queueLabelText}
        title={queueTitle(data.queue)}
        className={data.queue.failed > 0 ? "text-danger" : undefined}
      />
      <a href="#/prs" className="strip-link">
        <Item
          icon={<GitPullRequest className="size-4" />}
          label={
            <>
              {data.agentPrs.open}
              <span className="strip-wide">
                {` agent PR${data.agentPrs.open === 1 ? "" : "s"} open`}
              </span>
            </>
          }
          title={`${data.agentPrs.open} agent PR${data.agentPrs.open === 1 ? "" : "s"} open`}
        />
      </a>
      {showMissingDatabaseBanner(data) ? (
        <Item
          icon={<Activity className="size-4" />}
          label="no database yet: run the worker once to start recording"
          title="No database yet: run the worker once to start recording"
          className="strip-item-shrink"
        />
      ) : null}
      <LiveIndicator error={error} />
    </div>
  );
}
