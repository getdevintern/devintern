/**
 * Consent preview of a prepared report.
 *
 * Both the CLI preview and the dashboard's preview step describe a payload
 * from the same summary, so "what will be sent" reads identically wherever
 * the user files a report.
 */

import type { BugReportPayload } from "./types";

/** Content classes the collector never reads into a report. */
export const REPORT_NEVER_SENT = [
  "task description",
  "prompts",
  "agent transcripts",
  "diffs",
  "source files",
  "environment values",
  "credentials",
] as const;

/** Withheld unless the user opts into sharing identifiers. */
export const REPORT_IDENTIFIERS = "task key and repository slug";

export interface ReportPreviewEnvironment {
  cliVersion: string;
  installKind: string;
  os: string;
  arch: string;
  ci: boolean;
  harness?: string;
  tracker?: string;
  sandbox?: string;
  signedIn: boolean;
}

export interface ReportPreviewRun {
  id?: number;
  status: string;
  failedStep?: string;
  durationMs?: number;
  stageCount: number;
  hasReason: boolean;
}

export interface ReportPreviewLog {
  source: string;
  lines: number;
  bytes: number;
  truncated: boolean;
}

/** Structured "what is attached / what is omitted" view of a payload. */
export interface ReportPreviewSummary {
  environment: ReportPreviewEnvironment;
  run: ReportPreviewRun | null;
  logs: ReportPreviewLog[];
  evidenceCount: number;
  identifiersShared: boolean;
  omitted: string[];
}

/** Summarize a payload for a consent preview. */
export function summarizeReportPayload(
  payload: BugReportPayload,
  options: { shareIdentifiers: boolean },
): ReportPreviewSummary {
  const env = payload.environment;
  const run = payload.context?.run;
  return {
    environment: {
      cliVersion: env.cliVersion,
      installKind: env.installKind,
      os: env.runtime.os,
      arch: env.runtime.arch,
      ci: env.runtime.ci,
      ...(env.harness ? { harness: env.harness.name } : {}),
      ...(env.tracker ? { tracker: env.tracker } : {}),
      ...(env.sandbox ? { sandbox: env.sandbox } : {}),
      signedIn: env.signedIn,
    },
    run: run
      ? {
          ...(run.id !== undefined ? { id: run.id } : {}),
          status: run.status,
          ...(run.failedStep ? { failedStep: run.failedStep } : {}),
          ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
          stageCount: run.stages.length,
          hasReason: Boolean(run.reason),
        }
      : null,
    logs: (payload.context?.logs ?? []).map((log) => ({
      source: log.source,
      lines: log.lines,
      bytes: Buffer.byteLength(log.text, "utf8"),
      truncated: log.truncated === true,
    })),
    evidenceCount: payload.context?.evidence?.length ?? 0,
    identifiersShared: options.shareIdentifiers,
    omitted: [...REPORT_NEVER_SENT, ...(options.shareIdentifiers ? [] : [REPORT_IDENTIFIERS])],
  };
}
