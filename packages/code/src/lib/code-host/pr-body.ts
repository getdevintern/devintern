/**
 * Structured PR-body template.
 *
 * A PR body is a one-minute briefing for a reviewer who already has the diff:
 * why the change exists, what it changed, what it leaves out, what it could
 * break, and how it was verified. The builder always emits every section; a
 * section the agent did not supply is marked `N/A` rather than dropped, so a
 * reviewer can tell "nothing to say" apart from "forgot".
 *
 * When the agent's implementation summary already carries one of these
 * sections (any `##` or `###` heading with a recognized name), it is reused
 * verbatim. Otherwise the summary as a whole becomes "What changed".
 */

/** Canonical section keys in template order. */
export const PR_BODY_SECTION_KEYS = [
  "why",
  "what-changed",
  "scope",
  "tradeoffs",
  "blast-radius",
  "verification",
] as const;

export type PrBodySectionKey = (typeof PR_BODY_SECTION_KEYS)[number];

/** Rendered heading for each canonical section. */
const PR_BODY_SECTION_LABELS: Record<PrBodySectionKey, string> = {
  why: "Why",
  "what-changed": "What changed",
  scope: "Scope",
  tradeoffs: "Tradeoffs",
  "blast-radius": "Blast Radius",
  verification: "Verification",
};

/** Marker used when a section has no content to report. */
const NOT_APPLICABLE = "N/A";

/** Recognized heading names (normalized) mapped to canonical sections. */
const HEADING_ALIASES: Record<string, PrBodySectionKey> = {
  why: "why",
  "what changed": "what-changed",
  "whats changed": "what-changed",
  "what has changed": "what-changed",
  "what's changed": "what-changed",
  "changes made": "what-changed",
  changes: "what-changed",
  summary: "what-changed",
  implementation: "what-changed",
  "implementation details": "what-changed",
  scope: "scope",
  "in scope": "scope",
  "out of scope": "scope",
  tradeoffs: "tradeoffs",
  "trade offs": "tradeoffs",
  "trade off": "tradeoffs",
  "tradeoffs considered": "tradeoffs",
  "blast radius": "blast-radius",
  "blast-radius": "blast-radius",
  "blast radius and risk": "blast-radius",
  "blast radius and risks": "blast-radius",
  risks: "blast-radius",
  verification: "verification",
  testing: "verification",
  "test plan": "verification",
  "how verified": "verification",
  "verification steps": "verification",
};

/** Inputs for {@link buildPrBody}. */
export interface PrBodyInput {
  taskKey: string;
  taskSummary: string;
  /** Agent implementation summary; parsed for template sections when present. */
  implementationSummary?: string;
}

/** Normalize a heading so aliases match regardless of case or punctuation. */
function normalizeHeading(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[`*_#]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[?:!.,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract recognized template sections from an implementation summary.
 *
 * @param markdown - Agent output, or any markdown with section headings
 * @returns The content found per canonical section (empty when absent)
 */
export function parsePrBodySections(
  markdown: string | undefined,
): Partial<Record<PrBodySectionKey, string>> {
  if (!markdown) return {};

  const sections: Partial<Record<PrBodySectionKey, string>> = {};
  let current: PrBodySectionKey | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    const text = buffer.join("\n").trim();
    if (text && !sections[current]) sections[current] = text;
  };

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/);
    if (heading) {
      flush();
      buffer = [];
      current = HEADING_ALIASES[normalizeHeading(heading[1])];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  return sections;
}

/**
 * Build the PR body from task metadata and the agent's implementation summary.
 *
 * Every canonical section is emitted in order; missing content is marked
 * `N/A`.
 *
 * @param input - Task identity plus the optional agent summary
 */
export function buildPrBody(input: PrBodyInput): string {
  const { taskKey, taskSummary, implementationSummary } = input;
  const parsed = parsePrBodySections(implementationSummary);
  const hasStructuredSections = Object.values(parsed).some((value) => (value ?? "").trim());

  const content: Record<PrBodySectionKey, string> = {
    why: (parsed.why ?? "").trim() || `Task ${taskKey}: ${taskSummary}`.trim(),
    "what-changed":
      (parsed["what-changed"] ?? "").trim() ||
      (hasStructuredSections ? "" : (implementationSummary ?? "").trim()),
    scope: (parsed.scope ?? "").trim(),
    tradeoffs: (parsed.tradeoffs ?? "").trim(),
    "blast-radius": (parsed["blast-radius"] ?? "").trim(),
    verification: (parsed.verification ?? "").trim(),
  };

  const lines: string[] = [];
  for (const key of PR_BODY_SECTION_KEYS) {
    lines.push(`## ${PR_BODY_SECTION_LABELS[key]}`);
    lines.push("");
    lines.push(content[key] || NOT_APPLICABLE);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("*This PR was automatically created by @devintern/code*");

  return lines.join("\n");
}
