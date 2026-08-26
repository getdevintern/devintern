/**
 * Shared markdown comment bodies for @devintern/code automation.
 *
 * Trackers whose comment format is markdown (or close to it — Trello, Linear,
 * GitHub, Asana) consume these directly; HTML-based trackers (Azure DevOps)
 * convert the markdown before posting. Mirrors the structure of
 * {@link JiraFormatter}'s ADF builders so automation comments read the same
 * across trackers.
 */

/** Marker strings identifying comments posted by @devintern/code automation. */
export const DEVINTERN_MARKERS = [
  "Implementation Completed by @devintern/code",
  "Automated Task Feasibility Assessment",
  "Implementation Incomplete",
  "Automated Story Points Estimation",
];

/** Marker identifying an automated estimation comment (find/update flows). */
export const ESTIMATION_COMMENT_MARKER = "Automated Story Points Estimation";

/** True when `text` contains any @devintern/code automation marker. */
export function isDevInternCommentText(text: string): boolean {
  return DEVINTERN_MARKERS.some((marker) => text.includes(marker));
}

export interface ClarityAssessmentLike {
  isImplementable: boolean;
  clarityScore: number;
  summary: string;
  issues: Array<{
    category: string;
    description: string;
    severity: "critical" | "major" | "minor" | string;
  }>;
  recommendations: string[];
}

export interface EstimationResultLike {
  storyPoints: number;
  confidence: "high" | "medium" | "low";
  implementationConfidence?: number;
  reasoning: string;
  risks: string[];
  unclearAreas: string[];
  summary: string;
}

/** Maximum agent output length embedded in a tracker comment. */
const MAX_AGENT_OUTPUT_LENGTH = 8000;

/**
 * How to unlock another worker/cron pickup after a failed or incomplete run.
 * The retry gate skips an unchanged ticket; any of these bumps the update
 * stamp (and, for incomplete runs, satisfies the gate).
 */
export const RETRY_PICKUP_HEADING = "To retry this task";
export const RETRY_PICKUP_BODY =
  "This ticket will not be picked up again until it changes. " +
  "Edit the description, post a comment (a one-line clarification is enough), or delete this comment.";

/** Markdown "how to retry" block posted on failure / incomplete comments. */
export function formatRetryPickupMarkdown(): string {
  return `**${RETRY_PICKUP_HEADING}:** ${RETRY_PICKUP_BODY}`;
}

/**
 * Format a clarity/feasibility assessment as markdown.
 *
 * Mirrors the structure of {@link JiraFormatter.createClarityAssessmentADF}.
 */
export function formatClarityAssessmentMarkdown(assessment: ClarityAssessmentLike): string {
  const lines: string[] = [
    "### 🤖 Automated Task Feasibility Assessment",
    "",
    `**Clarity Score:** ${assessment.clarityScore}/10`,
    "",
    assessment.isImplementable
      ? "**Status:** ✅ Ready for implementation"
      : "**Status:** ❌ Needs fundamental clarification",
    "",
    `**Summary:** ${assessment.summary}`,
    "",
  ];

  if (assessment.issues.length > 0) {
    lines.push("**Critical Issues Identified:**", "");
    for (const issue of assessment.issues) {
      const severityEmoji =
        issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🔵";
      lines.push(`- ${severityEmoji} **${issue.category}:** ${issue.description}`);
    }
    lines.push("");
  }

  if (assessment.recommendations.length > 0) {
    lines.push("**Recommendations:**", "");
    assessment.recommendations.forEach((rec, index) => {
      lines.push(`${index + 1}. ${rec}`);
    });
    lines.push("");
  }

  if (assessment.isImplementable && assessment.clarityScore >= 7) {
    lines.push(
      "> **🎯 Excellent!** This task description provides clear requirements and context for implementation.",
      "",
    );
  } else if (assessment.isImplementable) {
    lines.push(
      "> *💡 This task is implementable, but could benefit from additional details for even clearer requirements.*",
      "",
    );
  }

  lines.push(
    "> *This assessment focuses on basic implementability. Technical details, UI/UX patterns, and implementation specifics are expected to be inferred from existing codebase.*",
  );

  if (!assessment.isImplementable) {
    lines.push("", formatRetryPickupMarkdown());
  }

  return lines.join("\n");
}

