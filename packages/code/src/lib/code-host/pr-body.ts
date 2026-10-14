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
 * verbatim. Several recognized headings that map to the same section (such as
 * `In scope` and `Out of scope`) are merged, not dropped. Otherwise the
 * summary as a whole becomes "What changed".
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

/**
 * Recognized heading names (normalized) mapped to canonical sections.
 *
 * Keys are compared against {@link normalizeHeading} output, so they use
 * spaces (not hyphens), have no apostrophes, and no trailing punctuation.
 * Multiple distinct headings may map to the same canonical section (e.g.
 * `In scope` and `Out of scope`); their contents are merged rather than one
 * silently winning.
 */
const HEADING_ALIASES: Record<string, PrBodySectionKey> = {
  why: "why",
  "what changed": "what-changed",
  "whats changed": "what-changed",
  "what has changed": "what-changed",
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
  "trade offs considered": "tradeoffs",
  "trade off considered": "tradeoffs",
  "blast radius": "blast-radius",
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
    .replace(/[-\u2013\u2014/]/g, " ")
    .replace(/[?:!.,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Demote an unrecognized `#`/`##` heading that is being kept as section
 * content, so it cannot masquerade as one of the template's own `##` sections
 * in the finished body. Deeper headings (`###`+) are already subordinate and
 * are left untouched.
 */
function demoteHeading(line: string): string {
  if (!/^\s{0,3}#{1,2}\s+/.test(line)) return line;
  return `${line.replace(/^(\s{0,3})#{1,2}\s+/, "$1**").replace(/\s+$/, "")}**`;
}

/** One recognized heading and the content that followed it. */
interface SectionChunk {
  /** Original heading text (trimmed); used to label merged sections. */
  heading: string;
  text: string;
}

interface ParsedPrBody {
  sections: Partial<Record<PrBodySectionKey, SectionChunk[]>>;
  /** Lines seen before the first recognized section heading. */
  preamble: string;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}([`~]{3,})\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/;

function parsePrBody(markdown: string | undefined): ParsedPrBody {
  if (!markdown) return { sections: {}, preamble: "" };

  const sections: Partial<Record<PrBodySectionKey, SectionChunk[]>> = {};
  const preamble: string[] = [];
  let current: PrBodySectionKey | undefined;
  let currentHeading: string | undefined;
  let buffer: string[] = [];
  let fence: { marker: string; length: number } | undefined;

  const flush = () => {
    if (!current || currentHeading === undefined) return;
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    const chunks = (sections[current] ??= []);
    const normalized = normalizeHeading(currentHeading);
    if (chunks.some((chunk) => normalizeHeading(chunk.heading) === normalized)) return;
    chunks.push({ heading: currentHeading, text });
  };

  const push = (line: string) => {
    if (current) buffer.push(line);
    else preamble.push(line);
  };

  for (const line of markdown.split("\n")) {
    const opening = line.match(FENCE_OPEN);

    if (fence) {
      const closing = line.match(FENCE_CLOSE);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = undefined;
      }
      push(line);
      continue;
    }

    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      push(line);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const rawHeading = heading[1].trim();
      const mapped = HEADING_ALIASES[normalizeHeading(rawHeading)];
      if (mapped) {
        flush();
        current = mapped;
        currentHeading = rawHeading;
        continue;
      }
      push(demoteHeading(line));
      continue;
    }
    push(line);
  }
  flush();

  return { sections, preamble: preamble.join("\n").trim() };
}

/**
 * Render one canonical section. When several distinct headings merged into the
 * same section (e.g. `In scope` + `Out of scope`), each chunk keeps its source
 * heading as a bold label so the distinction is not lost.
 */
function renderSection(chunks: SectionChunk[] | undefined): string {
  const meaningful = (chunks ?? []).filter((chunk) => chunk.text.trim());
  if (meaningful.length === 0) return "";
  if (meaningful.length === 1) return meaningful[0].text;
  return meaningful.map((chunk) => `**${chunk.heading}:**\n${chunk.text}`).join("\n\n");
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
  const { sections } = parsePrBody(markdown);
  const result: Partial<Record<PrBodySectionKey, string>> = {};
  for (const key of PR_BODY_SECTION_KEYS) {
    const rendered = renderSection(sections[key]);
    if (rendered) result[key] = rendered;
  }
  return result;
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
  const { sections: parsed, preamble } = parsePrBody(implementationSummary);
  const whatChanged = [preamble, renderSection(parsed["what-changed"])]
    .filter(Boolean)
    .join("\n\n");

  const taskReference = `Task ${taskKey}: ${taskSummary}`.trim();
  const content: Record<PrBodySectionKey, string> = {
    why: [taskReference, renderSection(parsed.why)].filter(Boolean).join("\n\n"),
    "what-changed": whatChanged,
    scope: renderSection(parsed.scope),
    tradeoffs: renderSection(parsed.tradeoffs),
    "blast-radius": renderSection(parsed["blast-radius"]),
    verification: renderSection(parsed.verification),
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
