/**
 * In-flight state of a scheduled job that its run record cannot show yet: an
 * occurrence waiting for a free slot (no run row exists until it is admitted)
 * or one whose process started but has not recorded its run.
 */

import { StatusPill } from "@/components/shared";
import type { AutomationSchedule } from "@/lib/api";
import { formatAge, formatTime } from "@/lib/utils";

/**
 * The activity worth showing beside the last run, if any. A running
 * occurrence whose run row already reads `in_progress` is shown by that run.
 */
export function visibleActivity(
  automation: AutomationSchedule,
): AutomationSchedule["activity"] | undefined {
  const activity = automation.activity;
  if (!activity) return undefined;
  if (activity.state === "running" && automation.lastRun?.status === "in_progress") {
    return undefined;
  }
  return activity;
}

/** Pill plus elapsed time: "Waiting for a slot · 4m" or "Starting · 3s". */
export function AutomationActivityStatus({
  activity,
  now = Date.now(),
}: {
  activity: NonNullable<AutomationSchedule["activity"]>;
  now?: number;
}) {
  const waiting = activity.state === "waiting";
  const trigger = activity.trigger === "manual" ? "Run now" : "Scheduled run";
  const title = waiting
    ? `${trigger} ${activity.reason ?? "waiting for a free slot"}; it starts automatically when the slot frees`
    : `${trigger} started; its run appears once the task process records it`;
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <StatusPill tone={waiting ? "attention" : "info"} live={!waiting}>
        {waiting ? "Waiting for a slot" : "Starting"}
      </StatusPill>
      <span className="text-xs text-muted-foreground">{formatAge(activity.since, now)}</span>
    </span>
  );
}

/**
 * Pill for a job a harness usage limit deferred: "Deferred until Nov 28, 2:05 PM".
 * Shown until the limit resets or the next run starts, beside the last run.
 */
export function AutomationDeferralStatus({
  deferral,
}: {
  deferral: NonNullable<AutomationSchedule["deferral"]>;
}) {
  const harness = deferral.harness ? `${deferral.harness} ` : "";
  const until = formatTime(deferral.until);
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`Deferred: ${harness}usage limit until ${until}`}
    >
      <StatusPill tone="attention">Deferred until {until}</StatusPill>
    </span>
  );
}
