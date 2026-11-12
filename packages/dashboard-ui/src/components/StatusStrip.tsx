import { Activity, CircleHelp, Clock, GitPullRequest, Inbox, TriangleAlert } from "lucide-react";

import { usePoll } from "@/lib/api";
import type { ScheduleSnapshot, WorkerResponse, WorkerStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scheduleLabel(schedule: ScheduleSnapshot): string {
  const windows = schedule.active.length > 0 ? schedule.active.join(", ") : "unrestricted";
  if (schedule.manualRequested) {
    return `manual run requested (${windows})`;
  }
  if (schedule.pickupAllowed) {
    return schedule.nextChange
      ? `working window ${windows} — closes ${formatClockTime(schedule.nextChange.at)}`
      : `working window ${windows}`;
  }
  return schedule.nextChange
    ? `outside working window ${windows} — opens ${formatClockTime(schedule.nextChange.at)}`
    : `outside working window (${windows})`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Total waiting work across relay deliveries, ad-hoc tasks, and scheduled retries. */
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
  const relay = queue.pending + queue.processing;
  const adHoc = queue.injected.pending + queue.injected.running;
  const retries = queue.retries.pending + queue.retries.running;
  const parts = [
    pluralize(relay, "relay delivery", "relay deliveries"),
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
  label: string;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn("strip-item", className)}>
      {icon}
      {label}
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
        {detail ? <span className="font-normal text-subtle-foreground">{detail}</span> : null}
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
      <WorkerChip state="running" label="worker running" detail={` (pid ${worker.pid ?? "?"})`} />
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

/** Polling indicator: pulses while the dashboard is refreshing every 5 seconds. */
function LiveIndicator({ error }: { error: string | null }) {
  if (error) {
    return (
      <span className="live-indicator" data-state="error" title={error} role="status">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        Connection interrupted; showing last known status
      </span>
    );
  }
  return (
    <span className="live-indicator" title="Status refreshes every 5 seconds">
      <span className="status-dot status-dot-live text-secondary" aria-hidden="true" />
      Live · 5s
    </span>
  );
}

/** Header strip: worker liveness, queue counts, open agent PRs, and polling state. */
export function StatusStrip() {
  const { data, error } = usePoll<WorkerResponse>("/api/worker");
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
    <div className="dashboard-status-strip">
      <WorkerStatusIndicator worker={data.worker} />
      {data.schedule?.enabled ? (
        <Item
          icon={
            <Clock
              className={cn("size-4", !data.schedule.pickupAllowed && "text-muted-foreground/50")}
            />
          }
          label={scheduleLabel(data.schedule)}
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
          label={`${data.agentPrs.open} agent PR${data.agentPrs.open === 1 ? "" : "s"} open`}
        />
      </a>
      {showMissingDatabaseBanner(data) ? (
        <Item
          icon={<Activity className="size-4" />}
          label="no database yet: run the worker once to start recording"
        />
      ) : null}
      <LiveIndicator error={error} />
    </div>
  );
}
