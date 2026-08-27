import { Activity, CircleCheck, CircleOff, Clock, GitPullRequest, Inbox } from "lucide-react";

import { usePoll } from "@/lib/api";
import type { ScheduleSnapshot, WorkerResponse } from "@/lib/api";
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

function Item({
  icon,
  label,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      {icon}
      {label}
    </span>
  );
}

/** Header strip: worker liveness, queue counts, and open agent PRs. */
export function StatusStrip() {
  const { data } = usePoll<WorkerResponse>("/api/worker");
  if (!data) {
    return null;
  }

  const running = data.worker?.running ?? false;
  const queueLabel =
    data.queue.failed > 0
      ? `${data.queue.pending} queued, ${data.queue.failed} failed`
      : `${data.queue.pending + data.queue.processing} queued`;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground">
      <Item
        icon={
          running ? (
            <CircleCheck className="size-4 text-chart-4" />
          ) : (
            <CircleOff className="size-4" />
          )
        }
        label={running ? `worker running (pid ${data.worker?.pid})` : "worker stopped"}
        className={running ? "text-foreground" : undefined}
      />
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
      <Item icon={<Inbox className="size-4" />} label={queueLabel} />
      <Item
        icon={<GitPullRequest className="size-4" />}
        label={`${data.agentPrs.open} agent PR${data.agentPrs.open === 1 ? "" : "s"} open`}
      />
      {data.dbMissing ? (
        <Item
          icon={<Activity className="size-4" />}
          label="no database yet: run the worker once to start recording"
        />
      ) : null}
    </div>
  );
}
