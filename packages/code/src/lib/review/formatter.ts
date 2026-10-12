/**
 * Review Formatter
 *
 * Formats PR review feedback into structured prompts for Agent.
 */

import type { ProcessedReviewComment, ProcessedReviewFeedback } from "../../types/github-webhooks";
import { untrustedContentBlock, untrustedInline } from "../prompt/untrusted-content";

/**
 * Format structured PR review feedback into an agent prompt.
 *
 * @param feedback - Processed review metadata and comments
 * @returns Markdown prompt for the agent harness
 */
export function formatReviewPrompt(feedback: ProcessedReviewFeedback): string {
  const lines: string[] = [];

  // Header
  lines.push("# PR Review Feedback - Address Required Changes");
  lines.push("");

  // PR Information
  lines.push("## PR Information");
  lines.push("");
  lines.push(`- **Repository:** ${untrustedInline(feedback.repository, "repository")}`);
  lines.push(`- **PR #${feedback.prNumber}:**`);
  lines.push(untrustedContentBlock(feedback.prTitle, "pull request title"));
  lines.push(`- **Branch:** ${untrustedInline(feedback.branch, "branch")}`);
  lines.push(`- **Reviewer:** @${untrustedInline(feedback.reviewer, "reviewer")}`);
  lines.push(`- **Review Status:** ${formatReviewState(feedback.reviewState)}`);
  lines.push("");

  // Overall review comment (if any)
  if (feedback.reviewBody && feedback.reviewBody.trim()) {
    lines.push("## Overall Review Comment");
    lines.push("");
    lines.push(untrustedContentBlock(feedback.reviewBody.trim(), "overall review comment"));
    lines.push("");
  }

  // Individual file comments
  if (feedback.comments.length > 0) {
    lines.push("## File-Specific Feedback");
    lines.push("");

    // Group comments by file
    const commentsByFile = groupCommentsByFile(feedback.comments);

    for (const [filePath, fileComments] of Object.entries(commentsByFile)) {
      lines.push(`### ${untrustedInline(filePath, "file path")}`);
      lines.push("");

      for (const comment of fileComments) {
        lines.push(formatSingleComment(comment));
        lines.push("");
      }
    }
  }

  // Conversation comments
  if (feedback.conversationComments && feedback.conversationComments.length > 0) {
    lines.push("## General Conversation Feedback");
    lines.push("");
    lines.push("The reviewer also provided these general comments in the conversation:");
    lines.push("");

    for (const comment of feedback.conversationComments) {
      lines.push(untrustedContentBlock(quoteBody(comment.body), "review conversation comment"));
      lines.push("");
    }
  }

  // Instructions
  lines.push("## Instructions");
  lines.push("");
  lines.push("Please address each piece of feedback above by making the necessary code changes.");
  lines.push("");
  lines.push("**Guidelines:**");
  lines.push("1. Address each comment systematically, starting from the first file");
  lines.push("2. Make minimal, focused changes that directly address the feedback");
  lines.push("3. If a suggestion is unclear or you disagree, explain your reasoning");
  lines.push("4. Ensure your changes don't break existing functionality");
  lines.push("5. Run any relevant tests to verify your changes");
  lines.push("");
  lines.push("**IMPORTANT:**");
  lines.push("- After making your changes, commit them with a descriptive message");
  lines.push(
    "- Your commit message should summarize what changes you made to address the feedback",
  );
  lines.push("- Do NOT push to the remote - that will be done automatically");

  return lines.join("\n");
}

/**
 * Map a review state enum to human-readable label text.
 *
 * @param state - GitHub review state
 */
function formatReviewState(state: ProcessedReviewFeedback["reviewState"]): string {
  switch (state) {
    case "approved":
      return "✅ Approved";
    case "changes_requested":
      return "🔄 Changes Requested";
    case "commented":
      return "💬 Commented";
    case "dismissed":
      return "❌ Dismissed";
    case "pending":
      return "⏳ Pending";
    default:
      return state;
  }
}

/**
 * Group review comments by file path, sorted by line within each file.
 *
 * @param comments - Processed review comments
 */
