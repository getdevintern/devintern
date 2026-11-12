import type { HarnessLogFile, RunRecord, RunStageRecord, StageStatus } from "@/lib/api";
import type { StatusTone } from "@/components/shared";
import { parseStageDetail } from "@/lib/stage-detail";

export const STAGE_LABELS: Record<RunStageRecord["stage"], string> = {
  feasibility: "Feasibility check",
  implementation: "Implementation",
  verify: "Verification",
  auto_review: "Self-review",
  change_request: "Change request",
  outcome: "Outcome",
};

export function formatStageLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage;
}

/** Compact human-readable byte size for a log file. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tone for a run or stage status (mirrors the shared badges). */
export function statusTone(status: RunRecord["status"] | StageStatus): StatusTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "deferred":
      return "warning";
    case "escalated":
      return "attention";
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}

/**
 * Human title for the run: the activity-board title when present, otherwise the
 * first markdown H1 of the task description (local tasks put their title there).
 */
export function runTitle(
  run: Pick<RunRecord, "taskTitle" | "taskDescription">,
): string | undefined {
  if (run.taskTitle?.trim()) {
    return run.taskTitle.trim();
  }
  const match = /^#\s+(.+)$/m.exec(run.taskDescription ?? "");
  return match?.[1]?.trim() || undefined;
}

/** Attempt number for this run and how many attempts the transcripts span. */
export function attemptInfo(
  run: RunRecord,
  logs: HarnessLogFile[],
): { attempt?: number; total?: number } {
  const own = (run as { attempt?: number }).attempt;
  const fromLogs = logs.find((log) => log.runId === run.id && log.attempt !== undefined)?.attempt;
  const attempt = own ?? fromLogs;
  const attempts = new Set(logs.map((log) => log.attempt).filter((a) => a !== undefined));
  const total = attempts.size > 1 ? Math.max(...attempts, attempt ?? 0) : undefined;
  return { attempt, total };
}

/** A summary that deserves its own paragraph rather than a one-line preview. */
export function isLongSummary(summary: string | undefined): boolean {
  return summary !== undefined && (summary.length > 160 || summary.includes("\n"));
}

/** Duration a stage itself reports in its detail payload, if any (never inferred). */
export function reportedDuration(
  stage: Pick<RunStageRecord, "stage" | "detail">,
): number | undefined {
  if (!stage.detail) {
    return undefined;
  }
  const field = parseStageDetail(stage.stage, stage.detail).fields?.find(
    (f) => f.value.kind === "duration",
  );
  return field?.value.kind === "duration" ? field.value.ms : undefined;
}
