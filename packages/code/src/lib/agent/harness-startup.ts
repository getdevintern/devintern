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

import { REDACTED, redactText } from "@devintern/utils";

import { redactSecrets } from "../observability/worker-logs";

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

/**
 * Compiler/linter diagnostics open with `path:line[:column]:`. Those lines are
 * agent output even when they mention sandbox symbols such as
 * `landlock_ruleset`, so they must never be read as a startup signal. The path
 * may contain spaces (`/Users/John Smith/project/src/sandbox.c`), so only the
 * `:line:column:` suffix is allowed to be colon-free.
 */
const COMPILER_DIAGNOSTIC_LINE =
  /^\s*(?:[A-Za-z]:)?[^\n:]+\.(?:[A-Za-z0-9]+):\d+(?::\d+)?:\s*(?:fatal\s+)?(?:error|warning|note|remark)\b/i;

/**
 * Patterns that name sandbox/harness state directly, so they only appear when
 * the process failed before the agent ran and stay valid for a run of any
 * length.
 */
const STARTUP_PATTERNS: RegExp[] = [
  /path_not_granted/i,
  /sandbox[^\n]*(?:initializ|initialis|setup|startup)[^\n]*(?:fail|error|denied)/i,
  /(?:fail(?:ed)?|error|cannot|unable)[^\n]*sandbox[^\n]*(?:initializ|initialis|setup|startup)/i,
  /seatbelt[^\n]*(?:error|denied|fail)/i,
];

/**
 * Generic OS-error wordings that ordinary agent work also prints: `npm ERR!
 * EACCES`, a tool spawned by the agent reporting `code: 'ENOENT'`, or a mise
 * shim invoked mid-run. They are startup-shaped only inside
 * {@link STARTUP_OUTPUT_WINDOW_MS}, so a long run is never reclassified as a
 * harness that could not start (which would swallow the real task failure).
 */
const WINDOWED_STARTUP_PATTERNS: RegExp[] = [
  /\bmise\s+ERROR\b[\s\S]{0,400}?Permission denied/i,
  /\bmise\b[^\n]*Permission denied/i,
  /Permission denied \(os error 13\)/i,
  /\bEACCES\b/,
  /\bENOENT\b/,
];

/**
 * A landlock failure is startup-shaped only inside the startup window: a test
 * or build can legitimately print "landlock ruleset failed to apply" mid-run.
 * This pattern is additionally gated on an exit within
 * {@link STARTUP_OUTPUT_WINDOW_MS} in {@link detectHarnessStartupFailure}. Both
 * directions are matched ("landlock ... failed" and "failed to apply
 * landlock ...") because the two orderings both occur in real sandbox errors.
 */
const LANDLOCK_STARTUP_PATTERN =
  /(?:\blandlock\b[^\n]*(?:fail|error|denied|not permitted|permission denied)|(?:fail(?:ed|ure)?|error|cannot|unable)[^\n]*\blandlock\b)/i;

/**
 * A nested nono wrapper fails while creating its session/capability state,
 * before the agent starts. Anchor on startup-specific phrases so a mid-run
 * audit-log write failure stays an ordinary agent failure. This pattern is
 * additionally gated on an exit within {@link STARTUP_OUTPUT_WINDOW_MS} in
 * {@link detectHarnessStartupFailure}.
 */
const NONO_STARTUP_PATTERN =
  /nono:[^\n]*(?:snapshot error|creating session|failed to create session|session (?:state|directory)|capabilit(?:y|ies) state)/i;

/** Drop compiler diagnostic lines before testing runtime startup patterns. */
function withoutCompilerDiagnostics(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !COMPILER_DIAGNOSTIC_LINE.test(line))
    .join("\n");
}

/**
 * Token shapes that neither {@link redactText} nor {@link redactSecrets} covers
 * but harness CLIs commonly echo (GitLab, npm, Google API keys).
 */
const EXTRA_AGENT_TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // `\b` does not fire between a token's final `-`/`_` and the following
  // punctuation, so anchor with lookarounds instead: a token ending in a
  // character from its own class must still be masked.
  {
    pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  { pattern: /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g, replacement: REDACTED },
  { pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, replacement: REDACTED },
  // DER-encoded key bodies in base64 (PKCS#8/SPKI start with `MII`) can be
  // echoed without a `-----BEGIN ... PRIVATE KEY-----` marker, which is what
  // the PEM rule in {@link redactSecrets} needs.
  { pattern: /MII[A-Za-z0-9+/=]{40,}/g, replacement: REDACTED },
];

/**
 * Redact agent-derived text before it leaves this process.
 *
 * Exit and startup reasons are posted verbatim as ticket-comment feedback and
 * persisted in `runs.outcome_reason`, so they get the strongest available
 * redaction rather than the Sentry-oriented {@link redactText} alone.
 * {@link redactSecrets} additionally masks AWS/Slack tokens, `KEY=value`
 * assignments, JSON password fields, and PEM blocks; the extra patterns cover
 * token shapes both shared helpers miss.
 *
 * @param text - Agent or harness output that may embed credentials.
 * @returns The same text with credential-shaped substrings replaced.
 */
