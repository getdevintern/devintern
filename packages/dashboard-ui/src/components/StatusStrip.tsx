import {
  Activity,
  CircleCheck,
  CircleHelp,
  CircleOff,
  Clock,
  GitPullRequest,
  Inbox,
} from "lucide-react";

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
    <span title={title} className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      {icon}
      {label}
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
      <Item
        icon={<CircleCheck className="size-4 text-chart-4" />}
        label={`worker running (pid ${worker.pid ?? "?"})`}
        className="text-foreground"
      />
    );
  }
  if (worker.status === "stopped") {
    return <Item icon={<CircleOff className="size-4" />} label="worker stopped" />;
  }
  return (
    <Item
      icon={<CircleHelp className="size-4" />}
      label="worker status unknown"
      title="No worker lock file was found in this project or the workspace home, so liveness cannot be determined. The worker may be running from a different directory, or it has never run here."
    />
  );
}

/** Header strip: worker liveness, queue counts, and open agent PRs. */
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
      />
      <a href="#/prs" className="hover:text-foreground">
        <Item
          icon={<GitPullRequest className="size-4" />}
          label={`${data.agentPrs.open} agent PR${data.agentPrs.open === 1 ? "" : "s"} open`}
        />
      </a>
      {data.dbMissing ? (
        <Item
          icon={<Activity className="size-4" />}
          label="no database yet: run the worker once to start recording"
        />
      ) : null}
      {error ? (
        <Item
          icon={<CircleHelp className="size-4 text-chart-5" />}
          label="Connection interrupted; showing last known status"
          title={error}
        />
      ) : null}
    </div>
  );
}
