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
  /sandbox[^\n]*(?:initializ|initialis|setup|startup)[^\n]*(?:fail|error|denied)/i,
  /(?:fail(?:ed)?|error|cannot|unable)[^\n]*sandbox[^\n]*(?:initializ|initialis|setup|startup)/i,
  /landlock[^\n]*(?:error|denied|fail)/i,
  /(?:fail(?:ed)?|error|cannot|unable)[^\n]*landlock[^\n]*(?:ruleset|rules|domain|namespace)/i,
  /seatbelt[^\n]*(?:error|denied|fail)/i,
  // A nested nono wrapper fails while creating its session/capability state,
  // before the agent starts. The OS error wording varies by version, so match
  // the wrapper prefix rather than relying on "Permission denied".
  /nono:[^\n]*(?:snapshot|session|capabilit)[^\n]*(?:error|fail|denied)/i,
];

/** Pick the line that best explains why the process could not start. */
function firstActionableLine(stdout: string, stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionable = lines.find((line) =>
    /mise\s+ERROR|Permission denied|EACCES|ENOENT|path_not_granted|sandbox|denied|not found|failed to/i.test(
      line,
    ),
  );
  if (actionable) return actionable;
  const stdoutLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return stdoutLine;
}

/** Strip ANSI colour/control sequences so the reason stays readable in logs. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Maximum characters of agent output carried into a thrown exit error. */
const EXIT_REASON_MAX_CHARS = 300;

/**
 * Pick the line that best explains an ordinary non-zero agent exit.
 *
 * Startup failures are classified separately by
 * {@link detectHarnessStartupFailure}; this helper covers the remaining case,
 * where the agent ran and then failed. Without it the thrown error is only
 * "Agent exited with code 1", which is unattributable in Sentry and in ticket
 * feedback. Prefer the last stderr line that names a failure, then the last
 * stderr line, then the last stdout line, so the reason is the most specific
 * available without pasting the whole transcript.
 *
 * @param stdout - Captured agent stdout.
 * @param stderr - Captured agent stderr.
 * @param maxChars - Maximum reason length (default 300).
 * @returns A single-line reason, or undefined when the agent produced no output.
 */
export function describeAgentExitFailure(
  stdout: string,
  stderr: string,
  maxChars: number = EXIT_REASON_MAX_CHARS,
): string | undefined {
  const lines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .map((line) => stripAnsi(line).trim())
      .filter(Boolean);
  const stderrLines = lines(stderr);
  const stdoutLines = lines(stdout);
  const failureLine = stderrLines
    .filter((line) =>
      /\b(?:error|failed|failure|denied|permission|not found|timed out|limit)\b/i.test(line),
    )
    .at(-1);
  const reason = failureLine ?? stderrLines.at(-1) ?? stdoutLines.at(-1);
  if (!reason) return undefined;
  return reason.length > maxChars ? `${reason.slice(0, maxChars)}…` : reason;
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

  const combined = `${signals.stderr}\n${signals.stdout}`;
  if (STARTUP_PATTERNS.some((pattern) => pattern.test(combined))) {
    return {
      unavailable: true,
      reason: firstActionableLine(signals.stdout, signals.stderr) ?? "harness could not start",
    };
  }

  if (signals.exitCode !== null && signals.durationMs <= 2_000 && signals.stdout.trim() === "") {
    return {
      unavailable: true,
      reason:
        firstActionableLine(signals.stdout, signals.stderr) ??
        `exited with code ${signals.exitCode} before producing output`,
    };
  }

  return null;
}