function groupCommentsByFile(
  comments: ProcessedReviewComment[],
): Record<string, ProcessedReviewComment[]> {
  const grouped: Record<string, ProcessedReviewComment[]> = {};

  for (const comment of comments) {
    if (!grouped[comment.path]) {
      grouped[comment.path] = [];
    }
    grouped[comment.path].push(comment);
  }

  // Sort comments within each file by line number
  for (const filePath of Object.keys(grouped)) {
    grouped[filePath].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  }

  return grouped;
}

/**
 * Render a single review comment with diff context and quoted body.
 *
 * @param comment - Processed review comment
 */
function formatSingleComment(comment: ProcessedReviewComment): string {
  const lines: string[] = [];

  // Line reference
  const lineRef = comment.line ? `Line ${comment.line}` : "General";
  lines.push(`**${lineRef}** (by @${untrustedInline(comment.reviewer, "reviewer")}):`);
  lines.push("");

  const external: string[] = [];

  // Diff context (code block)
  if (comment.diffHunk) {
    const language = detectLanguage(comment.path);
    external.push("```" + language);
    external.push(comment.diffHunk);
    external.push("```");
    external.push("");
  }

  // The actual feedback
  external.push(quoteBody(comment.body));

  lines.push(untrustedContentBlock(external.join("\n"), "review comment"));

  return lines.join("\n");
}

/**
 * Render multi-line text as a markdown blockquote.
 *
 * @param body - Raw text to quote
 */
function quoteBody(body: string): string {
  return `> ${body.split("\n").join("\n> ")}`;
}

/**
 * Infer a syntax-highlighting language id from a file path extension.
 *
 * @param filePath - Path to the commented file
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    md: "markdown",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    vue: "vue",
    svelte: "svelte",
  };

  return languageMap[ext || ""] || "diff";
}

/**
 * Build a short reply message after addressing (or deferring) a comment.
 *
 * @param comment - Review comment being replied to
 * @param wasAddressed - Whether the feedback was fixed in the latest commit
 */
export function formatReplyMessage(comment: ProcessedReviewComment, wasAddressed: boolean): string {
  if (wasAddressed) {
    return `✅ Addressed this feedback in the latest commit.`;
  }
  return `⏳ Noted - will address this in a follow-up.`;
}

/**
 * Extract a concise summary section from agent stdout for GitHub replies.
 *
 * @param output - Raw agent output (may include ANSI codes)
 * @returns Truncated summary text (max 500 chars)
 */
