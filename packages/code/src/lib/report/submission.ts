/**
 * Submission helpers shared by every manual report entry point.
 *
 * `devintern report` and the dashboard's "Report a problem" action both
 * spool the payload before sending, record the outcome, and validate the
 * contact address the same way. Keeping that here means the dashboard does
 * not reimplement CLI behavior and the CLI stays a thin argv/stdout layer.
 */

import { detectInstallKind } from "@devintern/utils";
import { ReportSubmitError } from "./client";
import { findSpoolEntryFile, markSpoolError, markSpoolSubmitted, saveSpoolEntry } from "./store";
import type { BugReporter, PreparedReport, SubmittedReport } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether an address is acceptable as an anonymous report contact. */
export function isValidContactEmail(email: string | undefined): email is string {
  return typeof email === "string" && EMAIL_PATTERN.test(email.trim());
}

/** Best-effort install kind for triage. */
export function currentInstallKind(): string {
  try {
    return detectInstallKind({
      scriptPath: process.argv[1] ?? "",
      packageName: "@getdevintern/code",
    });
  } catch {
    return "unknown";
  }
}

/** Outcome of a spooled submission. Both branches name the local copy. */
export type SpooledSubmission =
  | { ok: true; result: SubmittedReport; savedPath: string }
  | {
      ok: false;
      error: string;
      /** HTTP status from the report endpoint, when it answered. */
      status?: number;
      /** The endpoint rejected the access token (sign-in expired). */
      authExpired: boolean;
      savedPath: string;
    };

/**
 * Save a prepared payload locally, submit it, and record the outcome.
 *
 * The payload is written before the request so a failure always leaves a copy
 * the user can resend with `devintern report --from <savedPath>`. Resubmitting
 * the same report id reuses its existing spool entry.
 */
export async function submitWithSpool(
  reporter: Pick<BugReporter, "submitPrepared">,
  prepared: PreparedReport,
  reportDir: string,
): Promise<SpooledSubmission> {
  const reportId = prepared.payload.reportId;
  const savedPath =
    findSpoolEntryFile(reportDir, reportId)?.path ?? saveSpoolEntry(reportDir, prepared.payload);
  try {
    const result = await reporter.submitPrepared(prepared);
    markSpoolSubmitted(reportDir, reportId, result);
    return { ok: true, result, savedPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markSpoolError(reportDir, reportId, message);
    const status = error instanceof ReportSubmitError ? error.status : undefined;
    return {
      ok: false,
      error: message,
      ...(status !== undefined ? { status } : {}),
      authExpired: status === 401,
      savedPath,
    };
  }
}
