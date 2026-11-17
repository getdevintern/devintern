/**
 * Machine-readable goal outcome the agent reports in its final response.
 *
 * A clean harness exit only means the agent stopped; it does not mean the
 * agent met its goal. Recurring automations in particular often finish with
 * "I didn't release … the test gate failed" and no repository changes, which
 * the pipeline would otherwise record as a successful no-op. The agent states
 * the outcome explicitly with one marker line next to its
 * `<!-- devintern:summary:start -->` briefing:
 *
 * ```
 * <!-- devintern:outcome status=blocked reason="unit test gate failed" -->
 * ```
 *
 * Agent output is untrusted, so parsing is strict: only a whole line that
 * matches the grammar counts, only within the final report, never inside a
 * code fence, and the reason is sanitized and bounded. Anything else is
 * ignored and the run keeps today's behavior.
 */
import {
  IMPLEMENTATION_SUMMARY_END as SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START as SUMMARY_START,
} from "@devintern/agent-harness";

/** Statuses the marker accepts. */
export type ImplementationOutcomeStatus = "done" | "noop" | "blocked" | "partial";

/** Parsed outcome marker. */
export interface ImplementationOutcome {
  status: ImplementationOutcomeStatus;
  /** Sanitized one-line reason, when the marker carried a non-empty one. */
  reason?: string;
}

/** Upper bound on a persisted outcome reason (runs.outcome_reason). */
export const OUTCOME_REASON_MAX_LENGTH = 300;

/**
 * Without a complete summary block, only this many trailing lines count as
 * the final report, so a marker quoted early in a long transcript is ignored.
 */
const TRAILING_REPORT_LINES = 40;

const OUTCOME_STATUSES: ReadonlySet<string> = new Set(["done", "noop", "blocked", "partial"]);

const MARKER_PATTERN = /^<!--\s*devintern:outcome\s+status=([a-z]+)(?:\s+reason="([^"]*)")?\s*-->$/;

/** Unfilled template placeholder such as `reason="<one line>"`. */
const PLACEHOLDER_PATTERN = /^<[^<>]*>$/;

/** Collapse whitespace, drop control characters, and bound the length. */
function sanitizeReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || PLACEHOLDER_PATTERN.test(cleaned)) return undefined;
  return cleaned.length > OUTCOME_REASON_MAX_LENGTH
    ? `${cleaned.slice(0, OUTCOME_REASON_MAX_LENGTH - 1)}…`
    : cleaned;
}

/** Parse one trimmed line as an outcome marker, or undefined when it is not one. */
function parseMarkerLine(line: string): ImplementationOutcome | undefined {
  const match = line.match(MARKER_PATTERN);
  if (!match || !OUTCOME_STATUSES.has(match[1])) return undefined;
  const status = match[1] as ImplementationOutcomeStatus;
  const reason = sanitizeReason(match[2]);
  return reason === undefined ? { status } : { status, reason };
}

/** Mark each line as inside or outside a fenced code block. */
function classifyLines(lines: string[]): boolean[] {
  let fence: { marker: string; length: number } | undefined;
  return lines.map((line) => {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        /^\s{0,3}([`~]{3,})\s*$/.test(line)
      ) {
        fence = undefined;
      }
      return true;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      return true;
    }
    return false;
  });
}

/**
 * Index of the first line of the final report: the start of the last complete
 * summary block, or the trailing window when the agent wrote no summary.
 */
function finalReportStart(lines: string[], fenced: boolean[]): number {
  let open: number | undefined;
  let lastComplete: number | undefined;
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const trimmed = line.trim();
    if (trimmed === SUMMARY_START) open = index;
    else if (trimmed === SUMMARY_END && open !== undefined) {
      lastComplete = open;
      open = undefined;
    }
  });
  return lastComplete ?? Math.max(0, lines.length - TRAILING_REPORT_LINES);
}

/**
 * Read the agent's outcome marker from its final report.
 *
 * The final report is the last complete summary block plus anything after it
 * (agents are told to put the marker right after the end marker), or the last
 * {@link TRAILING_REPORT_LINES} lines when there is no complete block. The last
 * valid marker in that region wins; malformed markers are ignored.
 *
 * @param output - Agent stdout (or the saved implementation summary file)
 * @returns The parsed outcome, or undefined when no valid marker is present
 */
export function parseImplementationOutcome(output: string): ImplementationOutcome | undefined {
  const lines = output.split(/\r?\n/);
  const fenced = classifyLines(lines);
  let outcome: ImplementationOutcome | undefined;
  for (let index = finalReportStart(lines, fenced); index < lines.length; index++) {
    if (fenced[index]) continue;
    outcome = parseMarkerLine(lines[index].trim()) ?? outcome;
  }
  return outcome;
}

/** Run status and recorded reason implied by a reported outcome. */
export interface OutcomeRunDisposition {
  status: "succeeded" | "escalated";
  reason?: string;
}

/**
 * Map a reported outcome onto the run record.
 *
 * `blocked` escalates: the goal was not met and a human must act. `partial`
 * stays `succeeded` (some of the goal landed, and escalating would hide that
 * delivered work behind a failure state) but keeps the reason visible in
 * `outcome_reason`. No marker, `done`, and `noop` keep a plain success.
 */
export function outcomeRunDisposition(
  outcome: ImplementationOutcome | undefined,
): OutcomeRunDisposition {
  if (outcome?.status === "blocked") {
    return {
      status: "escalated",
      reason: `blocked: ${outcome.reason ?? "the agent reported that it could not meet the goal"}`,
    };
  }
  if (outcome?.status === "partial") {
    return {
      status: "succeeded",
      reason: `partial: ${outcome.reason ?? "the agent reported that the goal was only partly met"}`,
    };
  }
  return { status: "succeeded" };
}

/** Prompt instruction describing the marker; appended to the summary request. */
export const IMPLEMENTATION_OUTCOME_INSTRUCTIONS = `## Goal outcome
If you could not meet the goal, add one line right after the summary end marker:

<!-- devintern:outcome status=blocked reason="one line saying what stopped you" -->

Use status=blocked when a required gate failed (tests, lint, a build or release check),
a required step was refused (a push, a merge, a permission), or a dependency or data
source you needed was unavailable, so the goal was not met.
Use status=partial when you met only part of the goal, and say what is missing.
Finding nothing to do is not blocked: if the work was already done or there was nothing
to change, either omit the line or use status=noop. Omit the line when you met the goal.
Keep the reason on one line, under ${OUTCOME_REASON_MAX_LENGTH} characters, without double quotes.`;