/** Format the implementation-success comment body. */
export function formatImplementationCommentMarkdown(
  agentOutput: string,
  taskSummary?: string,
): string {
  const header = taskSummary
    ? `Implementation Completed by @devintern/code\nTask: ${taskSummary}`
    : "Implementation Completed by @devintern/code";
  return `${header}\n\n${agentOutput.slice(0, MAX_AGENT_OUTPUT_LENGTH)}`;
}

/** Format the incomplete-implementation comment body. */
export function formatIncompleteImplementationCommentMarkdown(
  agentOutput: string,
  taskSummary?: string,
): string {
  const header = taskSummary
    ? `⚠️ Implementation Incomplete\nTask: ${taskSummary}`
    : "⚠️ Implementation Incomplete";
  return `${header}\n\n${agentOutput.slice(0, MAX_AGENT_OUTPUT_LENGTH)}\n\n${formatRetryPickupMarkdown()}`;
}

/** Format the crash / interrupt / usage-limit failure comment body. */
export function formatProcessingFailureMarkdown(taskKey: string, reason: string): string {
  return (
    `🤖 **Automated implementation did not complete** — no pull request was created for this attempt.\n\n` +
    `**Reason:** ${reason}\n\n` +
    `Partial work from this attempt may exist on the \`feature/${taskKey.toLowerCase()}\` branch or in a git stash.\n\n` +
    formatRetryPickupMarkdown()
  );
}

/** Format the assessment-failure comment body. */
export function formatAssessmentFailureMarkdown(failureType: "max-turns" | "parse-error"): string {
  const reason =
    failureType === "max-turns"
      ? "the agent reached its maximum turn limit"
      : "the agent output could not be parsed";
  return `Automated Task Feasibility Assessment\n\n⚠️ Assessment failed: ${reason}.`;
}

/**
 * Format a story-points estimation comment as markdown.
 *
 * Mirrors the structure of {@link JiraClient.buildEstimationCommentADF}.
 */
export function formatEstimationCommentMarkdown(result: EstimationResultLike): string {
  const confidenceEmoji =
    result.confidence === "high" ? "🟢" : result.confidence === "medium" ? "🟡" : "🔴";

  const lines: string[] = [
    "### 🤖 Automated Story Points Estimation",
    "",
    `**Story Points:** ${result.storyPoints}  |  **Confidence:** ${confidenceEmoji} ${result.confidence}`,
    "",
  ];

  if (typeof result.implementationConfidence === "number") {
    const score = result.implementationConfidence;
    const filled = "🟩".repeat(score);
    const empty = "⬜".repeat(10 - score);
    const label =
      score >= 9
        ? "Almost certain"
        : score >= 7
          ? "High chance"
          : score >= 5
            ? "May need guidance"
            : score >= 3
              ? "Significant ambiguity"
              : "Needs human judgment";
    lines.push(`**AI Implementation Confidence:** ${filled}${empty} ${score}/10 — ${label}`, "");
  }

  lines.push("#### Reasoning", "", result.reasoning, "");

  if (result.risks.length > 0) {
    lines.push("#### Risks", "");
    for (const risk of result.risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  if (result.unclearAreas.length > 0) {
    lines.push("#### Unclear Areas", "");
    for (const area of result.unclearAreas) {
      lines.push(`- ${area}`);
    }
    lines.push("");
  }

  if (result.confidence === "low") {
    lines.push(
      "> ⚠️ **Low confidence estimate** — Please provide more details on the task scope and requirements for a more accurate estimate.",
    );
  }

  return lines.join("\n").trimEnd();
}

/** Markers indicating an incomplete-implementation comment already exists. */
export const INCOMPLETE_IMPLEMENTATION_MARKERS = [
  "⚠️ Implementation Incomplete",
  "Implementation Incomplete",
  "Implementation was incomplete",
];

/** True when `text` looks like a previously posted incomplete-implementation comment. */
export function isIncompleteImplementationCommentText(text: string): boolean {
  return INCOMPLETE_IMPLEMENTATION_MARKERS.some((marker) => text.includes(marker));
}
