/**
 * Dashboard catalog of every scheduled worker job
 *
 * The Automations page lists more than `[[automations]]`: scheduled
 * `[[estimations]]` sweeps, the scheduled conflict-resolution window, and the
 * auto-merge watcher run on timers too, and the operator should be able to
 * see them and trigger one on demand ("Run now") instead of waiting for the
 * next occurrence.
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
import type {
  AutoMergeRunNowOutcome,
  AutoMergeWatcherStatus,
} from "../acquirers/auto-merge-watcher";
import { pickAgentSelection } from "../agent/selection";
import type { AgentSelection } from "../agent/selection";
import { BUILTIN_DENY_PATHS } from "../review/merge-gate";
import { mergeSafetyPolicyLabel } from "../review/merge-safety-rules";
import type { AutoMergeSettings } from "../workspace/config";

/** Dashboard id prefix for scheduled estimation sweeps. */
export const ESTIMATION_JOB_PREFIX = "estimation:";
/** Dashboard id of the scheduled conflict-resolution window. */
export const CONFLICT_RESOLUTION_JOB_ID = "workspace:conflict-resolution";
/** Dashboard id of the auto-merge watcher. */
export const AUTO_MERGE_JOB_ID = "workspace:auto-merge";

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

/** The auto-merge watcher, when GitHub PRs are wired. */
export interface AutoMergeJobSource {
  autoMergeStatus(): AutoMergeWatcherStatus | null;
  runAutoMergeNow(): AutoMergeRunNowOutcome;
}

export interface ScheduledJobSources {
  automations: ScheduleSource;
  estimations?: ScheduleSource;
  /** Resolved per call: reload hooks attach after the dashboard actions are built. */
  conflicts?: () => ConflictWindowSource | undefined;
  /** Live `[workspace].conflict_resolution_*` agent override. */
  conflictAgent?: () => AgentSelection | undefined;
  /** Resolved per call, like `conflicts`. */
  autoMerge?: () => AutoMergeJobSource | undefined;
  /** Live `[workspace].auto_merge*` settings (description and agent). */
  autoMergeSettings?: () => AutoMergeSettings | undefined;
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

function globList(globs: readonly string[]): string {
  return globs.length > 0 ? globs.map((glob) => `\`${glob}\``).join(", ") : "none";
}

/** Description shown on the auto-merge entry's detail page. */
export function autoMergeDescription(settings: AutoMergeSettings | undefined): string {
  const lines = [
    "Merges the agent's own green, conflict-free pull requests when they are safe. " +
      "Every poll checks each open PR: once its head has been stable for the quiet " +
      "period, PRs whose changes all match the safe paths merge without an agent run.",
  ];
  if (settings) {
    lines.push(
      "",
      `- **Safe paths:** ${globList(settings.safePaths)}`,
      `- **Deny paths:** ${globList([...settings.denyPaths, ...BUILTIN_DENY_PATHS])}`,
      `- **Review paths** (always sent to the agent review): ${globList(settings.reviewPaths)}`,
      `- **Agent review** of other PRs: ${settings.review ? `on (\`${mergeSafetyPolicyLabel(settings.policy, settings)}\` policy)` : "off (they stay open)"}`,
      `- **Merge method:** ${settings.method}`,
      `- **CI checks:** ${settings.requireChecks ? "a code PR needs at least one passing check (`auto_merge_require_checks`); safe-path-only PRs may merge without checks" : "failing or pending checks block; a repository without CI merges without checks"}`,
      "",
      "Per-repo `auto_merge_safe_paths`, `auto_merge_deny_paths`, `auto_merge_review_paths`, " +
        "`auto_merge_policy`, `auto_merge_require_checks`, " +
        "`auto_merge_rules` / `auto_merge_rules_file`, and `auto_merge_review_instructions` " +
        "replace these settings.",
    );
  }
  lines.push(
    "",
    "**Run now** checks every open PR immediately, skipping the quiet period and retry " +
      "backoff. GitHub must still report the PR mergeable with passing checks, and a PR " +
      "already decided for its current commit and policy is not re-evaluated.",
  );
  return lines.join("\n");
}

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
    const autoMergeStatus = sources.autoMerge?.()?.autoMergeStatus() ?? null;
    if (autoMergeStatus) {
      const settings = sources.autoMergeSettings?.();
      jobs.push({
        id: AUTO_MERGE_JOB_ID,
        title: "Auto-merge",
        kind: "auto_merge",
        enabled: true,
        interval: `${autoMergeStatus.intervalSeconds}s`,
        prompt: autoMergeDescription(settings),
        openPr: false,
        ...(settings?.review ? pickAgentSelection(settings.agent ?? {}) : {}),
        ...(autoMergeStatus.nextTickAt !== undefined
          ? { nextDueAt: autoMergeStatus.nextTickAt }
          : {}),
        runFilter: { origin: "auto_merge" },
      });
    }
    return jobs;
  };

  const trigger = async (id: string): Promise<ManualTriggerOutcome> => {
    if (id === AUTO_MERGE_JOB_ID) {
      const autoMerge = sources.autoMerge?.();
      if (!autoMerge) return { ok: false, reason: "auto-merge is not available on this worker" };
      return autoMerge.runAutoMergeNow();
    }
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
