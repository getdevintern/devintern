import { readImplementationReport } from "../agent/implementation-report";
import {
  hasRunStage,
  latestRunStage,
  recordRunStage,
  replaceRunStage,
} from "../state/run-recorder";

/** Extract the `report` string from a recorded stage's JSON detail. */
function readStageReport(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as { report?: unknown };
    return typeof parsed.report === "string" && parsed.report.trim() ? parsed.report : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the implementation stage from this attempt's summary files, correcting
 * an early record when a later phase changed the outcome.
 *
 * The harness writes the stage before commit/verify/auto-review so an
 * interruption in those phases still leaves resumable state. Afterwards:
 *
 * - finalize writes `implementation-summary-incomplete.md` on a halt, turning
 *   the early success into a failure; or
 * - a successful verify/plan repair rewrites `implementation-summary.md`, so
 *   the early report no longer describes what was actually implemented.
 *
 * Both cases replace the single row so the dashboard and session pickup never
 * hand a stale status/report to the next agent, preserving the prior report
 * under `agentReport`.
 *
 * @param taskDir - Per-task output directory holding the summary files
 * @param implementationStartedAt - Epoch ms when the agent session started
 * @param harnessName - Display name recorded on the stage
 * @param execution - Effective model/effort for this task, when known
 */
export function recordImplementationStage(
  taskDir: string,
  implementationStartedAt: number,
  harnessName: string,
  execution: { model?: string; effort?: string } = {},
): ReturnType<typeof readImplementationReport> {
  const implementationReport = readImplementationReport(taskDir, implementationStartedAt);
  const { incomplete, report } = implementationReport;

  const stage = {
    status: incomplete ? ("failed" as const) : ("succeeded" as const),
    summary: incomplete
      ? `incomplete implementation with ${harnessName}`
      : `implemented with ${harnessName}`,
    detail: {
      harness: harnessName,
      ...(execution.model === undefined ? {} : { model: execution.model }),
      ...(execution.effort === undefined ? {} : { effort: execution.effort }),
      durationMs: Date.now() - implementationStartedAt,
      ...(report === undefined ? {} : { report }),
    },
  };

  const recorded = hasRunStage("implementation") ? latestRunStage("implementation") : undefined;
  if (!recorded) {
    recordRunStage("implementation", stage);
  } else {
    const recordedReport = readStageReport(recorded.detail);
    const reportChanged = report !== undefined && report !== recordedReport;
    if (recorded.status !== stage.status || reportChanged) {
      replaceRunStage("implementation", {
        ...stage,
        detail: {
          ...stage.detail,
          ...(recordedReport === undefined || recordedReport === report
            ? {}
            : { agentReport: recordedReport }),
        },
      });
    }
  }

  return implementationReport;
}
