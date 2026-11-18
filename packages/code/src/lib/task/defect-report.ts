/**
 * Post-failure hook for automatic DevIntern defect reports.
 *
 * Runs after the failed run is recorded and tracker feedback is posted, so it
 * can only add information: the run status, tracker comment, and exit code
 * are already decided. Disabled unless `DEVINTERN_AUTO_REPORT` is set.
 */

import { VERSION } from "../cli/bootstrap";
import { autoReportMessage, autoReportStage, maybeAutoReportFailure } from "../report/auto-report";
import type { AutoReportOutcome } from "../report/auto-report";
import { recordStageForRun } from "../state/run-recorder";

export interface DefectReportInput {
  error: unknown;
  taskKey: string;
  /** Run id captured before the run ended; the outcome is recorded on it. */
  runId?: number;
  /** Step that was active when the run failed. */
  failedStep?: string;
}

/** Analyse a failed task run and report a DevIntern defect when enabled. Never throws. */
export async function reportDevInternDefect(input: DefectReportInput): Promise<AutoReportOutcome> {
  let outcome: AutoReportOutcome;
  try {
    outcome = await maybeAutoReportFailure({
      error: input.error,
      taskKey: input.taskKey,
      cliVersion: VERSION,
      ...(input.failedStep ? { failedStep: input.failedStep } : {}),
    });
  } catch (error) {
    outcome = { status: "error", error: (error as Error).message };
  }
  try {
    const message = autoReportMessage(outcome);
    if (message) console.log(message);
    const stage = autoReportStage(outcome);
    if (stage && input.runId !== undefined) {
      recordStageForRun(input.runId, "defect_report", stage);
    }
  } catch {
    // Surfacing the outcome is best-effort.
  }
  return outcome;
}
