/**
 * Automatic bug reports for unexpected task failures.
 *
 * Automatic reports are opt-in-by-default only for DevIntern-internal
 * failures (`autoReport: "internal"`); user-actionable failures (credentials,
 * usage limits, verify findings) stay local. Reports require a signed-in
 * session so maintainers can follow up, and they are deduplicated by
 * fingerprint and capped per day.
 */

import { resolveRuntimeStateDir } from "../config/config-dir";
import { loadProjectSettings } from "../config/project-settings";
import { runContext } from "../cli/context";
import { VERSION } from "../cli/bootstrap";
import { buildFingerprint } from "./fingerprint";
import { readStoredIdentity } from "./session";
import { createBugReporter } from "./api";
import { markSpoolSubmitted, reserveAutoReport, saveSpoolEntry } from "./store";
import { resolveReportDir } from "./paths";
import type { AutoReportMode, BugReportDraft, ReportEvidence } from "./types";

export type FailureClass = "internal" | "user" | "external" | "ignored";

const IGNORED_ERROR_NAMES = new Set(["UsageLimitError", "AbortError", "TaskSkipError"]);
const USER_ERROR_NAMES = new Set([
  "HarnessUnavailableError",
  "LicenseCheckError",
  "AuthenticationError",
  "TrackerAuthError",
  "TrackerConfigurationError",
]);

/** Signals that the failure is actionable on the user's side, not a defect. */
const USER_MESSAGE_PATTERN =
  /\b(?:invalid|missing|expired|unauthorized|forbidden)\b.*\b(?:token|credential|api[-_ ]?key|auth|session|license)\b|\b(?:401|403)\b|not configured|no changes|nothing to commit|usage limit|rate limit/i;

/** Signals that the failure came from the network or another external service. */
const EXTERNAL_MESSAGE_PATTERN =
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|network error|fetch failed)\b/i;

/**
 * Classify a failure for the automatic-report policy.
 *
 * Classification is intentionally conservative: ambiguous errors count as
 * internal so genuine product crashes reach maintainers, while known
 * configuration and network failures stay out of the queue.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (!error) return "ignored";
  const name =
    error !== null && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  if (IGNORED_ERROR_NAMES.has(name)) return "ignored";
  if (USER_ERROR_NAMES.has(name)) return "user";
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (EXTERNAL_MESSAGE_PATTERN.test(message)) return "external";
  if (USER_MESSAGE_PATTERN.test(message)) return "user";
  return "internal";
}

/** Resolve the configured mode, letting the environment override settings. */
export function resolveAutoReportMode(
  setting: AutoReportMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AutoReportMode {
  const raw = env.DEVINTERN_AUTO_REPORT?.trim().toLowerCase();
  if (raw === "off" || raw === "internal" || raw === "all") return raw;
  if (setting === "off" || setting === "internal" || setting === "all") return setting;
  return "internal";
}

export interface AutoReportInput {
  error?: unknown;
  reason?: string;
  failedStep?: string;
  haltKind?: "incomplete" | "stop" | "noop";
  taskKey?: string;
  runId?: number;
}

/** Build the human-readable title and description for an automatic report. */
function describeFailure(input: AutoReportInput): { title: string; description: string } {
  if (input.error) {
    const error = input.error;
    const name = error instanceof Error && error.name ? error.name : "Error";
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
    return {
      title: `Auto: ${name}: ${message.split("\n")[0]?.slice(0, 120) ?? "failure"}`,
      description: [
        `Automatic report from devintern ${VERSION}.`,
        input.taskKey ? `Task: ${input.taskKey}` : "Task: unknown",
        input.failedStep ? `Failed step: ${input.failedStep}` : "",
        message.slice(0, 2000),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  return {
    title: `Auto: task run halted${input.failedStep ? ` at ${input.failedStep}` : ""}`,
    description: [
      `Automatic report from devintern ${VERSION}.`,
      input.taskKey ? `Task: ${input.taskKey}` : "Task: unknown",
      input.failedStep ? `Failed step: ${input.failedStep}` : "",
      input.reason?.slice(0, 2000) ?? "No reason recorded.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** Extract a bounded, redactable stack from an error. */
function stackEvidence(error: unknown): ReportEvidence | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  return {
    key: "stack",
    title: "Error stack",
    mediaType: "text/plain",
    text: error.stack.slice(0, 8000),
  };
}

/**
 * Submit an automatic report when policy allows it. Never throws: reporting
 * must never be the reason a task process exits abnormally.
 */
export async function maybeAutoReportFailure(input: AutoReportInput): Promise<void> {
  try {
    if (process.env.DEVINTERN_TELEMETRY_DISABLED === "1") return;
    const settings = (() => {
      try {
        return loadProjectSettings();
      } catch {
        return null;
      }
    })();
    const mode = resolveAutoReportMode(settings?.diagnostics?.autoReport);
    if (mode === "off") return;

    const classification = input.error ? classifyFailure(input.error) : "internal";
    if (classification === "ignored") return;
    if (!input.error) {
      // Halts are user-code verdicts unless explicitly opted into `all`.
      if (mode !== "all" || input.haltKind === "noop") return;
    } else if (mode === "internal" && classification !== "internal") {
      return;
    }

    const configDir = resolveRuntimeStateDir();
    const identity = readStoredIdentity(configDir);
    if (!identity.signedIn || !identity.accessToken) return;

    const { title, description } = describeFailure(input);
    const fingerprint = buildFingerprint({
      title,
      failedStep: input.failedStep,
      reason: input.reason,
      errorName: input.error instanceof Error ? input.error.name : undefined,
      errorMessage: input.error instanceof Error ? input.error.message : input.reason,
    });
    const reportDir = resolveReportDir(configDir);
    if (!reserveAutoReport(reportDir, fingerprint)) return;

    const stack = stackEvidence(input.error);
    const draft: BugReportDraft = {
      title,
      description,
      source: "auto",
      diagnostics: true,
      logs: settings?.diagnostics?.includeLogs === true,
      runId: input.runId,
      taskKey: input.taskKey,
      command: process.argv.slice(2).join(" "),
      ...(stack ? { evidence: [stack] } : {}),
    };
    const reporter = createBugReporter({
      accessToken: identity.accessToken,
      signedIn: true,
      cliVersion: VERSION,
      configDir,
      timeoutMs: 5000,
    });
    const prepared = await reporter.prepare(draft);
    const saved = saveSpoolEntry(reportDir, prepared.payload);
    try {
      const result = await reporter.submitPrepared(prepared);
      markSpoolSubmitted(reportDir, prepared.payload.reportId, result);
      console.log(
        `🐞 Reported this failure as ${result.id.slice(0, 8)} (metadata only). ` +
          `Set diagnostics.autoReport: "off" to disable.`,
      );
    } catch (error) {
      if (runContext.options?.verbose) {
        console.warn(
          `🐞 Could not send the automatic report (${(error as Error).message}). Saved to ${saved}`,
        );
      }
    }
  } catch {
    // Automatic reporting is best-effort by contract.
  }
}
