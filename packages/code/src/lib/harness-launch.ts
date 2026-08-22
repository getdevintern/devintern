/**
 * Typed launch-failure classification for agent spawns.
 *
 * Fallback must stay limited to *safe* pre-work failures: the executable was
 * missing, the process could not spawn, a recognized authentication failure
 * occurred, or the process exited non-zero before producing meaningful
 * output. Everything else — timeouts, max-turn completion, incomplete work
 * after meaningful output, repository changes, user cancellation, usage
 * limits — must never silently start another harness.
 */

/** Failure classes eligible for automatic fallback to the next candidate. */
export type LaunchFailureClass =
  | "executable-missing"
  | "spawn-failed"
  | "auth-failed"
  | "exited-before-output";

const FALLBACK_ELIGIBLE: readonly LaunchFailureClass[] = [
  "executable-missing",
  "spawn-failed",
  "auth-failed",
  "exited-before-output",
];

/**
 * Whether a failure class may advance the fallback chain.
 *
 * @param classification - Class from an {@link AgentLaunchError}.
 */
export function isFallbackEligible(classification: LaunchFailureClass): boolean {
  return FALLBACK_ELIGIBLE.includes(classification);
}

/** Structured details carried by an {@link AgentLaunchError}. */
export interface AgentLaunchErrorDetails {
  classification: LaunchFailureClass;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

/**
 * Error thrown by spawn sites when a harness launch fails in a way the
 * fallback coordinator can classify. Non-launch failures (timeouts, usage
 * limits, incomplete implementations) keep their existing error types and
 * are therefore never eligible for fallback.
 */
export class AgentLaunchError extends Error {
  readonly classification: LaunchFailureClass;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, details: AgentLaunchErrorDetails) {
    super(message);
    this.name = "AgentLaunchError";
    this.classification = details.classification;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode ?? null;
  }
}

/** Build an {@link AgentLaunchError} for a missing/unspawnable executable. */
export function executableMissingError(message: string): AgentLaunchError {
  return new AgentLaunchError(message, { classification: "executable-missing" });
}

/** Build an {@link AgentLaunchError} for a non-ENOENT spawn failure. */
export function spawnFailedError(message: string, cause?: string): AgentLaunchError {
  return new AgentLaunchError(message, {
    classification: "spawn-failed",
    ...(cause === undefined ? {} : { stderr: cause }),
  });
}

// ---------------------------------------------------------------------------
// Authentication-failure detection.
//
// Patterns are deliberately narrow multi-word phrases tied to auth vocabulary
// so agent-generated source text (docs, code snippets about auth) is not
// mistaken for a live authentication failure. {@link classifyExitFailure}
// additionally only honors a match when nothing task-related precedes it in
// the captured stream (or the matching line itself reports an error): an
// agent transcript that implements login/OAuth features can legitimately
// contain auth vocabulary mid-work, and such exits must never fall back.
// ---------------------------------------------------------------------------

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /api key (is )?(invalid|missing|not configured|required)/i,
  /(api |access )?token (is )?(invalid|expired|missing)/i,
  /authentication (failed|required)|not authenticated/i,
  /unauthorized \(?401\)?|401 unauthorized/i,
  /\bnot logged in\b/i,
  /please (run |execute )?.{0,24}\b(login|auth)\b/i,
  /you need to (log ?in|sign ?in|authenticate)/i,
  /credentials (are )?(missing|not found|required|not configured)/i,
  /\brun `?\/?(login|auth)`?( first| to continue)?\b/i,
];

/** Where an authentication-vocabulary match occurred in captured output. */
interface AuthFailureHit {
  /** Index of the match inside the combined stdout/stderr stream. */
  index: number;
  /** Full text of the line containing the match. */
  line: string;
}

/** Line prefixes that present their content as a live error report. */
const ERROR_REPORT_LINE_PATTERNS: RegExp[] = [
  /^\[?\s*(?:error|err|fatal|exception|traceback|panic)\b/i,
  /^\[\s*(?:error|fatal)\s*\]/i,
  /^[✗✖×⨯✘]/u,
];

/**
 * Whether a line presents itself as an actual error report (as opposed to
 * prose that happens to discuss error topics).
 *
 * @param line - Raw line from captured agent output (ANSI codes allowed).
 */
function isErrorReportLine(line: string): boolean {
  const clean = line.replace(ANSI_ESCAPE, "").trim();
  return ERROR_REPORT_LINE_PATTERNS.some((pattern) => pattern.test(clean));
}

/**
 * Locate the earliest authentication-vocabulary match in combined output.
 *
 * @param stdout - Captured agent stdout.
 * @param stderr - Captured agent stderr.
 */
function findAuthFailureHit(stdout: string, stderr: string): AuthFailureHit | null {
  const combined = `${stdout}\n${stderr}`;
  let earliestIndex: number | undefined;
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    const match = pattern.exec(combined);
    if (match && (earliestIndex === undefined || match.index < earliestIndex)) {
      earliestIndex = match.index;
    }
  }
  if (earliestIndex === undefined) {
    return null;
  }
  const lineStart = combined.lastIndexOf("\n", earliestIndex) + 1;
  const lineEnd = combined.indexOf("\n", earliestIndex);
  return {
    index: earliestIndex,
    line: combined.slice(lineStart, lineEnd === -1 ? combined.length : lineEnd),
  };
}

/**
 * Whether combined stdout/stderr matches a known authentication failure.
 *
 * Pure vocabulary check; {@link classifyExitFailure} adds positional context
 * so mid-work mentions are not treated as live auth failures.
 *
 * @param stdout - Captured agent stdout.
 * @param stderr - Captured agent stderr.
 */