export function extractAgentSummary(output: string): string {
  const MAX_LENGTH = 500;

  // Remove ANSI color codes
  const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");

  // Helper to truncate if needed
  const truncate = (text: string): string => {
    return text.length > MAX_LENGTH ? text.substring(0, MAX_LENGTH) + "..." : text;
  };

  // Try to find a "Summary" section (## Summary or ## summary)
  const summaryMatch = cleanOutput.match(/##\s*Summary\s*\n+([\s\S]*?)(?=\n##|\n---|z)/i);
  if (summaryMatch && summaryMatch[1].trim()) {
    return truncate(summaryMatch[1].trim());
  }

  // Try to find "Changes Made" section (### Changes Made:)
  const changesMatch = cleanOutput.match(
    /###\s*Changes Made:?\s*\n+([\s\S]*?)(?=\n###|\n##|\n---|z)/i,
  );
  if (changesMatch && changesMatch[1].trim()) {
    const text = `**Changes Made:**\n${changesMatch[1].trim()}`;
    return truncate(text);
  }

  // Look for a paragraph after "Perfect!" or "I've successfully"
  const successMatch = cleanOutput.match(
    /(?:Perfect!|I've successfully[^\n]*)\s*\n+([\s\S]*?)(?=\n##|\n###|z)/,
  );
  if (successMatch && successMatch[1].trim()) {
    return truncate(successMatch[1].trim());
  }

  // Fallback: return a generic message
  return "Addressed review feedback by implementing the requested changes.";
}

/**
 * Build a minimal agent prompt for addressing one review comment.
 *
 * @param comment - Single processed review comment
 * @param repository - GitHub repository slug
 * @param branch - PR head branch name
 */
export function formatSingleCommentPrompt(
  comment: ProcessedReviewComment,
  repository: string,
  branch: string,
): string {
  const lines: string[] = [];

  lines.push("# Address Single PR Review Comment");
  lines.push("");
  lines.push(`**Repository:** ${untrustedInline(repository, "repository")}`);
  lines.push(`**Branch:** ${untrustedInline(branch, "branch")}`);
  lines.push(`**File:** ${untrustedInline(comment.path, "file path")}`);
  if (comment.line) {
    lines.push(`**Line:** ${comment.line}`);
  }
  lines.push("");
  lines.push("## Code Context");
  lines.push("");

  if (comment.diffHunk) {
    const language = detectLanguage(comment.path);
    lines.push(
      untrustedContentBlock(`\`\`\`${language}\n${comment.diffHunk}\n\`\`\``, "code under review"),
    );
    lines.push("");
  }

  lines.push("## Reviewer Feedback");
  lines.push("");
  lines.push(untrustedContentBlock(quoteBody(comment.body), "review comment"));
  lines.push("");
  lines.push("## Instructions");
  lines.push("");
  lines.push("1. Make the minimal change needed to address this feedback");
  lines.push("2. Stage your changes with `git add .`");
  lines.push("3. Commit with message: `fix: address PR review feedback`");

  return lines.join("\n");
}

/** Structured CI-failure feedback handed to {@link formatCiFixPrompt}. */
export interface CiFailureFeedback {
  repository: string;
  prNumber: number;
  prTitle?: string;
  branch?: string;
  failures: Array<{
    name: string;
    conclusion: string | null;
    detailsUrl?: string;
  }>;
  /** Failure-relevant excerpt, or null when GitHub did not expose logs. */
  logs: string | null;
}

/** Format failing CI metadata and logs into an implementation prompt. */
export function formatCiFixPrompt(feedback: CiFailureFeedback): string {
  const lines = [
    "# CI Failure - Fix Failing Checks",
    "",
    "## PR Information",
    "",
    `- **Repository:** ${untrustedInline(feedback.repository, "repository")}`,
    `- **PR #${feedback.prNumber}**`,
  ];
  if (feedback.prTitle) {
    lines.push(untrustedContentBlock(feedback.prTitle, "pull request title"));
  }
  if (feedback.branch) lines.push(`- **Branch:** ${untrustedInline(feedback.branch, "branch")}`);
  lines.push("", "## Failing Checks", "");
  const checkLines = feedback.failures.map((failure) => {
    const details = failure.detailsUrl ? ` (${failure.detailsUrl})` : "";
    return `- **${failure.name}** — \`${failure.conclusion ?? "unknown"}\`${details}`;
  });
  if (checkLines.length > 0) {
    lines.push(untrustedContentBlock(checkLines.join("\n"), "failing ci checks"));
  }
  lines.push("");
  if (feedback.logs?.trim()) {
    lines.push(
      "## Failure Logs (excerpt)",
      "",
      untrustedContentBlock(`\`\`\`\n${feedback.logs.trimEnd()}\n\`\`\``, "ci logs"),
      "",
    );
  } else {
    lines.push(
      "## Failure Logs",
      "",
      "> Job logs were not available. Reproduce the failures locally by running",
      "> the project's test/lint/build pipeline for the affected checks.",
      "",
    );
  }
  lines.push(
    "## Instructions",
    "",
    "Fix the code so every failing check above passes without regressing the rest of the suite.",
    "",
    "**Guidelines:**",
    "1. Identify the root cause from the log excerpt before editing",
    "2. Make minimal, focused changes that fix the failure",
    "3. Treat flaky infrastructure as such instead of masking it",
    "4. Run the relevant tests to verify the fix",
    "",
    "**IMPORTANT:**",
    "- Commit the changes with a descriptive message",
    "- Do NOT push to the remote - that will be done automatically",
  );
  return lines.join("\n");
}
