import type { AutomationSchedule, ScheduledJobKind, ScheduledJobRunFilter } from "@/lib/api";

/** Dashboard id prefix of scheduled estimation sweeps (mirrors the worker). */
export const ESTIMATION_JOB_PREFIX = "estimation:";
/** Dashboard id of the scheduled conflict-resolution window (mirrors the worker). */
export const CONFLICT_RESOLUTION_JOB_ID = "workspace:conflict-resolution";

/** Job kind, treating entries from older servers as prompt automations. */
export function jobKind(job: Pick<AutomationSchedule, "kind">): ScheduledJobKind {
  return job.kind ?? "automation";
}

/** Name shown for a job: its title when the id is namespaced. */
export function jobTitle(job: Pick<AutomationSchedule, "id" | "title">): string {
  return job.title ?? job.id;
}

/** Short kind label for badges; undefined for plain automations. */
export function jobKindLabel(kind: ScheduledJobKind): string | undefined {
  if (kind === "estimation") return "Estimation";
  if (kind === "conflict_resolution") return "Conflicts";
  return undefined;
}

/**
 * Run filter for a job id before the catalog has loaded (the detail page's
 * run list starts fetching immediately). Matches what the worker serves.
 */
export function runFilterForJobId(id: string): ScheduledJobRunFilter {
  if (id === CONFLICT_RESOLUTION_JOB_ID) return { origin: "conflict_resolution" };
  if (id.startsWith(ESTIMATION_JOB_PREFIX)) {
    return { automationId: id.slice(ESTIMATION_JOB_PREFIX.length), origin: "estimate" };
  }
  return { automationId: id };
}

/** Tooltip explaining what "Run now" does for this kind of job. */
export function runNowHint(kind: ScheduledJobKind): string {
  if (kind === "estimation") {
    return "Runs the estimation sweep now instead of waiting for the schedule; tickets estimated recently or unchanged since their last estimate are still skipped";
  }
  if (kind === "conflict_resolution") {
    return "Opens the conflict-resolution window now, so queued conflicts on the agent's PRs resolve on the next review poll instead of at the next scheduled time";
  }
  return "Runs through the same pipeline as a scheduled run and is recorded with the manual origin";
}

/** Success message after a "Run now" trigger. */
export function runStartedMessage(job: Pick<AutomationSchedule, "id" | "title" | "kind">): string {
  const kind = jobKind(job);
  const title = jobTitle(job);
  if (kind === "estimation") {
    return `Estimation sweep ${title} started. It will appear in the run list with origin "Estimate run" shortly.`;
  }
  if (kind === "conflict_resolution") {
    return 'Conflict-resolution window opened. Queued conflicts on the agent\'s PRs resolve on the next review poll; each appears in the run list with origin "Conflict resolution".';
  }
  return `Manual run of ${title} started. It will appear in the run list with origin "Manual run" shortly.`;
}