export function detectAuthFailure(stdout: string, stderr: string): boolean {
  return findAuthFailureHit(stdout, stderr) !== null;
}

// ---------------------------------------------------------------------------
// Meaningful-output detection.
//
// "Meaningful" means task-related agent output, not any stdout byte. Startup
// banners, version headers, spinners, and short status lines do not count;
// once real agent content appears, fallback is no longer safe.
// ---------------------------------------------------------------------------

/** Minimum remaining content length (after banner stripping) for meaningfulness. */
const MIN_MEANINGFUL_OUTPUT_LENGTH = 120;

const ANSI_ESCAPE =
  // oxlint-disable-next-line eslint/no-control-regex -- stripping ANSI output requires matching ESC/BEL control characters
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1b\\)|[@-Z\\-_])/g;

/** Lines that look like startup noise rather than task-related agent output. */
const BANNER_LINE_PATTERNS: RegExp[] = [
  /^v?\d+(\.\d+)+/, // version headers
  /^(welcome|loading|connecting|starting|initializing|ready|powered by|logged in as|signed in as)\b/i,
  /^(model|session|account|organization|org|user|cwd|workdir|version|update|help|docs?|tips?)\s*[:：]/i,
  /^(using|running) (model|claude|codex|gpt|gemini|grok|qwen|kimi)/i,
  /^(tip|note|hint)\s*[:：]/i,
  /^[-=*_~#]{3,}$/, // decorative rules
  /^╭|^┌|^═|^─/, // box-drawing frames
];

/**
 * Whether captured stdout contains task-related agent output.
 *
 * Strips ANSI escape codes and common startup/banner/status lines, then
 * requires a minimum amount of remaining content. Auth/startup errors stay
 * fallback-eligible; long transcripts do not.
 *
 * @param output - Captured stdout (only stdout counts: startup diagnostics on
 *                 stderr must not block fallback).
 */
export function hasMeaningfulAgentOutput(output: string): boolean {
  if (!output || !output.trim()) {
    return false;
  }

  const withoutAnsi = output.replace(ANSI_ESCAPE, "");
  const contentLines = withoutAnsi
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !BANNER_LINE_PATTERNS.some((pattern) => pattern.test(line)));

  const contentLength = contentLines.join("\n").trim().length;
  return contentLength >= MIN_MEANINGFUL_OUTPUT_LENGTH;
}

/**
 * Classify a non-zero exit for fallback eligibility.
 *
 * A recognized authentication failure counts as *pre-work* only when its
 * earliest matched phrase appears before any meaningful task-related output
 * (live auth errors print immediately, after at most startup banners), or
 * when the matching line itself presents an error report. Verbose multi-line
 * auth error dumps therefore stay fallback-eligible, while a transcript that
 * implemented login/OAuth features and merely mentions auth vocabulary
 * mid-task does not. Only when no auth match is honored does meaningful task
 * output disqualify the exit from fallback.
 *
 * @param stdout - Captured agent stdout.
 * @param stderr - Captured agent stderr.
 * @returns The failure class when fallback is safe, or `null` when the exit
 *          happened after meaningful output (never fall back then).
 */
export function classifyExitFailure(stdout: string, stderr: string): LaunchFailureClass | null {
  const hit = findAuthFailureHit(stdout, stderr);
  if (hit) {
    const combined = `${stdout}\n${stderr}`;
    const outputBeforeMatch = combined.slice(0, hit.index);
    if (!hasMeaningfulAgentOutput(outputBeforeMatch) || isErrorReportLine(hit.line)) {
      return "auth-failed";
    }
  }
  if (hasMeaningfulAgentOutput(stdout)) {
    return null;
  }
  return "exited-before-output";
}

/**
 * Build the rejection error for a captured non-zero agent exit.
 *
 * This is the exact wiring every spawn site uses to hand a failed launch to
 * the fallback coordinator: safe failure classes become an
 * {@link AgentLaunchError} (fallback-eligible), everything else becomes a
 * plain {@link Error} that never advances the chain.
 *
 * @param message - Full failure message, e.g. ``Agent exited with code 1``.
 * @param stdout - Captured agent stdout.
 * @param stderr - Captured agent stderr.
 * @param exitCode - The child's exit code.
 */
export function exitClassificationError(
  message: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): Error {
  const classification = classifyExitFailure(stdout, stderr);
  return classification
    ? new AgentLaunchError(message, { classification, stdout, stderr, exitCode })
    : new Error(message);
}

// ---------------------------------------------------------------------------
// Sanitization for console messages and aggregated summaries. Reasons may
// embed provider diagnostics; never echo anything credential-shaped.
// ---------------------------------------------------------------------------

const MAX_REASON_LENGTH = 200;

/**
 * Credential-shaped substrings: a key-ish name (`sk`, `rk`, `key`, `token`,
 * `bearer`, including prefixed env-var names like `AUTH_TOKEN` / `API_KEY`,
 * where the underscore prefix defeats `\b`) optionally separated from its
 * value by `-`, `=`, or `:` plus optional whitespace.
 */
const CREDENTIAL_SHAPE =
  /(?<![A-Za-z0-9])(?:sk|rk|key|token|bearer)(?:[-=:]\s*)?[A-Za-z0-9_-]{8,}/gi;

/**
 * Redact credential-shaped substrings and clamp a failure reason for display.
 *
 * @param reason - Raw reason text (error message or matched output line).
 */
export function sanitizeFallbackReason(reason: string): string {
  const redacted = reason
    .replace(CREDENTIAL_SHAPE, "[redacted]")
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[redacted]");
  const singleLine = redacted.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_REASON_LENGTH
    ? `${singleLine.slice(0, MAX_REASON_LENGTH)}…`
    : singleLine;
}
