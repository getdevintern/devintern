/**
 * Dashboard catalog of every scheduled worker job
 *
 * The Automations page lists more than `[[automations]]`: scheduled
 * `[[estimations]]` sweeps and the scheduled conflict-resolution window run
 * on timers too, and the operator should be able to see them and trigger
 * one on demand ("Run now") instead of waiting for the next occurrence.
 *
 * Each job keeps its own engine: automations run their prompt pipeline,
 * estimation sweeps run `devintern --estimate --query`, and the conflict
 * entry opens the review poller's resolution window. Non-automation ids are
 * namespaced with a `:` — never valid in an automation or estimation id — so
 * they cannot collide with a prompt automation of the same name.
 */

import type {
  AutomationScheduleStatus,
  DashboardAutomationActions,
  ManualTriggerOutcome,
} from "./acquirer";
import type { CronOrIntervalSchedule } from "./config";
import type {
  ConflictWindowStatus,
  ConflictWindowTriggerOutcome,
} from "../acquirers/review-polling";
import { pickAgentSelection } from "../agent/selection";
import type { AgentSelection } from "../agent/selection";

/** Dashboard id prefix for scheduled estimation sweeps. */
export const ESTIMATION_JOB_PREFIX = "estimation:";
/** Dashboard id of the scheduled conflict-resolution window. */
export const CONFLICT_RESOLUTION_JOB_ID = "workspace:conflict-resolution";

/** Minimal scheduler surface (an `AutomationAcquirer` or `EstimationAcquirer`). */
interface ScheduleSource {
  listSchedules(): AutomationScheduleStatus[];
  triggerManual(id: string): Promise<ManualTriggerOutcome>;
}

/** The review poller's scheduled conflict window, when GitHub reviews are wired. */
export interface ConflictWindowSource {
  conflictWindowStatus(): ConflictWindowStatus | null;
  openConflictWindowNow(): ConflictWindowTriggerOutcome;
}

export interface ScheduledJobSources {
  automations: ScheduleSource;
  estimations?: ScheduleSource;
  /** Resolved per call: reload hooks attach after the dashboard actions are built. */
  conflicts?: () => ConflictWindowSource | undefined;
  /** Live `[workspace].conflict_resolution_*` agent override. */
  conflictAgent?: () => AgentSelection | undefined;
}

function scheduleFields(schedule: CronOrIntervalSchedule): { cron?: string; interval?: string } {
  return schedule.cron ? { cron: schedule.cron } : { interval: schedule.interval };
}

/** Prompt-like description shown on the conflict entry's detail page. */
const CONFLICT_DESCRIPTION =
  "Resolves merge conflicts on the agent's open pull requests. Conflicts are detected " +
  "and queued on every review poll; in scheduled mode the agent only runs inside the " +
  "configured window. **Run now** opens the window immediately, so queued conflicts " +
  "resolve on the next poll instead of at the next scheduled time.";

/**
 * Compose dashboard actions over every scheduled job type.
 *
 * @param sources - The worker's in-process schedulers
 */
export function composeScheduledJobActions(
  sources: ScheduledJobSources,
): DashboardAutomationActions {
  const list = (): AutomationScheduleStatus[] => {
    const jobs: AutomationScheduleStatus[] = sources.automations
      .listSchedules()
      .map((status) => ({ ...status, kind: "automation" as const }));
    for (const status of sources.estimations?.listSchedules() ?? []) {
      jobs.push({
        ...status,
        id: `${ESTIMATION_JOB_PREFIX}${status.id}`,
        title: status.title ?? status.id,
        kind: "estimation",
        runFilter: status.runFilter ?? { automationId: status.id, origin: "estimate" },
      });
    }
    const conflictStatus = sources.conflicts?.()?.conflictWindowStatus() ?? null;
    if (conflictStatus) {
      jobs.push({
        id: CONFLICT_RESOLUTION_JOB_ID,
        title: "Conflict resolution",
        kind: "conflict_resolution",
        enabled: true,
        ...scheduleFields(conflictStatus.schedule),
        prompt: CONFLICT_DESCRIPTION,
        openPr: false,
        ...pickAgentSelection(sources.conflictAgent?.() ?? {}),
        nextDueAt: conflictStatus.nextWindowAt,
        runFilter: { origin: "conflict_resolution" },
      });
    }
    return jobs;
  };

  const trigger = async (id: string): Promise<ManualTriggerOutcome> => {
    if (id === CONFLICT_RESOLUTION_JOB_ID) {
      const conflicts = sources.conflicts?.();
      if (!conflicts) {
        return { ok: false, reason: "conflict resolution is not available on this worker" };
      }
      return conflicts.openConflictWindowNow();
    }
    if (id.startsWith(ESTIMATION_JOB_PREFIX)) {
      if (!sources.estimations) {
        return { ok: false, reason: "estimation sweeps are not available on this worker" };
      }
      return sources.estimations.triggerManual(id.slice(ESTIMATION_JOB_PREFIX.length));
    }
    return sources.automations.triggerManual(id);
  };

  return { list, trigger };
}
