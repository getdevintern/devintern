import { ActiveRows, RecentlyFinished, WaitingRows } from "@/components/overview/ActiveWork";
import { QueuedWork } from "@/components/overview/QueuedWork";
import { formatClock } from "@/components/overview/overview-model";
import { InfoHint } from "@/components/overview/InfoHint";
import type { QueuedWorkResponse, RunRecord, ScheduleSnapshot } from "@/lib/api";
import type { OverviewCapacity } from "@/lib/api-overview";
import { runHash } from "@/lib/routes";
import { buildActiveWork } from "@/lib/task-activity";
import { PANEL, Section, Meter, CapacityBadge } from "@/components/overview/OverviewPanel";

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

export function ActiveWorkSection({
  capacity,
  activityRuns,
  queuedWork,
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
  /** `/api/queue` pending work; null until it loads. */
  queuedWork: QueuedWorkResponse | null;
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
        <QueuedWork items={queuedWork?.items ?? []} total={queuedWork?.total ?? 0} now={now} />
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
