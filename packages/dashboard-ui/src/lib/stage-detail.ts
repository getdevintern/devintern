/**
 * Stage-detail parsing for the run-detail timeline.
 *
 * Stage `detail` is a JSON-stringified blob produced by `@getdevintern/code`
 * (see `lib/run-recorder.ts` -> `recordRunStage`). Each pipeline stage has a
 * known shape; this module turns a raw detail string into a friendly view
 * model — a markdown prose section (if any) plus a list of structured fields
 * — so the dashboard can render scannable label/value pairs instead of a
 * raw JSON blob. The original text is always preserved as `raw` so the UI
 * can offer a "show raw" toggle.
 *
 * Designed to be pure (no React) so it is unit-testable.
 */

export type RunStage =
  | "feasibility"
  | "implementation"
  | "auto_review"
  | "change_request"
  | "outcome";

/** A single structured field, rendered as label + value by the UI. */
export interface DetailField {
  label: string;
  value: FieldValue;
}

/** Tagged union of renderable field values. */
export type FieldValue =
  | { kind: "text"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "bool"; value: boolean; yes?: string; no?: string }
  | { kind: "duration"; ms: number }
  | { kind: "score"; value: number; max?: number }
  | { kind: "count"; n: number; noun?: string }
  | { kind: "list"; items: FieldValue[] }
  | { kind: "fields"; fields: DetailField[] }
  | { kind: "issues"; items: Issue[] }
  | { kind: "reviewItems"; items: ReviewItem[] };

export interface Issue {
  category: string;
  description: string;
  severity: string;
}

/** One item from a self-review (auto_review) feedback round. */
export interface ReviewItem {
  priority: string;
  category: string;
  file?: string;
  line?: string;
  issue: string;
  suggestion?: string;
}

export interface ParsedStageDetail {
  /** Markdown prose to render formatted (e.g. agent report). */
  markdown?: string;
  /** Structured fields, each rendered as label + value. */
  fields?: DetailField[];
  /** Raw original (pretty JSON or original text) for the "raw" toggle. */
  raw?: string;
  /** Non-JSON text to show in a `<pre>` as-is (no friendly view). */
  fallback?: string;
}

/**
 * Parse a stage's raw detail string into a friendly view model.
 *
 * @param stage - Pipeline stage name (drives known-shape handling)
 * @param detail - Raw `detail` column value (JSON string or plain text)
 */
export function parseStageDetail(stage: RunStage, detail: string): ParsedStageDetail {
  if (detail.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    // Not JSON — show as-is in a <pre>. Keep the original as raw too.
    return { fallback: detail, raw: detail };
  }

  // Primitives (string/number/boolean) — treat a bare string as markdown if it
  // looks markdown-ish, otherwise as text.
  if (typeof parsed === "string") {
    return looksLikeMarkdown(parsed)
      ? { markdown: parsed, raw: detail }
      : { fallback: parsed, raw: detail };
  }
  if (typeof parsed === "number" || typeof parsed === "boolean") {
    return { fallback: String(parsed), raw: detail };
  }
  if (parsed === null || !isObject(parsed)) {
    return { fallback: detail, raw: detail };
  }

  const raw = JSON.stringify(parsed, null, 2);
  const known = parseKnownShape(stage, parsed as Record<string, unknown>);
  if (known) {
    return { ...known, raw };
  }

  // Unknown object shape — render generically as fields.
  return { fields: genericFields(parsed as Record<string, unknown>), raw };
}

// ---------------------------------------------------------------------------
// Known stage shapes
// ---------------------------------------------------------------------------

function parseKnownShape(
  stage: RunStage,
  obj: Record<string, unknown>,
): { markdown?: string; fields?: DetailField[] } | null {
  switch (stage) {
    case "feasibility":
      return parseFeasibility(obj);
    case "implementation":
      return parseImplementation(obj);
    case "auto_review":
      return parseAutoReview(obj);
    case "change_request":
      return parseChangeRequest(obj);
    default:
      return null;
  }
}

interface ClarityAssessment {
  isImplementable?: unknown;
  clarityScore?: unknown;
  summary?: unknown;
  issues?: unknown;
  recommendations?: unknown;
}

type KnownShape = { markdown?: string; fields?: DetailField[] };

/** Return null when a key-presence match produced nothing useful. */
function knownShapeResult(markdown: string | undefined, fields: DetailField[]): KnownShape | null {
  if (!markdown && fields.length === 0) {
    return null;
  }
  return {
    markdown,
    fields: fields.length > 0 ? fields : undefined,
  };
}

function parseFeasibility(obj: Record<string, unknown>): KnownShape | null {
  const a = obj as ClarityAssessment;
  if (
    typeof a.isImplementable !== "boolean" &&
    typeof a.clarityScore !== "number" &&
    typeof a.summary !== "string"
  ) {
    return null;
  }

  const fields: DetailField[] = [];
  if (typeof a.isImplementable === "boolean") {
    fields.push({
      label: "Implementable",
      value: { kind: "bool", value: a.isImplementable, yes: "yes", no: "no" },
    });
  }
  if (typeof a.clarityScore === "number") {
    fields.push({
      label: "Clarity score",
      value: { kind: "score", value: a.clarityScore, max: 10 },
    });
  }
  if (Array.isArray(a.issues) && a.issues.length > 0) {
    const issues: Issue[] = a.issues.filter(isObject).map((item) => ({
      category: String((item as { category?: unknown }).category ?? "—"),
      description: String((item as { description?: unknown }).description ?? ""),
      severity: String((item as { severity?: unknown }).severity ?? "minor"),
    }));
    if (issues.length > 0) {
      fields.push({ label: "Issues", value: { kind: "issues", items: issues } });
    }
  }
  if (Array.isArray(a.recommendations) && a.recommendations.length > 0) {
    const items = a.recommendations
      .filter((r): r is string => typeof r === "string")
      .map((text) => ({ kind: "text", text }) as FieldValue);
    if (items.length > 0) {
      fields.push({ label: "Recommendations", value: { kind: "list", items } });
    }
  }

  const markdown = typeof a.summary === "string" && a.summary.trim() !== "" ? a.summary : undefined;
  return knownShapeResult(markdown, fields);
}

