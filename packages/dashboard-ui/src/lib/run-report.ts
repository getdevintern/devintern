/**
 * The agent's final report for a run, split for the run-detail "Result".
 *
 * Prompt automations (scheduled and manual runs) usually deliver no PR: their
 * outcome is the report the agent writes at the end, which the pipeline stores
 * as `report` on the implementation stage's detail. That report has a
 * human-facing body followed by a structured briefing between the
 * `devintern:summary` markers (Why / What changed / Scope / …), and may carry
 * a `devintern:outcome` marker line. This module separates those parts and
 * derives a one-line headline so the page can answer "what happened" without
 * opening the timeline or the transcripts.
 *
 * Pure (no React) so it is unit-testable.
 */
import type { RunRecord, RunStageRecord } from "@/lib/api";

// Mirrors IMPLEMENTATION_SUMMARY_START/END in @devintern/agent-harness; the
// dashboard bundle does not depend on that package.
const SUMMARY_START = "<!-- devintern:summary:start -->";
const SUMMARY_END = "<!-- devintern:summary:end -->";

const OUTCOME_MARKER_LINE = /^[ \t]*<!--\s*devintern:outcome\b[^\n]*-->[ \t]*$/gm;

/** Longest headline shown in the outcome panel before it is cut. */
const HEADLINE_MAX_LENGTH = 220;

/** Origins whose deliverable is the agent's report rather than a PR or tracker write. */
const REPORT_ORIGINS: ReadonlySet<RunRecord["origin"]> = new Set(["scheduled", "manual"]);

export interface RunReport {
  /** Human-facing report body (markdown), shown open. */
  body: string;
  /** Structured `devintern:summary` briefing (markdown), shown on demand. */
  briefing?: string;
  /** First sentence of the body when it opens with prose. */
  headline?: string;
}

/** Whether this run's result is its report (prompt automations). */
export function showsReportResult(run: Pick<RunRecord, "origin">): boolean {
  return REPORT_ORIGINS.has(run.origin);
}

/** The latest implementation stage's report string, if one was recorded. */
export function implementationReport(stages: RunStageRecord[]): string | undefined {
  for (let i = stages.length - 1; i >= 0; i--) {
    const stage = stages[i]!;
    if (stage.stage !== "implementation" || !stage.detail) continue;
    try {
      const parsed = JSON.parse(stage.detail) as { report?: unknown };
      if (typeof parsed.report === "string" && parsed.report.trim()) {
        return parsed.report;
      }
    } catch {
      // Non-JSON detail carries no report.
    }
  }
  return undefined;
}

/** Split a raw report into body, briefing, and headline. */
export function parseRunReport(raw: string): RunReport | undefined {
  const text = raw.replace(OUTCOME_MARKER_LINE, "").replace(/\r\n/g, "\n");
  const start = text.indexOf(SUMMARY_START);
  let body = text;
  let briefing: string | undefined;
  if (start !== -1) {
    const afterStart = start + SUMMARY_START.length;
    const end = text.indexOf(SUMMARY_END, afterStart);
    briefing = text.slice(afterStart, end === -1 ? undefined : end).trim() || undefined;
    body = (text.slice(0, start) + (end === -1 ? "" : text.slice(end + SUMMARY_END.length))).trim();
  }
  body = body.trim();
  if (!body) {
    if (!briefing) return undefined;
    // Only the briefing exists: it is the report.
    body = briefing;
    briefing = undefined;
  }
  const headline = reportHeadline(body);
  return { body, ...(briefing ? { briefing } : {}), ...(headline ? { headline } : {}) };
}

/** Report for a run's Result section, or undefined when the run has none to show. */
export function runReport(
  run: Pick<RunRecord, "origin">,
  stages: RunStageRecord[],
): RunReport | undefined {
  if (!showsReportResult(run)) return undefined;
  const raw = implementationReport(stages);
  return raw === undefined ? undefined : parseRunReport(raw);
}

/**
 * First sentence of the body's opening paragraph, as plain text. Undefined when
 * the body opens with a heading, list, table, quote, or code instead of prose.
 */
export function reportHeadline(body: string): string | undefined {
  const paragraph = body.trimStart().split(/\n\s*\n/, 1)[0] ?? "";
  if (!paragraph || /^(#|[-*+]\s|\d+[.)]\s|>|\||```|~~~|<)/.test(paragraph)) {
    return undefined;
  }
  const plain = stripInlineMarkdown(paragraph.replace(/\s+/g, " ").trim());
  const sentence = /^.+?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  if (!sentence) return undefined;
  return sentence.length > HEADLINE_MAX_LENGTH
    ? `${sentence.slice(0, HEADLINE_MAX_LENGTH - 1).trimEnd()}…`
    : sentence;
}

/**
 * The body without its opening sentence, for pages that already show that
 * sentence as the outcome headline. Returns the body unchanged when it has no
 * headline or the headline was truncated (the sentence is not shown whole).
 */
export function dropHeadline(body: string): string {
  const text = body.trimStart();
  const headline = reportHeadline(text);
  if (!headline || headline.endsWith("…")) return body;
  const paragraph = text.split(/\n\s*\n/, 1)[0] ?? "";
  const sentence = /^[\s\S]+?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
  return text.slice(sentence.length).trim();
}

/** Drop emphasis, code ticks, and link targets so a headline reads as plain text. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
}
