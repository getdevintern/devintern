import { Activity, CircleCheck, CircleOff, GitPullRequest, Inbox } from "lucide-react";

import { usePoll } from "@/lib/api";
import type { WorkerResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

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