function parseImplementation(obj: Record<string, unknown>): KnownShape | null {
  if (!("harness" in obj) && !("durationMs" in obj) && !("report" in obj)) {
    return null;
  }
  const fields: DetailField[] = [];
  if (typeof obj.harness === "string") {
    fields.push({ label: "Harness", value: { kind: "text", text: obj.harness } });
  }
  if (typeof obj.durationMs === "number") {
    fields.push({ label: "Duration", value: { kind: "duration", ms: obj.durationMs } });
  }
  const markdown = typeof obj.report === "string" ? obj.report : undefined;
  return knownShapeResult(markdown, fields);
}

/**
 * Auto-review detail from `@getdevintern/code` (`AutoReviewLoopResult` subset):
 * `{ iterations, success, finalFeedback: ReviewFeedback }`.
 * `finalFeedback` may historically be a markdown string; prefer the object shape.
 */
function parseAutoReview(obj: Record<string, unknown>): KnownShape | null {
  if (!("iterations" in obj) && !("success" in obj) && !("finalFeedback" in obj)) {
    return null;
  }
  const fields: DetailField[] = [];
  if (typeof obj.iterations === "number") {
    fields.push({
      label: "Iterations",
      value: { kind: "count", n: obj.iterations, noun: "iteration" },
    });
  }
  if (typeof obj.success === "boolean") {
    fields.push({
      label: "Outcome",
      value: { kind: "bool", value: obj.success, yes: "approved", no: "incomplete" },
    });
  }

  let markdown: string | undefined;
  const ff = obj.finalFeedback;
  if (typeof ff === "string") {
    markdown = ff;
  } else if (isObject(ff)) {
    const summary = (ff as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim() !== "") {
      markdown = summary;
    }
    const items = (ff as { items?: unknown }).items;
    if (Array.isArray(items)) {
      const reviewItems: ReviewItem[] = items.filter(isObject).map((item) => ({
        priority: String((item as { priority?: unknown }).priority ?? "info"),
        category: String((item as { category?: unknown }).category ?? "—"),
        file: optionalString((item as { file?: unknown }).file),
        line: optionalString((item as { line?: unknown }).line),
        issue: String((item as { issue?: unknown }).issue ?? ""),
        suggestion: optionalString((item as { suggestion?: unknown }).suggestion),
      }));
      if (reviewItems.length > 0) {
        fields.push({ label: "Feedback", value: { kind: "reviewItems", items: reviewItems } });
      }
    }
  }

  return knownShapeResult(markdown, fields);
}

function parseChangeRequest(obj: Record<string, unknown>): KnownShape | null {
  if (!("reviewer" in obj) && !("reviewComments" in obj) && !("conversationComments" in obj)) {
    return null;
  }
  const fields: DetailField[] = [];
  if (typeof obj.reviewer === "string") {
    fields.push({ label: "Reviewer", value: { kind: "text", text: obj.reviewer } });
  }
  if (typeof obj.reviewComments === "number") {
    fields.push({
      label: "Review comments",
      value: { kind: "count", n: obj.reviewComments, noun: "comment" },
    });
  }
  if (typeof obj.conversationComments === "number") {
    fields.push({
      label: "Conversation comments",
      value: { kind: "count", n: obj.conversationComments, noun: "comment" },
    });
  }
  return knownShapeResult(undefined, fields);
}

// ---------------------------------------------------------------------------
// Generic fallback for unknown object shapes
// ---------------------------------------------------------------------------

function genericFields(obj: Record<string, unknown>): DetailField[] {
  const fields: DetailField[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    fields.push({ label: prettifyLabel(key), value: genericValue(value) });
  }
  return fields;
}

function genericValue(value: unknown): FieldValue {
  if (typeof value === "string") {
    return looksLikeMarkdown(value)
      ? { kind: "markdown", text: value }
      : { kind: "text", text: value };
  }
  if (typeof value === "number") {
    return { kind: "text", text: String(value) };
  }
  if (typeof value === "boolean") {
    return { kind: "bool", value };
  }
  if (Array.isArray(value)) {
    const items = value.map(genericValue);
    return { kind: "list", items };
  }
  if (isObject(value)) {
    return { kind: "fields", fields: genericFields(value as Record<string, unknown>) };
  }
  return { kind: "text", text: String(value) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stringify only if the value is a non-empty string; otherwise return undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Heuristic: does this string look like markdown (vs. plain prose)? */
function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|`|\[.+\]\(.+\))/m.test(text);
}

/** `clarityScore` -> `Clarity score`. */
function prettifyLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
