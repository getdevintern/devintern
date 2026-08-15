/**
 * The `verify` step: an agent-backed functional-requirements verifier and
 * the primary declarative extension point of the pipeline.
 *
 * Shape: build prompt (task + committed diff) -> run agent -> parse a
 * structured JSON verdict (the `ReviewFeedback` contract) -> decide.
 *
 * Failure model (two channels):
 * - Execution errors (agent crashed, diff unavailable, unparseable JSON)
 *   throw {@link StepExecutionError}; the runner retries the step.
 * - Verdict failures (requirements genuinely not met) return `onFail`:
 *   `"loopback"` (default) re-runs `implement` with the findings (bounded by
 *   `maxIterations`), `"halt"` stops and marks the task incomplete,
 *   `"warn"` records a warning and continues.
 *
 * Users can register any number of verify instances in `pipeline.steps` with
 * different `prompt` / `onFail` / `minSeverity` settings - no code required.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import {
  filterByPriority,
  getPRDiff,
  parseReviewFeedback,
  runAgentPrompt,
} from "../../auto-review-loop";
import type { ReviewFeedback, ReviewPriority } from "../../../types/auto-review";
import { StepExecutionError, StepStatus } from "../types";
import type { PipelineStep, StepDefinition, StepResult, TaskContext } from "../types";

export interface VerifyStepConfig {
  /**
   * Custom verification instructions: either an inline string or a path to a
   * prompt file (relative paths resolve against the working directory). The
   * task content, diff, and JSON verdict format are always appended.
   */
  prompt?: string;
  /** What to do on a failed verdict (default "loopback"). */
  onFail?: "loopback" | "halt" | "warn";
  /** Loopback bound when `onFail` is "loopback" (default 3). */
  maxIterations?: number;
  /** Findings at or above this priority fail the verdict (default "high"). */
  minSeverity?: ReviewPriority;
}

/** Injectable dependencies (for tests - no subprocess required). */
export interface VerifyStepDeps {
  runAgentPrompt: typeof runAgentPrompt;
  getPRDiff: typeof getPRDiff;
}

const DEFAULT_INSTRUCTIONS = `You are verifying whether an implementation satisfies the functional requirements of a task. Analyze the task description and the code diff, then judge whether the requirements are actually met.

Focus on:
1. **Functional completeness**: Does the diff implement everything the task asks for?
2. **Correctness**: Does the implementation do what the requirements describe (not just compile)?
3. **Acceptance criteria**: Are all stated acceptance criteria satisfied?
4. **Regressions**: Does the change appear to break existing behavior the task did not ask to change?`;

export class VerifyStep implements PipelineStep {
  readonly name = "verify";

  constructor(
    private readonly config: VerifyStepConfig = {},
    private readonly deps: VerifyStepDeps = { runAgentPrompt, getPRDiff },
  ) {}

  async run(ctx: TaskContext): Promise<StepResult> {
    if (!ctx.enableGit) {
      return {
        status: StepStatus.WarnContinue,
        reason: "verify skipped: git workflow disabled, no committed diff to verify",
      };
    }

    const minSeverity = this.config.minSeverity ?? "high";
    const onFail = this.config.onFail ?? "loopback";
    const maxIterations = this.config.maxIterations ?? 3;

    console.log("\n🔎 Verifying implementation against task requirements...");

    let diff: string;
    try {
      diff = this.deps.getPRDiff(ctx.prTargetBranch, ctx.workingDir);
    } catch (diffError) {
      throw new StepExecutionError(
        `verify: failed to get diff against '${ctx.prTargetBranch}': ${(diffError as Error).message}`,
        diffError,
      );
    }

    const prompt = this.buildPrompt(ctx, diff);

    let agentOutput: string;
    try {
      agentOutput = await this.deps.runAgentPrompt(
        prompt,
        ctx.workingDir,
        ctx.harness,
        ctx.executablePath,
      );
    } catch (agentError) {
      throw new StepExecutionError(
        `verify: agent run failed: ${(agentError as Error).message}`,
        agentError,
      );
    }

    let feedback: ReviewFeedback;
    try {
      feedback = parseReviewFeedback(agentOutput);
    } catch (parseError) {
      throw new StepExecutionError(
        `verify: could not parse verdict JSON: ${(parseError as Error).message}`,
        parseError,
      );
    }

    this.saveArtifacts(ctx, feedback, prompt);

    const blocking = filterByPriority(feedback.items, minSeverity);

    console.log(`\n📊 Verification summary: ${feedback.summary}`);
    console.log(
      `   Findings: ${feedback.items.length} total, ${blocking.length} at ${minSeverity}+ severity`,
    );

    if (blocking.length === 0) {
      console.log("✅ Implementation satisfies the verified requirements");
      return { status: StepStatus.Continue, data: { findings: feedback.items.length } };
    }

    for (const item of blocking) {
      const location = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : "";
      console.log(`   [${item.priority}]${location}: ${item.issue}`);
    }

    switch (onFail) {
      case "halt":
        return { status: StepStatus.Halt, haltKind: "incomplete", reason: feedback.summary };
      case "warn":
        return { status: StepStatus.WarnContinue, reason: feedback.summary };
      default:
        return {
          status: StepStatus.Loopback,
          loopbackTo: "implement",
          loopbackFeedback: feedback,
          maxLoopbacks: maxIterations,
          reason: feedback.summary,
        };
    }
  }

  private buildPrompt(ctx: TaskContext, diff: string): string {
    let instructions = DEFAULT_INSTRUCTIONS;
    if (this.config.prompt) {
      const candidate = isAbsolute(this.config.prompt)
        ? this.config.prompt
        : resolve(ctx.workingDir, this.config.prompt);
      if (existsSync(candidate)) {
        instructions = readFileSync(candidate, "utf8");
      } else {
        instructions = this.config.prompt;
      }
    }

    return `${instructions}

## Task
---
${ctx.taskContent}
---

## Implementation Diff
\`\`\`diff
${diff}
\`\`\`

## Verdict Format
Provide your verdict as JSON in the following format:

\`\`\`json
{
  "summary": "Brief assessment of whether the requirements are met (2-3 sentences)",
  "items": [
    {
      "priority": "critical|high|medium|low|info",
      "category": "code-quality|bug|performance|security|testing|documentation|style",
      "file": "path/to/file.ts",
      "line": "42" or "42-45",
      "issue": "Requirement not met / defect description",
      "suggestion": "Specific actionable fix"
    }
  ],
  "approved": false
}
\`\`\`

Set "approved": true ONLY when every functional requirement is satisfied. Report each unmet requirement as an item with priority "high" or "critical".

**IMPORTANT**: Your response must be valid JSON only. Do not include any explanatory text outside the JSON block.
`;
  }

  private saveArtifacts(ctx: TaskContext, feedback: ReviewFeedback, prompt: string): void {
    try {
      writeFileSync(join(ctx.taskDir, "verify-feedback.json"), JSON.stringify(feedback, null, 2));
      writeFileSync(join(ctx.taskDir, "verify-prompt.txt"), prompt);
    } catch (saveError) {
      console.warn(`⚠️  Failed to save verification artifacts: ${saveError}`);
    }
  }
}

export const verifyStepDefinition: StepDefinition = {
  name: "verify",
  create: (config) => new VerifyStep(config as VerifyStepConfig),
};
