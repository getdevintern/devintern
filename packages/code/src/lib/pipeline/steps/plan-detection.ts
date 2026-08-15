/**
 * Detection of plan-only agent behavior and the follow-up prompt asking the
 * agent to actually implement its plan. Extracted from src/index.ts.
 */

/**
 * Detect plan-only agent behavior and extract a plan file path if present.
 *
 * @param agentOutput - Raw agent stdout
 * @returns Plan file path, or `null` when implementation appears complete
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

  // Fallback: if "plan" appears with context suggesting plan-only behavior
  // (since this function is only called when there are no changes to commit)
  const hasPlanFallback =
    !hasPlanCreationLanguage &&
    /\bplan\b/i.test(agentOutput) &&
    /summary|review|ready|created|implementation|approach|steps|changes (required|needed)/i.test(
      agentOutput,
    );

  if (!hasPlanCreationLanguage && !hasPlanFallback) {
    return null;
  }

  // Try to extract the plan file path
  // Common patterns:
  // - "available at `/path/to/plan.md`"
  // - "available at /path/to/plan.md"
  // - "saved to: /path/to/plan.md"
  // - ~/.claude/plans/something.md
  const pathPatterns = [
    /(?:available at|saved to:?)\s*[`"]?((?:\/[^\s`"]+|~\/\.claude\/plans\/[^\s`"]+)\.md)[`"]?/i,
    /[`"]((?:\/home\/[^\s`"]+|~)\/\.claude\/plans\/[^\s`"]+\.md)[`"]/,
    /(\/home\/[^\s]+\/\.claude\/plans\/[^\s]+\.md)/,
  ];

  for (const pattern of pathPatterns) {
    const match = agentOutput.match(pattern);
    if (match && match[1]) {
      let planPath = match[1];
      // Expand ~ to home directory
      if (planPath.startsWith("~")) {
        const homeDir = process.env.HOME || "/tmp";
        planPath = planPath.replace("~", homeDir);
      }
      return planPath;
    }
  }

  // If we detected plan creation language but couldn't extract the path,
  // return a sentinel value to indicate plan-only behavior
  return "PLAN_DETECTED_NO_PATH";
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
---
${originalTaskContent}
---

Now implement the solution. Write the actual code.`;
}
