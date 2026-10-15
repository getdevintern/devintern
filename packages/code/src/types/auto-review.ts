/**
 * Types for automatic PR review feedback loop
 */

export type ReviewPriority = "critical" | "high" | "medium" | "low" | "info";

/**
 * How far a finding's safety fact was proven up the evidence ladder.
 *
 * `high` requires the claim to have been run, `medium` to have been pointed at
 * or shown impossible, and `low` covers assertions and unproven claims.
 *
 * Validation only enforces the ladder's floor: `high`/`medium` are downgraded
 * to `low` when `evidence` is missing or is a named non-concrete marker. The
 * `high`-vs-`medium` split is advisory, since a free-form evidence string
 * cannot be verified.
 */
export type ReviewConfidence = "high" | "medium" | "low";

export type ReviewCategory =
  | "code-quality"
  | "bug"
  | "performance"
  | "security"
  | "testing"
  | "documentation"
  | "style";

export interface ReviewFeedbackItem {
  /** Priority level of the feedback */
  priority: ReviewPriority;

  /** Category of the feedback */
  category: ReviewCategory;

  /** File path relative to repository root */
  file?: string;

  /** Line number or range (e.g., "42" or "42-45") */
  line?: string;

  /** Description of the issue */
  issue: string;

  /**
   * How far the finding's safety fact was proven. Findings without evidence
   * are reported with `low` rather than dropped.
   */
  confidence?: ReviewConfidence;

  /**
   * Backing for the finding: a runnable check and its result, a real
   * `file:line`, or the literal `"unproven"`.
   */
  evidence?: string;

  /** Suggested fix or improvement */
  suggestion: string;
}

export interface ReviewFeedback {
  /** Overall summary of the review */
  summary: string;

  /** List of feedback items */
  items: ReviewFeedbackItem[];

  /** Whether the PR is approved (all issues are info/low priority) */
  approved: boolean;
}

export interface AutoReviewLoopOptions {
  /** GitHub repository (e.g., "owner/repo") */
  repository: string;

  /** PR number */
  prNumber: number;

  /** PR branch name (head branch) */
  prBranch: string;

  /** PR base/target branch (e.g., "main", "develop") */
  baseBranch: string;

  /** Agent harness to use for review */
  harness: import("@devintern/agent-harness").AgentHarness;
  /** Path to the agent CLI executable */
  executablePath: string;

  /** Maximum number of review iterations */
  maxIterations?: number;

  /** Minimum priority to address (default: medium) */
  minPriority?: ReviewPriority;

  /** Working directory for the repository */
  workingDir: string;

  /** Output directory for logs and artifacts */
  outputDir: string;

  /**
   * Skip pushing after each iteration.
   * When true, changes are committed but not pushed during auto-review.
   * Useful when running local hook validation before a single final push.
   */
  skipPush?: boolean;
  /** Capture freshly written outputs before a later iteration can overwrite them. */
  onArtifact?: (artifact: import("../lib/artifacts/types").ArtifactInput) => Promise<void>;
}

export interface AutoReviewLoopResult {
  /** Number of iterations performed */
  iterations: number;

  /** Whether all critical/high/medium issues were addressed */
  success: boolean;

  /** Final review feedback */
  finalFeedback: ReviewFeedback;

  /** History of all review iterations */
  history: Array<{
    iteration: number;
    feedback: ReviewFeedback;
    addressed: ReviewFeedbackItem[];
  }>;
}
