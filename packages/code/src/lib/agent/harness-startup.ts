/**
 * Classify "the harness could not start" separately from "the agent ran and
 * failed".
 *
 * A sandbox denial or mise shim failure happens before the agent can do any
 * work. Treating it as a task failure burns an attempt, records retry state,
 * and posts a failure comment for what is really a configuration problem.
 * The signals below are deliberately conservative: only startup-shaped errors
 * are reclassified, and ordinary agent failures keep the existing path.
 */

/** Error raised when a harness CLI cannot start (sandbox/config problem). */
export class HarnessUnavailableError extends Error {
  readonly harnessName?: string;

  constructor(message: string, options: { harnessName?: string } = {}) {
    super(message);
    this.name = "HarnessUnavailableError";
    this.harnessName = options.harnessName;
  }
}

/** Signals available when an agent child exits. */
export interface HarnessStartupSignals {
  /** Child exit code, or null when killed by a signal. */
  exitCode: number | null;
  /** Captured stdout (assistant output). */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Wall-clock time from spawn to close. */
  durationMs: number;
}

/** Successful classification result. */
export interface HarnessStartupFailure {
  unavailable: true;
  reason: string;
}

/** Patterns that only appear when the process failed before the agent ran. */
const STARTUP_PATTERNS: RegExp[] = [
  /\bmise\s+ERROR\b[\s\S]{0,400}?Permission denied/i,
  /\bmise\b[^\n]*Permission denied/i,
  /Permission denied \(os error 13\)/i,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /path_not_granted/i,
  // DeepSeek Harness headless reports credential problems as `dsh: <CODE>: ...`
  // and exits before the task runs; classify them as configuration failures.
  /\bdsh:\s*(?:MISSING_CREDENTIAL|UNAUTHORIZED|INVALID_[A-Z_]+|[A-Z_]*AUTH[A-Z_]*)\b/i,
  /sandbox[^\n]*(?:initializ|initialis|setup|startup)[^\n]*(?:fail|error|denied)/i,
  /(?:fail(?:ed)?|error|cannot|unable)[^\n]*sandbox[^\n]*(?:initializ|initialis|setup|startup)/i,
  /landlock[^\n]*(?:error|denied|fail)/i,
  /seatbelt[^\n]*(?:error|denied|fail)/i,
];

/** Generic startup-error line filter (case-insensitive). */
const ACTIONABLE_LINE =
  /mise\s+ERROR|Permission denied|EACCES|ENOENT|path_not_granted|sandbox|denied|not found|failed to|MISSING_CREDENTIAL|UNAUTHORIZED/i;
/**
 * dsh error lines look like `dsh: MISSING_CREDENTIAL: ...`. Case-sensitive on
 * purpose so the `dsh: reasoning:` heading (normal stderr streaming) is not
 * mistaken for the failure reason.
 */
const DSH_ERROR_LINE = /\bdsh:\s*[A-Z][A-Z0-9_]*:/;

/** Pick the line that best explains why the process could not start. */
function firstActionableLine(stdout: string, stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Prefer an explicit `dsh: <CODE>: ...` error over generic phrases, because
  // agent reasoning can contain words like "failed" or "ENOENT".
  const dshError = lines.find((line) => DSH_ERROR_LINE.test(line));
  if (dshError) return dshError;
  const actionable = lines.find((line) => ACTIONABLE_LINE.test(line));
  if (actionable) return actionable;
  const stdoutLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return stdoutLine;
}

/**
 * Remove the `dsh: reasoning:` stream from stderr before classification.
 *
 * Headless dsh writes model reasoning to stderr under a `dsh: reasoning:`
 * heading. The reasoning body is free-form (and can mention sandbox failures,
 * EACCES, ENOENT, etc.), so scanning it would misclassify an ordinary task
 * failure as a startup failure. The section ends at the next `dsh:` heading;
 * a trailing reasoning section is dropped entirely.
 *
 * @param stderr - Raw captured stderr.
 * @returns Stderr with reasoning sections removed.
 */
function stripDshReasoning(stderr: string): string {
  const kept: string[] = [];
  let inReasoning = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/^\s*dsh:\s*reasoning:/i.test(line)) {
      inReasoning = true;
      continue;
    }
    if (inReasoning) {
      if (/^\s*dsh:\s*\S/.test(line)) {
        inReasoning = false;
      } else {
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Decide whether an agent child failed before it could start.
 *
 * Conservative rules:
 * - a recognised startup error (sandbox denial/mise/EACCES/ENOENT) wins;
 * - otherwise a non-zero exit within ~2s with no assistant stdout is treated
 *   as a startup failure;
 * - everything else (including timeouts) stays an ordinary agent failure.
 *
 * @param signals - Exit code, captured output, and elapsed time.
 * @returns A failure reason when the harness could not start, else null.
 */
export function detectHarnessStartupFailure(
  signals: HarnessStartupSignals,
): HarnessStartupFailure | null {
  if (signals.exitCode === 0) {
    return null;
  }

  // Ignore the `dsh: reasoning:` stream: it is ordinary model output, not a
  // startup diagnostic, and its free-form text can resemble sandbox errors.
  const stderr = stripDshReasoning(signals.stderr);
  const combined = `${stderr}\n${signals.stdout}`;
  if (STARTUP_PATTERNS.some((pattern) => pattern.test(combined))) {
    return {
      unavailable: true,
      reason: firstActionableLine(signals.stdout, stderr) ?? "harness could not start",
    };
  }

  if (signals.exitCode !== null && signals.durationMs <= 2_000 && signals.stdout.trim() === "") {
    return {
      unavailable: true,
      reason:
        firstActionableLine(signals.stdout, stderr) ??
        `exited with code ${signals.exitCode} before producing output`,
    };
  }

  return null;
}
