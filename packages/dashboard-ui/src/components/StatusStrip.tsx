import { Activity, CircleCheck, CircleOff, GitPullRequest, Inbox } from "lucide-react";

import { usePoll } from "@/lib/api";
import type { FleetStatus, WorkerResponse } from "@/lib/api";
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

const REPO_STATUS_STYLES: Record<string, string> = {
  running: "text-chart-4",
  queued: "text-muted-foreground",
  idle: "text-muted-foreground/60",
  stale: "text-destructive",
};

/** One compact chip per repo: "backend ▸ TASK-12", "frontend · queued". */
export function RepoActivityChips({ fleet }: { fleet: FleetStatus }) {
  const active = fleet.repos.filter((repo) => repo.status === "running").length;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
      data-testid="fleet-activity"
    >
      <Item
        icon={<Activity className="size-4" />}
        label={
          fleet.stale
            ? `fleet stale (worker ${fleet.pid} gone)`
            : `${active}/${fleet.maxConcurrency} repos active${fleet.parallel ? "" : " (serial)"}`
        }
        className={cn(
          fleet.stale ? "text-destructive" : active > 0 ? "text-foreground" : undefined,
        )}
      />
      {fleet.repos.map((repo) => (
        <span key={repo.repo} className={cn("text-xs", REPO_STATUS_STYLES[repo.status])}>
          {repo.repo}
          {repo.status === "running" && repo.label ? ` ▸ ${repo.label}` : ""}
          {repo.status === "queued" ? ` (${repo.status})` : ""}
          {repo.status === "stale" ? " (stale)" : ""}
        </span>
      ))}
    </span>
  );
}

/** Header strip: worker liveness, queue counts, open agent PRs, fleet activity. */
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
      {data.fleet ? <RepoActivityChips fleet={data.fleet} /> : null}
      {data.dbMissing ? (
        <Item
          icon={<Activity className="size-4" />}
          label="no database yet: run the worker once to start recording"
        />
      ) : null}
    </div>
  );
}
