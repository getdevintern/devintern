import { EmptyState } from "@/components/shared";
import { overviewAlerts } from "@/components/overview/overview-model";
import { useOverviewPoll } from "@/components/overview/overview-store";
import { useNow } from "@/components/overview/use-now";
import { QUEUE_CHANGED_EVENT, usePoll } from "@/lib/api";
import type {
  QueuedWorkResponse,
  RunRecord,
  TaskActivityResponse,
  WorkerResponse,
} from "@/lib/api";
import type { OverviewResponse } from "@/lib/api-overview";
import { queueTotal, WorkerFacts } from "@/components/overview/WorkerFacts";
import { OverviewAlertBanner } from "@/components/overview/OverviewAlertBanner";
import { ActiveWorkSection } from "@/components/overview/ActiveWorkSection";
import { RepoSection } from "@/components/overview/RepoSection";
import { HarnessSection } from "@/components/overview/HarnessSection";
import { TrackerSection } from "@/components/overview/TrackerSection";
// oxlint-disable-next-line import/no-unassigned-import -- meter and chain styles
import "./overview.css";

/** The overview for one snapshot; separated from polling for tests. */
export function OverviewScreen({
  overview,
  workerInfo,
  activityRuns = null,
  queuedWork = null,
  now,
}: {
  overview: OverviewResponse;
  workerInfo: WorkerResponse | null;
  /** `/api/queue`: pending work listed under Active work. */
  queuedWork?: QueuedWorkResponse | null;
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
            queuedWork={queuedWork}
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
  const { data: workerInfo } = usePoll<WorkerResponse>("/api/worker", 5000, {
    refreshOn: QUEUE_CHANGED_EVENT,
  });
  // Row detail, waiting and finished tasks; the in-progress set stays the overview's.
  const { data: activity } = usePoll<TaskActivityResponse>("/api/task-activity");
  // Pending work the worker has accepted but not started. Both polls re-fetch
  // at once when a cancel changes the queue.
  const { data: queuedWork } = usePoll<QueuedWorkResponse>("/api/queue", 5000, {
    refreshOn: QUEUE_CHANGED_EVENT,
  });
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
      queuedWork={queuedWork}
      now={Math.max(now, data.generatedAt)}
    />
  );
}
