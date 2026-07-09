/**
 * Shared markdown comment bodies for @devintern/code automation.
 *
 * Trackers whose comment format is markdown (or close to it — Trello, Linear,
 * GitHub, Asana) consume these directly; HTML-based trackers (Azure DevOps)
 * convert the markdown before posting. Mirrors the structure of
 * {@link JiraFormatter}'s ADF builders so automation comments read the same
 * across trackers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

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
  return `${header}\n\n${agentOutput.slice(0, MAX_AGENT_OUTPUT_LENGTH)}`;
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

// ---------------------------------------------------------------------------
// Incomplete-description persistence (dedup across runs)
// ---------------------------------------------------------------------------

function incompleteDescriptionFile(taskKey: string): string {
  const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
  const taskDir = path.join(baseOutputDir, taskKey.toLowerCase());
  return path.join(taskDir, "incomplete-task-description.txt");
}

/**
 * Persist the task description alongside an incomplete-implementation comment
 * so a later run can detect it has already reported the same failure.
 */
export function persistIncompleteDescription(taskKey: string, taskDescription: string): void {
  try {
    const descriptionFile = incompleteDescriptionFile(taskKey);
    mkdirSync(path.dirname(descriptionFile), { recursive: true });
    writeFileSync(descriptionFile, taskDescription, "utf8");
  } catch (saveError) {
    console.warn(`⚠️  Failed to save task description for duplicate detection: ${saveError}`);
  }
}

/**
 * True when the previously persisted incomplete description matches
 * `currentDescription` exactly.
 */
export function matchesSavedIncompleteDescription(
  taskKey: string,
  currentDescription: string,
): boolean {
  try {
    const descriptionFile = incompleteDescriptionFile(taskKey);
    if (!existsSync(descriptionFile)) return false;
    return readFileSync(descriptionFile, "utf8") === currentDescription;
  } catch (error) {
    console.warn(`Failed to check for duplicate comments: ${error}`);
    return false;
  }
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
