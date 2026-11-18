/**
 * Automatic DevIntern defect reports for failed task runs (opt-in).
 *
 * When `DEVINTERN_AUTO_REPORT` is on, a failed task run is analysed locally
 * ({@link analyzeFailure}). Only a confirmed DevIntern defect is submitted,
 * through the same intake as `devintern report` (devintern.com, or
 * `DEVINTERN_REPORT_URL`). The destination never depends on the task's
 * repository or tracker.
 *
 * Guarantees:
 * - Off by default; when off, nothing is analysed or sent.
 * - Never throws and is bounded by a timeout, so the original task result
 *   (failed run, tracker feedback, exit code) is always preserved.
 * - Never re-enters itself: a process-level flag plus an environment marker
 *   (inherited by any child process) stop recursive analysis.
 * - Payloads carry no logs, run history, task content, or identifiers.
 */

import { homedir } from "node:os";
import { createBugReporter } from "./api";
import { analyzeFailure, describeDefect } from "./failure-analysis";
import type { FailureAnalysis } from "./failure-analysis";
import { resolveReportDir } from "./paths";
import { readStoredIdentity } from "./session";
import type { ReportIdentity } from "./session";
import { listSpoolEntries, pruneSpool } from "./store";
import type { SpoolEntry } from "./store";
import { currentInstallKind, isValidContactEmail, submitWithSpool } from "./submission";
import type { BugReporter, BugReporterOptions } from "./types";

/** Opt-in switch. */
export const AUTO_REPORT_ENV = "DEVINTERN_AUTO_REPORT";
/** Contact address for anonymous automatic reports. */
export const AUTO_REPORT_EMAIL_ENV = "DEVINTERN_REPORT_EMAIL";
/** Set while an automatic report is in progress; blocks recursion in children. */
export const AUTO_REPORT_ACTIVE_ENV = "DEVINTERN_AUTO_REPORT_ACTIVE";

/** Evidence key that marks a payload as an automatic report. */
export const AUTO_REPORT_EVIDENCE_KEY = "auto-report";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Same defect signature is not re-sent within this window. */
const DUPLICATE_WINDOW_DAYS = 30;

export type AutoReportOutcome =
  | { status: "disabled" }
  | { status: "recursive" }
  | { status: "not_reported"; analysis: FailureAnalysis }
  | { status: "duplicate"; analysis: FailureAnalysis; reportId: string; url?: string }
  | { status: "no_contact"; analysis: FailureAnalysis }
  | { status: "reported"; analysis: FailureAnalysis; reportId: string; url?: string }
  | { status: "submit_failed"; analysis: FailureAnalysis; error: string; savedPath?: string }
  | { status: "error"; error: string };

/** Whether automatic defect reports are enabled. */
export function isAutoReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTO_REPORT_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface AutoReportInput {
  error: unknown;
  /** Task key, used only to redact it from anything sent. */
  taskKey?: string;
  /** Pipeline step active when the run failed. */
  failedStep?: string;
  cliVersion?: string;
}

export interface AutoReportDeps {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  cwd?: string;
  /** Override identity lookup (tests). */
  identity?: ReportIdentity;
  /** Override the reporter (tests); receives the resolved options. */
  createReporter?: (options: BugReporterOptions) => BugReporter;
  /** Forwarded to the default reporter (tests). */
  fetchImpl?: typeof fetch;
  /** DevIntern package root for frame attribution (tests). */
  packageRoot?: string | null;
  timeoutMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

let running = false;

/** Find an earlier automatic report with the same defect signature. */
function findDuplicate(reportDir: string, signature: string, now: Date): SpoolEntry | null {
  const cutoff = now.getTime() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of listSpoolEntries(reportDir)) {
    const marker = entry.payload.context?.evidence?.find(
      (item) => item.key === AUTO_REPORT_EVIDENCE_KEY,
    );
    if (!marker || !marker.text.includes(signature)) continue;
    if (Date.parse(entry.savedAt) < cutoff) continue;
    return entry;
  }
  return null;
}

/** Wrap `fetch` so every request is also cancelled by `signal`. */
function abortableFetch(base: typeof fetch, signal: AbortSignal): typeof fetch {
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    base(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });
  return Object.assign(wrapped, base);
}

