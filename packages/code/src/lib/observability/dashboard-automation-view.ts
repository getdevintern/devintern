/**
 * Dashboard view of one scheduled job (`GET /api/automations`): a prompt
 * automation, an estimation sweep, or the scheduled conflict window.
 */

import type {
  AutomationActivity,
  AutomationScheduleStatus,
  ScheduledJobKind,
  ScheduledJobRunFilter,
} from "../automation/acquirer";
import { pickAgentSelection } from "../agent/selection";
import type { AgentSelection } from "../agent/selection";
import type { RunRecord } from "../state/run-recorder";

/** One configured scheduled automation (plus agent override) as served by `GET /api/automations`. */
export interface DashboardAutomationView extends AgentSelection {
  id: string;
  /** Job type: prompt automation, estimation sweep, or scheduled conflict window. */
  kind: ScheduledJobKind;
  /** Display name when it differs from `id`. */
  title?: string;
  enabled: boolean;
  /** Cron expression or interval as configured (`0 9 * * 1`, `6h`). */
  schedule?: string;
  repo?: string;
  /** The prompt executed per occurrence (a description for non-prompt jobs). */
  prompt: string;
  /** Whether occurrences open a pull request (opt-in; default off). */
  openPr: boolean;
  /** Next scheduled occurrence (epoch ms), when the scheduler registered it. */
  nextDueAt?: number;
  /** Estimation sweeps: tracker query selecting the tickets to estimate. */
  query?: string;
  /** Estimation sweeps: `[[teams]]` name whose tracker the sweep uses. */
  team?: string;
  /** Recorded runs attributed to this job (the detail page's run list query). */
  runFilter: ScheduledJobRunFilter;
  /** Most recent run of this automation (any origin), description stripped. */
  lastRun?: RunRecord;
  /** Occurrence in flight on this worker, including one still waiting for a slot. */
  activity?: AutomationActivity;
  /** Latest usage-limit deferral not yet followed by a started run. */
  deferral?: { until: number; harness?: string };
}

/** Runs attributed to a scheduled job; prompt automations match by id. */
export function scheduledJobRunFilter(status: AutomationScheduleStatus): ScheduledJobRunFilter {
  return status.runFilter ?? { automationId: status.id };
}

/**
 * Build the dashboard view of one schedule.
 *
 * @param status - Schedule as listed by the dashboard actions
 * @param lastRun - Most recent run matching {@linkcode scheduledJobRunFilter}
 */
export function toAutomationView(
  status: AutomationScheduleStatus,
  lastRun: RunRecord | undefined,
): DashboardAutomationView {
  return {
    id: status.id,
    kind: status.kind ?? "automation",
    title: status.title,
    enabled: status.enabled,
    schedule: status.cron ?? status.interval,
    repo: status.repo,
    prompt: status.prompt,
    openPr: status.openPr === true,
    ...pickAgentSelection(status),
    nextDueAt: status.nextDueAt,
    query: status.query,
    team: status.team,
    runFilter: scheduledJobRunFilter(status),
    lastRun: lastRun ? { ...lastRun, taskDescription: undefined } : undefined,
    ...(status.activity ? { activity: status.activity } : {}),
    ...(status.deferral ? { deferral: status.deferral } : {}),
  };
}
