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
  const { data } = usePoll<WorkerResponse>("/api/worker");
  if (!data) {
    return null;
  }

  const queueLabel =
    data.queue.failed > 0
      ? `${data.queue.pending} queued, ${data.queue.failed} failed`
      : `${data.queue.pending + data.queue.processing} queued`;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground">
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
      <Item icon={<Inbox className="size-4" />} label={queueLabel} />
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
    </div>
  );
}
