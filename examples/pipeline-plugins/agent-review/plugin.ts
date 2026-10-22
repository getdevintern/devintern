/**
 * agent-review — an agent-backed review step that uses the public
 * `PipelineContext` helpers (`getDiff`, `runAgentPrompt`, `parseReviewFeedback`,
 * `filterByPriority`). On blocking findings it asks the agent to revise the
 * implementation with structured feedback, then re-runs the checks after the
 * recommit.
 *
 * Place it after `commit`, and after any deterministic checks, so it reviews
 * the committed diff. A returned `repeat` re-executes the target step and every
 * step after it, so the `commit` step runs again before this review.
 *
 * A failing verdict is *not* a transient error: returning `repeat` (bounded) or
 * `halt` is the correct response. Only an infrastructure failure that should be
 * retried once uses `StepExecutionError`.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { untrustedContentBlock } from "@getdevintern/code/pipeline";
import type {
  PipelineContext,
  ReviewFeedback,
  ReviewPriority,
  StepDefinition,
  TaskStepResult,
} from "@getdevintern/code/pipeline";

interface AgentReviewOptions {
  /** Inline review instructions. */
  prompt?: string;
  /** Path to a prompt file, relative to `context.workingDir`. */
  promptFile?: string;
  /** Lowest priority that blocks, default `medium`. */
  minPriority?: ReviewPriority;
  /** Bounded repair cycles, default `2`. */
  maxIterations?: number;
  /** `loopback` (default), `halt`, or `warn`. */
  onBlocked?: "loopback" | "halt" | "warn";
}

const DEFAULT_INSTRUCTIONS = [
  "Review the implementation diff against the task.",
  'Return only JSON: {"summary":"...","items":[{"priority":"critical|high|medium|low|info",',
  '"category":"bug|testing|documentation|code-quality|performance|security|style",',
  '"file":"path","line":"42","issue":"...","suggestion":"..."}],"approved":true}.',
  "Set approved true only when no medium-or-higher issue remains.",
].join(" ");

const PRIORITIES: readonly ReviewPriority[] = ["critical", "high", "medium", "low", "info"];

function instructionsFor(options: AgentReviewOptions, workingDir: string): string {
  if (typeof options.prompt === "string" && options.prompt.trim()) return options.prompt;
  if (typeof options.promptFile === "string" && options.promptFile.trim()) {
    const file = isAbsolute(options.promptFile)
      ? options.promptFile
      : join(workingDir, options.promptFile);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return DEFAULT_INSTRUCTIONS;
}

const definition: StepDefinition = {
  name: "agent-review",
  create(config) {
    const options = config as AgentReviewOptions;
    const minPriority: ReviewPriority =
      typeof options.minPriority === "string" && PRIORITIES.includes(options.minPriority)
        ? options.minPriority
        : "medium";
    const maxIterations =
      typeof options.maxIterations === "number" && Number.isSafeInteger(options.maxIterations)
        ? Math.max(1, options.maxIterations)
        : 2;
    const onBlocked = options.onBlocked ?? "loopback";

    return {
      name: "agent-review",
      async run(context: PipelineContext): Promise<TaskStepResult> {
        const instructions = instructionsFor(options, context.workingDir);
        const framedDiff = untrustedContentBlock(
          `\`\`\`diff\n${context.getDiff().trim()}\n\`\`\``,
          "implementation diff",
        );
        const prompt = `${instructions}\n\n## Task\n${context.taskContent.trim()}\n\n## Diff\n${framedDiff}`;

        // Give a malformed verdict one retry, matching the built-in verify step.
        let feedback: ReviewFeedback | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const output = await context.runAgentPrompt(prompt);
          try {
            feedback = context.parseReviewFeedback(output, { enforceApproval: false });
            break;
          } catch (error) {
            if (attempt === 1) {
              return {
                kind: "halt",
                reason: `Review agent returned a malformed verdict twice: ${(error as Error).message}`,
              };
            }
            console.warn(`⚠️  agent-review: malformed verdict, retrying once`);
          }
        }
        if (!feedback) return { kind: "halt", reason: "Review agent returned no verdict" };

        const blocking = context.filterByPriority(feedback.items, minPriority);
        // An approval that lists blocking findings is contradictory; resolve it
        // as a rejection so `onBlocked` decides instead of treating it as a
        // malformed verdict and retrying the agent.
        if (feedback.approved && blocking.length > 0) {
          feedback = { ...feedback, approved: false };
        }
        console.log(`🔎 agent-review: ${feedback.summary} (${blocking.length} blocking)`);
        if (blocking.length === 0) {
          return {
            kind: "continue",
            data: { summary: feedback.summary, approved: feedback.approved },
          };
        }

        if (onBlocked === "warn") {
          return { kind: "warn", reason: feedback.summary, data: { items: blocking } };
        }
        if (onBlocked === "halt") {
          return {
            kind: "halt",
            haltKind: "stop",
            reason: `Review found ${blocking.length} blocking issue(s): ${feedback.summary}`,
            data: { items: blocking },
          };
        }
        return {
          kind: "repeat",
          from: "implement",
          maxRepeats: maxIterations,
          reason: feedback.summary,
          feedback,
        };
      },
    };
  },
};

export default definition;
