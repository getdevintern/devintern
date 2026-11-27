/**
 * Text form of `devintern worker doctor`, shared with `devintern doctor`
 * when it runs in a worker repository so both print the same checklist.
 */

import { applyWorkspaceProcessEnv } from "../workspace/env";
import { setupStateFor } from "./readiness-json";
import { renderReadinessReport } from "./readiness";
import type { ReadinessCheck } from "./readiness";
import { collectWorkerDoctorChecks, workerDoctorClosingLine } from "./worker-readiness";
import type { WorkerDoctorOptions } from "./worker-readiness";

/** Result of one text worker-doctor pass. */
export interface WorkerDoctorTextResult {
  checks: ReadinessCheck[];
  hasFailures: boolean;
  hasWarnings: boolean;
  hasActions: boolean;
  /** 1 a check failed, 2 only a step for the user is left (sign in), 0 ready. */
  exitCode: number;
}

/**
 * Collect the worker checks with the workspace `.env` applied to this
 * process (like the daemon) and print the checklist, closing line, and
 * `Setup:` line.
 */
export async function runWorkerDoctorText(
  workspaceDir: string,
  options: WorkerDoctorOptions,
  log: (message: string) => void = console.log,
): Promise<WorkerDoctorTextResult> {
  // Mirror the daemon: shared workspace values (AGENT_HARNESS, AGENT_CLI_PATH,
  // LICENSE_KEY, ...) apply to this process. Only process.env changes.
  const processEnv = { ...process.env };
  try {
    applyWorkspaceProcessEnv(workspaceDir);
  } catch {
    // Unreadable workspace .env: the config check reports the workspace state.
  }
  const checks = await collectWorkerDoctorChecks(options, { processEnv });
  const report = renderReadinessReport(checks);
  log(`🩺 devintern worker readiness${options.offline ? " (offline)" : ""}:\n`);
  log(report.lines.join("\n"));
  log(`\n${workerDoctorClosingLine(checks, report)}`);
  const { setup, summary } = setupStateFor(checks);
  // The done signal for scripts and agents reading the text output.
  log(`Setup: ${setup} — ${summary}`);
  return {
    checks,
    hasFailures: report.hasFailures,
    hasWarnings: report.hasWarnings,
    hasActions: report.hasActions,
    exitCode: report.hasFailures ? 1 : report.hasActions ? 2 : 0,
  };
}
