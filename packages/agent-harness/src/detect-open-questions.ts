/**
 * Detect when the agent ended its run by asking the user questions instead of
 * (or before) implementing.
 *
 * Agents sometimes stop mid-task to ask for a product or design decision
 * ("How should I proceed?", "Which option do you prefer?", a numbered list of
 * choices). Committing or opening a PR in that state ships an answer nobody
 * gave, so callers should skip the git flow and surface the questions instead.
 *
 * Only the tail of the output is inspected: questions early in a long run are
 * usually rhetorical or already answered by the agent itself; a run that is
 * genuinely blocked ends on the questions.
 */

/** How much of the end of stdout to inspect. */
const TAIL_CHARS = 4000;

/** Cap on extracted question lines returned to the caller. */
const MAX_QUESTIONS = 10;

/**
 * Phrasings that ask the user for a decision. These are checked against the
 * tail with code blocks removed.
 */
const DECISION_PATTERNS = [
  /\bhow (?:should|do you want|would you like) (?:I|me|we|us)\b/i,
  /\bshould (?:I|we)\b[^.?!\n]*\?/i,
  /\bwhich (?:option|approach|one|of these|direction|path|way|model|provider)\b[^.?!\n]*\?/i,
  /\b(?:do|would) you (?:want|prefer|like)\b[^.?!\n]*\?/i,
  /\bwhat (?:would|do) you (?:like|want|prefer)\b[^.?!\n]*\?/i,
  /\bplease (?:confirm|clarify|advise|choose|pick|decide)\b/i,
  /\bawaiting (?:your|the user'?s?) (?:input|decision|confirmation|response|answer)\b/i,
  /\bneeds? (?:a|your) (?:product )?(?:decision|call|input|confirmation|answer|sign-?off)\b/i,
  /\bbefore I (?:proceed|continue|implement|wire|start|commit)\b/i,
  /\byour call\b/i,
  /\blet me know (?:which|how|whether)\b/i,
] as const;

/**
 * Question lines that are post-completion offers, not blockers
 * ("Let me know if you'd like me to also update the docs?").
 */
const OFFER_PATTERNS = [/^let me know if\b/i, /^feel free\b/i, /^(?:want|need) me to\b/i] as const;

export interface OpenQuestionsResult {
  /** True when the agent appears blocked on user input. */
  awaitingInput: boolean;
  /** Question lines extracted from the tail of the output (for display). */
  questions: string[];
}

/** Strip fenced code blocks so questions inside code samples don't count. */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, "");
}

/** Strip markdown emphasis/heading noise around a line for matching and display. */
function cleanLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/[*_`]+$/, "")
    .trim();
}

/**
 * Detect whether agent stdout ends with open questions directed at the user.
 *
 * @param stdout - Captured standard output of the agent run
 */
export function detectOpenQuestions(stdout: string): OpenQuestionsResult {
  const tail = stripCodeBlocks(stdout.slice(-TAIL_CHARS));

  const questions: string[] = [];
  let listQuestionCount = 0;

  for (const rawLine of tail.split("\n")) {
    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(rawLine);
    const line = cleanLine(rawLine);
    if (!line.endsWith("?")) {
      continue;
    }
    if (OFFER_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    if (questions.length < MAX_QUESTIONS) {
      questions.push(line);
    }
    if (isListItem) {
      listQuestionCount++;
    }
  }

  const hasDecisionLanguage = DECISION_PATTERNS.some((pattern) => pattern.test(tail));

  // Blocked when the tail explicitly asks for a decision, or presents a list
  // of choices phrased as questions (two or more list items ending in "?").
  const awaitingInput = (hasDecisionLanguage && questions.length > 0) || listQuestionCount >= 2;

  return { awaitingInput, questions };
}
