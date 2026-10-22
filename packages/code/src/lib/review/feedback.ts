import type { ReviewFeedback, ReviewFeedbackItem, ReviewPriority } from "../../types/auto-review";

const PRIORITIES = new Set(["critical", "high", "medium", "low", "info"]);

/** Relative weight per priority, for threshold comparisons. */
export const PRIORITY_WEIGHTS: Record<ReviewPriority, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
const CONFIDENCES = new Set(["high", "medium", "low"]);
const CATEGORIES = new Set([
  "code-quality",
  "bug",
  "performance",
  "security",
  "testing",
  "documentation",
  "style",
]);

/**
 * Named points on the evidence ladder below its concrete floor, as defined by
 * the review prompt: `asserted` is explicitly worthless and `unproven` is the
 * failure to prove a claim. The loose `none`/`n/a` spellings mean the same
 * thing in practice (no evidence was supplied), so they are treated alike.
 */
const NON_CONCRETE_EVIDENCE = new Set(["asserted", "unproven", "none", "n/a", "na"]);

/**
 * Whether `evidence` clears the ladder's concrete floor: a non-empty string
 * that is not one of the named non-concrete markers above.
 *
 * This only proves that *some* backing was supplied. Because `evidence` is a
 * free-form string, the rung above the floor cannot be verified here:
 * `high` requires `ran-it` while `medium` allows `pointed`/`cant-happen`, and
 * nothing distinguishes a pasted command from a `file:line` citation. The
 * high-vs-medium distinction is therefore advisory.
 */
function isConcreteEvidence(evidence: unknown): boolean {
  return (
    typeof evidence === "string" &&
    evidence.trim().length > 0 &&
    !NON_CONCRETE_EVIDENCE.has(evidence.trim().toLowerCase())
  );
}

function isFinding(value: unknown): value is ReviewFeedbackItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReviewFeedbackItem>;
  return (
    typeof item.priority === "string" &&
    PRIORITIES.has(item.priority) &&
    typeof item.category === "string" &&
    CATEGORIES.has(item.category) &&
    typeof item.issue === "string" &&
    item.issue.trim().length > 0 &&
    typeof item.suggestion === "string" &&
    item.suggestion.trim().length > 0 &&
    (item.file === undefined || typeof item.file === "string") &&
    (item.line === undefined || typeof item.line === "string") &&
    (item.confidence === undefined ||
      (typeof item.confidence === "string" && CONFIDENCES.has(item.confidence))) &&
    (item.evidence === undefined || typeof item.evidence === "string")
  );
}

/**
 * Enforce the evidence ladder's floor by coercion, not rejection: a finding
 * that claims `high`/`medium` confidence without concrete evidence (a named
 * non-concrete marker such as `asserted` or `unproven`, an empty string, or no
 * evidence at all) is normalized to `low` so it is reported rather than
 * dropped. The high-vs-medium rung is left advisory because free-form evidence
 * cannot be checked. Unknown confidence values stay a genuine schema error and
 * are left untouched for `isFinding` to reject.
 */
function applyEvidenceLadder(items: unknown[]): void {
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as ReviewFeedbackItem;
    if (
      (item.confidence === "high" || item.confidence === "medium") &&
      !isConcreteEvidence(item.evidence)
    ) {
      item.confidence = "low";
    }
  }
}

/** Reject verdicts that do not match the review schema, coercing confidence. */
export function validateReviewFeedbackStructure(value: unknown): asserts value is ReviewFeedback {
  if (!value || typeof value !== "object") throw new Error("Invalid feedback structure");
  const feedback = value as Partial<ReviewFeedback>;
  if (
    typeof feedback.summary !== "string" ||
    !feedback.summary.trim() ||
    typeof feedback.approved !== "boolean" ||
    !Array.isArray(feedback.items)
  ) {
    throw new Error("Invalid feedback structure");
  }
  applyEvidenceLadder(feedback.items);
  if (!feedback.items.every(isFinding)) {
    throw new Error("Invalid feedback structure");
  }
}

/** Reject malformed agent verdicts before priority filtering can discard findings. */
export function validateReviewFeedback(
  value: unknown,
  minPriority: ReviewPriority = "medium",
): asserts value is ReviewFeedback {
  validateReviewFeedbackStructure(value);
  // "Approved" means nothing above the caller's blocking threshold is left
  // unresolved — not that the review found no notes at all. Verification
  // defaults to `high`, so its medium findings are advisory and must not
  // invalidate an approval; the auto-review loop keeps the `medium` default.
  const threshold = PRIORITY_WEIGHTS[minPriority];
  if (value.approved && value.items.some((item) => PRIORITY_WEIGHTS[item.priority] >= threshold)) {
    throw new Error(`Review cannot approve unresolved ${minPriority}-or-higher findings`);
  }
}