export function redactAgentOutput(text: string): string {
  let out = redactSecrets(redactText(text));
  for (const { pattern, replacement } of EXTRA_AGENT_TOKEN_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** First line matching one of the given patterns, so the reason names the cause. */
function firstMatchingLine(text: string, patterns: RegExp[]): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => patterns.some((pattern) => pattern.test(line)));
}

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
 * A whole line of bare key material: a PEM body line (base64, no internal
 * whitespace) or a DER blob that starts with `MII`. Marker-based redaction
 * cannot recognise these, so they must never be selected as a reason in the
 * first place.
 */
const BARE_KEY_MATERIAL_LINE = /^(?:MII[A-Za-z0-9+/=]{40,}|[A-Za-z0-9+/]{60,}={0,2})$/;

/**
 * Whether a single output line is just credential material.
 *
 * Internal whitespace disqualifies a line: a sentence contains spaces, whereas
 * a PEM body line does not.
 *
 * @param line - One output line (already trimmed by the caller).
 * @returns True when the line carries no failure information besides key bytes.
 */
function isBareKeyMaterialLine(line: string): boolean {
  return BARE_KEY_MATERIAL_LINE.test(line.trim());
}

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
      .filter(Boolean)
      // A lone key body line carries no failure meaning and cannot be redacted
      // by marker-based rules, so skip it rather than emit it in `outcome_reason`
      // and the posted tracker comment.
      .filter((line) => !isBareKeyMaterialLine(line));
  const stderrLines = lines(stderr);
  const stdoutLines = lines(stdout);
  const failureLine = stderrLines
    .filter((line) =>
      /\b(?:error|failed|failure|denied|permission|not found|timed out|limit)\b/i.test(line),
    )
    .at(-1);
  const reason = failureLine ?? stderrLines.at(-1) ?? stdoutLines.at(-1);
  if (!reason) return undefined;
  // Agent output can echo credentials (failed `git push`, API error bodies).
  // Redact before truncating so a cut token cannot slip past the patterns.
  const redacted = redactAgentOutput(reason);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

/**
 * Longest exit delay still treated as startup-shaped for landlock/nono
 * signals. Startup banners and even a cold sandbox start resolve within
 * seconds, so a longer run is more likely to be genuine agent work that merely
 * mentions those names.
 */
const STARTUP_OUTPUT_WINDOW_MS = 30_000;

/**
 * Decide whether an agent child failed before it could start.
 *
 * Conservative rules:
 * - a recognised sandbox/harness startup error (`path_not_granted`, sandbox
 *   initialization, seatbelt) wins at any duration;
 * - generic OS errors (mise/EACCES/ENOENT/`Permission denied (os error 13)`)
 *   and landlock/nono signals only count when the exit lands inside
 *   {@link STARTUP_OUTPUT_WINDOW_MS}; a longer run is ordinary agent work that
 *   merely printed those words, on either stream;
 * - otherwise a non-zero exit within ~2s with no assistant stdout is treated
 *   as a startup failure, unless everything printed was a compiler/linter
 *   diagnostic (that is agent work, not a harness start failure);
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
  const startupText = withoutCompilerDiagnostics(combined);
  // Every gated signal is only startup-shaped inside the window: a test or
  // build can legitimately print "landlock ruleset failed to apply", `npm ERR!
  // EACCES`, or `code: 'ENOENT'` mid-run, on either stream. A longer run is
  // therefore an ordinary task failure; a cold sandbox start that genuinely
  // fails still exits well within this window.
  const withinStartupWindow =
    signals.exitCode !== null && signals.durationMs <= STARTUP_OUTPUT_WINDOW_MS;
  const matchedStartupSignal =
    STARTUP_PATTERNS.some((pattern) => pattern.test(startupText)) ||
    (withinStartupWindow &&
      (WINDOWED_STARTUP_PATTERNS.some((pattern) => pattern.test(startupText)) ||
        LANDLOCK_STARTUP_PATTERN.test(startupText) ||
        NONO_STARTUP_PATTERN.test(startupText)));

  if (matchedStartupSignal) {
    // Prefer the line that actually matched a startup pattern: the first
    // stdout line is often routine progress output and makes the tracker
    // comment and Sentry event misleading.
    const actionableLine =
      firstMatchingLine(startupText, STARTUP_PATTERNS) ??
      (withinStartupWindow
        ? firstMatchingLine(startupText, [
            ...WINDOWED_STARTUP_PATTERNS,
            LANDLOCK_STARTUP_PATTERN,
            NONO_STARTUP_PATTERN,
          ])
        : undefined) ??
      firstActionableLine(signals.stdout, signals.stderr);
    return {
      unavailable: true,
      reason: redactAgentOutput(actionableLine ?? "harness could not start"),
    };
  }

  // A fast exit with no assistant stdout is startup-shaped only when the
  // output is not entirely compiler/linter diagnostics: those are agent work
  // that merely names a sandbox symbol, so the filter used for the pattern
  // check must also gate this heuristic and its reason.
  const allOutputIsCompilerDiagnostics = combined.trim() !== "" && startupText.trim() === "";
  if (
    signals.exitCode !== null &&
    signals.durationMs <= 2_000 &&
    signals.stdout.trim() === "" &&
    !allOutputIsCompilerDiagnostics
  ) {
    return {
      unavailable: true,
      reason: redactAgentOutput(
        firstActionableLine("", startupText) ??
          `exited with code ${signals.exitCode} before producing output`,
      ),
    };
  }

  return null;
}
