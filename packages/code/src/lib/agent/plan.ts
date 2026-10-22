import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveOutputDir } from "../config/output-dir";

/**
 * Append a git hook failure record to the per-task hook error log file.
 *
 * @param taskKey - JIRA issue key
 * @param hookType - Hook phase (`commit` or `push`)
 * @param attempt - Retry attempt number
 * @param error - Hook error output
 * @param fixed - Whether the agent subsequently fixed the issue
 */
export function logHookErrorToFile(
  taskKey: string,
  hookType: string,
  attempt: number,
  error: string,
  fixed: boolean,
): void {
  try {
    const baseOutputDir = resolveOutputDir();
    const taskDir = join(baseOutputDir, taskKey.toLowerCase());
    const hookErrorFile = join(taskDir, "git-hook-errors.log");

    const timestamp = new Date().toISOString();
    const status = fixed ? "FIXED" : "FAILED";
    const logEntry = `
${"=".repeat(80)}
Timestamp: ${timestamp}
Hook Type: ${hookType}
Attempt: ${attempt}
Status: ${status}
Error:
${error}
${"=".repeat(80)}
`;

    // Append to log file
    const existingContent = existsSync(hookErrorFile)
      ? readFileSync(hookErrorFile, "utf8")
      : "# Git Hook Errors Log\n\n";

    writeFileSync(hookErrorFile, existingContent + logEntry, "utf8");
    console.log(`💾 Hook error logged to: ${hookErrorFile}`);
  } catch (saveError) {
    console.warn(`⚠️  Failed to save hook error to file: ${saveError}`);
  }
}

/**
 * Extract a plan markdown path mentioned in the agent output.
 *
 * Recognized shapes:
 * - "available at `/path/to/plan.md`"
 * - "saved to: /path/to/plan.md"
 * - `~/.claude/plans/something.md`
 *
 * @param agentOutput - Raw agent stdout
 * @returns Absolute plan path, or `null` when the output names no plan file
 */
function extractPlanFilePath(agentOutput: string): string | null {
  const pathPatterns = [
    /(?:available at|saved to:?)\s*[`"]?((?:\/[^\s`"]+|~\/\.claude\/plans\/[^\s`"]+)\.md)[`"]?/i,
    /[`"]((?:\/home\/[^\s`"]+|~)\/\.claude\/plans\/[^\s`"]+\.md)[`"]/,
    /(\/home\/[^\s]+\/\.claude\/plans\/[^\s]+\.md)/,
  ];

  for (const pattern of pathPatterns) {
    const match = agentOutput.match(pattern);
    if (match && match[1]) {
      const planPath = match[1];
      // Expand ~ to home directory
      return planPath.startsWith("~")
        ? planPath.replace("~", process.env.HOME || "/tmp")
        : planPath;
    }
  }

  return null;
}

/**
 * Detect plan-only agent behavior and extract a plan file path if present.
 *
 * Only explicit plan-creation language or a plan file path counts. A bare
 * mention of "plan" next to "summary" or "implementation" appears in most
 * ordinary completion reports, so it must never suppress delivery on its own.
 * Callers additionally require that `HEAD` did not move during the run.
 *
 * @param agentOutput - Raw agent stdout
 * @returns Plan file path, a sentinel when a plan is claimed without a path, or
 * `null` when implementation appears complete
 */
export function detectPlanOnlyBehavior(agentOutput: string): string | null {
  // Check for common plan creation patterns (specific phrases first)
  const planCreationPatterns = [
    /I'?ve created (a|an|the) (comprehensive )?(implementation )?plan/i,
    /created a plan for/i,
    /plan has been created/i,
    /implementation plan is (now )?ready/i,
    /The plan is (now )?ready/i,
    /plan is ready for (your )?review/i,
    /Here'?s a summary:?\s*\n+##.*plan/i,
    /drafted a plan/i,
    /wrote out a plan/i,
    /plan (file )?(is )?(available|saved)/i,
    /##.*plan.*summary/i,
  ];

  const hasPlanCreationLanguage = planCreationPatterns.some((pattern) => pattern.test(agentOutput));
  const planPath = extractPlanFilePath(agentOutput);

  // A path that is itself a plan file is a plan-only signal even without the
  // explicit phrasing above.
  if (planPath && /plan/i.test(planPath)) {
    return planPath;
  }
  if (!hasPlanCreationLanguage) {
    return null;
  }

  // If we detected plan creation language but couldn't extract the path,
  // return a sentinel value to indicate plan-only behavior
  return planPath ?? "PLAN_DETECTED_NO_PATH";
}

/**
 * Build a follow-up prompt asking the agent to implement an existing plan file.
 *
 * @param planPath - Plan markdown path, or sentinel when path unknown
 * @param originalTaskContent - Original formatted task prompt for context
 */
export function createPlanImplementationPrompt(
  planPath: string | null,
  originalTaskContent: string,
): string {
  const planInstructions =
    planPath && planPath !== "PLAN_DETECTED_NO_PATH"
      ? `You previously created an implementation plan at: ${planPath}

Please read this plan file and implement it NOW. Do not create another plan - actually write the code and make the changes described in the plan.`
      : `You previously created an implementation plan but did not implement it.

Please implement the task NOW. Do not just plan or describe what needs to be done - actually write the code and make the changes.`;

  return `${planInstructions}

IMPORTANT: You MUST actually implement the changes, not just plan them. Create/modify files as needed. Do not exit until actual code changes have been made.

For reference, here is the original task:

${originalTaskContent.trimEnd()}

Now implement the solution. Write the actual code.`;
}