async function runAutoReport(
  input: AutoReportInput,
  deps: AutoReportDeps,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<AutoReportOutcome> {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const analysis = analyzeFailure(input.error, {
    cwd,
    homeDir: homedir(),
    ...(deps.packageRoot !== undefined ? { packageRoot: deps.packageRoot } : {}),
    ...(input.failedStep ? { failedStep: input.failedStep } : {}),
  });
  if (analysis.verdict !== "defect" || !analysis.signature) {
    return { status: "not_reported", analysis };
  }

  const reportDir = resolveReportDir(deps.configDir, cwd);
  pruneSpool(reportDir);
  const duplicate = findDuplicate(reportDir, analysis.signature, now());
  if (duplicate?.status === "submitted") {
    return {
      status: "duplicate",
      analysis,
      reportId: duplicate.receipt ?? duplicate.payload.reportId,
      ...(duplicate.url ? { url: duplicate.url } : {}),
    };
  }

  const identity = deps.identity ?? readStoredIdentity(deps.configDir);
  const email = env[AUTO_REPORT_EMAIL_ENV]?.trim();
  const contactEmail = isValidContactEmail(email) ? email : undefined;
  if (!identity.signedIn && !contactEmail) {
    return { status: "no_contact", analysis };
  }

  const options: BugReporterOptions = {
    cwd,
    ...(deps.configDir ? { configDir: deps.configDir } : {}),
    ...(identity.accessToken ? { accessToken: identity.accessToken } : {}),
    signedIn: identity.signedIn,
    cliVersion: input.cliVersion ?? "unknown",
    installKind: currentInstallKind(),
    ...(contactEmail ? { contactEmail } : {}),
    fetchImpl: abortableFetch(deps.fetchImpl ?? fetch, signal),
    timeoutMs: 10_000,
    now,
  };
  const reporter = (deps.createReporter ?? createBugReporter)(options);

  // A failed earlier submission of the same defect is resent as-is.
  const prepared = duplicate
    ? {
        payload: duplicate.payload,
        bytes: Buffer.byteLength(JSON.stringify(duplicate.payload), "utf8"),
      }
    : await reporter.prepare({
        ...describeDefect(analysis, {
          ...(input.failedStep ? { failedStep: input.failedStep } : {}),
          ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
        }),
        source: "cli",
        command: "automatic failure report",
        // Environment only: no run summary, stages, or log text.
        diagnostics: false,
        logs: false,
        shareIdentifiers: false,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
        ...(contactEmail ? { contactEmail } : {}),
        evidence: [
          {
            key: AUTO_REPORT_EVIDENCE_KEY,
            title: "Automatic failure analysis",
            mediaType: "text/plain",
            text: `verdict: defect\nsignature: ${analysis.signature}\nrationale: ${analysis.rationale}`,
          },
        ],
      });

  // The caller already gave up (timeout): do not start a submission it cannot see.
  if (signal.aborted) return { status: "error", error: "cancelled after timeout" };
  const outcome = await submitWithSpool(reporter, prepared, reportDir);
  if (outcome.ok) {
    return {
      status: "reported",
      analysis,
      reportId: outcome.result.id,
      ...(outcome.result.url ? { url: outcome.result.url } : {}),
    };
  }
  return { status: "submit_failed", analysis, error: outcome.error, savedPath: outcome.savedPath };
}

/**
 * Analyse a failed task run and, when it is a DevIntern defect, report it.
 *
 * Never throws. Resolves to what happened so the caller can surface it.
 */
export async function maybeAutoReportFailure(
  input: AutoReportInput,
  deps: AutoReportDeps = {},
): Promise<AutoReportOutcome> {
  const env = deps.env ?? process.env;
  if (!isAutoReportEnabled(env)) return { status: "disabled" };
  if (running || env[AUTO_REPORT_ACTIVE_ENV] === "1") return { status: "recursive" };

  running = true;
  const previousMarker = env[AUTO_REPORT_ACTIVE_ENV];
  env[AUTO_REPORT_ACTIVE_ENV] = "1";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    try {
      return await runAutoReport(input, deps, env, controller.signal);
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      } satisfies AutoReportOutcome;
    }
  })();
  // The recursion guard stays up until the work really settles, even when the
  // caller stops waiting on a timeout: a later failure in the same process
  // cannot start a second analysis while this one is still winding down. A
  // grace period bounds that, so work that never settles cannot silence
  // every later report in a long batch.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (previousMarker === undefined) delete env[AUTO_REPORT_ACTIVE_ENV];
    else env[AUTO_REPORT_ACTIVE_ENV] = previousMarker;
    running = false;
  };
  void work.finally(release);
  try {
    return await Promise.race([
      work,
      new Promise<AutoReportOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          const grace = setTimeout(release, timeoutMs);
          (grace as { unref?: () => void }).unref?.();
          resolve({ status: "error", error: `timed out after ${timeoutMs} ms` });
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run-stage record for an outcome, or null when nothing should be shown. */
export function autoReportStage(outcome: AutoReportOutcome): {
  status: "succeeded" | "skipped" | "failed";
  summary: string;
  detail: Record<string, unknown>;
} | null {
  switch (outcome.status) {
    case "disabled":
    case "recursive":
      return null;
    case "reported":
      return {
        status: "succeeded",
        summary: `Reported a DevIntern issue${outcome.url ? `: ${outcome.url}` : ` (${outcome.reportId})`}`,
        detail: {
          reported: true,
          reportId: outcome.reportId,
          ...(outcome.url ? { url: outcome.url } : {}),
          rationale: outcome.analysis.rationale,
        },
      };
    case "duplicate":
      return {
        status: "succeeded",
        summary: `Already reported as a DevIntern issue${outcome.url ? `: ${outcome.url}` : ` (${outcome.reportId})`}`,
        detail: {
          reported: true,
          duplicate: true,
          reportId: outcome.reportId,
          ...(outcome.url ? { url: outcome.url } : {}),
          rationale: outcome.analysis.rationale,
        },
      };
    case "not_reported":
      return {
        status: "skipped",
        summary: `Not reported: ${outcome.analysis.verdict === "task" ? "not a DevIntern defect" : "inconclusive"} (${outcome.analysis.rationale})`,
        detail: {
          reported: false,
          verdict: outcome.analysis.verdict,
          rationale: outcome.analysis.rationale,
        },
      };
    case "no_contact":
      return {
        status: "skipped",
        summary: `DevIntern defect found but not reported: sign in or set ${AUTO_REPORT_EMAIL_ENV}`,
        detail: { reported: false, verdict: "defect", rationale: outcome.analysis.rationale },
      };
    case "submit_failed":
      return {
        status: "failed",
        summary: `DevIntern defect report could not be sent: ${outcome.error}`,
        detail: {
          reported: false,
          verdict: "defect",
          error: outcome.error,
          ...(outcome.savedPath ? { savedPath: outcome.savedPath } : {}),
        },
      };
    case "error":
      return {
        status: "failed",
        summary: `Failure analysis did not complete: ${outcome.error}`,
        detail: { reported: false, error: outcome.error },
      };
  }
}

/** One console line describing an outcome, or null for disabled/recursive. */
export function autoReportMessage(outcome: AutoReportOutcome): string | null {
  switch (outcome.status) {
    case "disabled":
    case "recursive":
      return null;
    case "reported":
      return `🐞 Reported a DevIntern issue for this failure: ${outcome.url ?? outcome.reportId}`;
    case "duplicate":
      return `🐞 This DevIntern issue was already reported: ${outcome.url ?? outcome.reportId}`;
    case "not_reported":
      return `🔎 Failure analysis: ${outcome.analysis.verdict === "task" ? "not a DevIntern defect" : "inconclusive"}; no report sent.`;
    case "no_contact":
      return `🔎 Failure analysis found a DevIntern defect, but no report was sent. Run \`devintern login\` or set ${AUTO_REPORT_EMAIL_ENV}.`;
    case "submit_failed":
      return `⚠️  DevIntern defect report could not be sent (${outcome.error}). Retry with \`devintern report --from ${outcome.savedPath ?? "<path>"}\`.`;
    case "error":
      return `⚠️  Failure analysis did not complete: ${outcome.error}`;
  }
}
