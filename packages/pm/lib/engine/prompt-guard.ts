/**
 * Prompt-quality guard for the write-spec rubric (DEV-139).
 *
 * Keeps generated tickets falsifiable: Given/When/Then acceptance criteria,
 * negative/edge cases, explicit Non-goals, measurable Success Metrics, and no
 * vague adjectives. Templates are linted in tests so the rubric cannot
 * silently drift; drafts can be linted by callers before publishing.
 *
 * This is a pure lint helper — it never blocks generation.
 */

/**
 * Vague, unmeasurable adjectives a spec must replace with an observable
 * behavior or a number. Matching is case-insensitive and word-bounded, so
 * "breakfast" does not match "fast".
 */
export const VAGUE_TERMS = [
  "fast",
  "quick",
  "slow",
  "intuitive",
  "robust",
  "reliable",
  "user-friendly",
  "seamless",
  "simple",
  "easy",
  "efficient",
  "performant",
  "scalable",
  "modern",
  "clean",
  "nice",
  "better",
  "improved",
  "optimal",
] as const;

export type VagueTerm = (typeof VAGUE_TERMS)[number];

/** Sections every generated story/subtask description must contain. */
export const REQUIRED_DRAFT_SECTIONS = [
  "Acceptance Criteria",
  "Non-goals",
  "Success Metrics",
] as const;

export type DraftSection = (typeof REQUIRED_DRAFT_SECTIONS)[number];

/**
 * Rubric constraints every story/decomposition template must instruct the
 * model to satisfy. `pattern` is matched against the raw template text.
 */
export const REQUIRED_PROMPT_GUIDANCE: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "Given/When/Then acceptance criteria", pattern: /Given\/When\/Then/ },
  { id: "negative and edge cases", pattern: /negative and edge case/i },
  { id: "explicit non-goals", pattern: /Non-goals/ },
  { id: "measurable success metrics", pattern: /Success Metrics/ },
  { id: "vague-word ban", pattern: /\bvague\b/i },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function vagueTermPattern(term: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
}

/**
 * Find vague terms present in a block of generated text.
 *
 * @param text - Draft description or any spec prose.
 * @returns Unique vague terms in {@link VAGUE_TERMS} order.
 */
export function findVagueTerms(text: string): string[] {
  return VAGUE_TERMS.filter((term) => vagueTermPattern(term).test(text));
}

export interface DraftLintResult {
  /** Required sections missing from the description (e.g. `Non-goals`). */
  missingSections: string[];
  /** Vague, unmeasurable terms found in the description. */
  vagueTerms: string[];
  /** True when no sections are missing and no vague terms were found. */
  valid: boolean;
}

/**
 * Lint a generated story/subtask description against the write-spec rubric.
 *
 * @param description - Markdown body of the draft.
 */
export function lintDraftDescription(description: string): DraftLintResult {
  const missingSections = REQUIRED_DRAFT_SECTIONS.filter(
    (section) => !description.includes(section),
  );
  const vagueTerms = findVagueTerms(description);
  return {
    missingSections,
    vagueTerms,
    valid: missingSections.length === 0 && vagueTerms.length === 0,
  };
}

export interface PromptTemplateLintResult {
  /** Human-readable rubric constraints the template does not require. */
  missingGuidance: string[];
  valid: boolean;
}

/**
 * Lint a prompt template for the write-spec rubric instructions.
 *
 * @param template - Raw prompt template text (placeholders included).
 */
export function lintPromptTemplate(template: string): PromptTemplateLintResult {
  const missingGuidance = REQUIRED_PROMPT_GUIDANCE.filter(
    (rule) => !rule.pattern.test(template),
  ).map((rule) => rule.id);
  return { missingGuidance, valid: missingGuidance.length === 0 };
}
