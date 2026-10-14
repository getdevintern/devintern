import type { ReviewFeedback, ReviewFeedbackItem } from "../../types/auto-review";

const PRIORITIES = new Set(["critical", "high", "medium", "low", "info"]);
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

/** Reject malformed agent verdicts before priority filtering can discard findings. */
export function validateReviewFeedback(value: unknown): asserts value is ReviewFeedback {
  if (!value || typeof value !== "object") throw new Error("Invalid feedback structure");
  const feedback = value as Partial<ReviewFeedback>;
  if (
    typeof feedback.summary !== "string" ||
    !feedback.summary.trim() ||
    typeof feedback.approved !== "boolean" ||
    !Array.isArray(feedback.items) ||
    !feedback.items.every(isFinding)
  ) {
    throw new Error("Invalid feedback structure");
  }
  if (
    feedback.approved &&
    feedback.items.some(
      (item) =>
        item.priority === "critical" || item.priority === "high" || item.priority === "medium",
    )
  ) {
    throw new Error("Review cannot approve unresolved medium-or-higher findings");
  }
}
