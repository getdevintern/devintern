import type {
  RunLineageParent,
  SpawnedDelegatedTask,
  SpawnedFollowUpRun,
  SpawnedTrackerIssue,
  SpawnedWork,
} from "@/lib/api";

/** "Run #871 · onboarding-improvements · delegated", "Run #812 · follow-up on PR #260". */
export function sourcedFromLabel(parent: RunLineageParent): string {
  if (parent.relation === "follow_up") {
    const pr = parent.prNumber !== undefined ? ` on PR #${parent.prNumber}` : "";
    return `Run #${parent.runId} · follow-up${pr}`;
  }
  const subject = parent.automationId ?? parent.taskKey;
  return [`Run #${parent.runId}`, subject, "delegated"].filter(Boolean).join(" · ");
}

/** Spawned work split by kind, in display order. */
export interface SpawnedGroups {
  tasks: SpawnedDelegatedTask[];
  issues: SpawnedTrackerIssue[];
  followUps: SpawnedFollowUpRun[];
}

export function groupSpawned(spawned: readonly SpawnedWork[] | undefined): SpawnedGroups {
  const groups: SpawnedGroups = { tasks: [], issues: [], followUps: [] };
  for (const item of spawned ?? []) {
    if (item.kind === "delegated_task") groups.tasks.push(item);
    else if (item.kind === "tracker_issue") groups.issues.push(item);
    else if (item.kind === "follow_up_run") groups.followUps.push(item);
  }
  return groups;
}

export function hasSpawnedWork(groups: SpawnedGroups): boolean {
  return groups.tasks.length + groups.issues.length + groups.followUps.length > 0;
}

const QUEUE_STATUS_LABELS: Record<NonNullable<SpawnedDelegatedTask["status"]>, string> = {
  pending: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Status text for a delegated task that has no run yet (or whose run is unknown). */
export function queueStatusLabel(status: SpawnedDelegatedTask["status"]): string {
  return status ? QUEUE_STATUS_LABELS[status] : "Unknown";
}

/** An http(s) URL safe to render as a link, else undefined. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}
