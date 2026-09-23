import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { UsageLimitError } from "@devintern/agent-harness";
import { resolveOutputDir } from "../config/output-dir";
import {
  filterByPriority,
  getPRDiff,
  parseReviewFeedback,
  runAgentPrompt,
} from "../review/auto-review-loop";
import type { ReviewFeedback, ReviewPriority } from "../../types/auto-review";
import type { TaskStepResult } from "../task/step-runner";
import type { DeliveryState } from "./run-harness-finalize";

export interface VerifyConfig {
  /** Inline instructions or a prompt file relative to the working directory. */
  prompt?: string;
  onFail?: "loopback" | "halt" | "warn";
  maxIterations?: number;
  minSeverity?: ReviewPriority;
}

export interface VerifyDependencies {
  getDiff: typeof getPRDiff;
  runAgent: typeof runAgentPrompt;
  parseFeedback: typeof parseReviewFeedback;
  filterItems: typeof filterByPriority;
}

const defaultDeps: VerifyDependencies = {
  getDiff: getPRDiff,
  runAgent: runAgentPrompt,
  parseFeedback: parseReviewFeedback,
  filterItems: filterByPriority,
};

const DEFAULT_INSTRUCTIONS = `Verify whether the implementation satisfies the task's functional requirements. Check completeness, correctness, acceptance criteria, and regressions. Return only JSON with this shape: {"summary":"...","items":[{"priority":"critical|high|medium|low|info","category":"bug|testing|documentation|code-quality|performance|security|style","file":"path","line":"42","issue":"...","suggestion":"..."}],"approved":true}. Report each unmet requirement as a high or critical item. Set approved true only when every requirement is satisfied.`;

const PRIORITIES: readonly ReviewPriority[] = ["critical", "high", "medium", "low", "info"];

function instructionsFor(config: VerifyConfig, workingDir: string): string {
  if (!config.prompt) return DEFAULT_INSTRUCTIONS;
  const path = isAbsolute(config.prompt) ? config.prompt : resolve(workingDir, config.prompt);
  return existsSync(path) ? readFileSync(path, "utf8") : config.prompt;
}

function buildVerifyPrompt(config: VerifyConfig, taskContent: string, diff: string, cwd: string) {
  return `${instructionsFor(config, cwd)}\n\n## Task\n${taskContent}\n\n## Implementation diff\n\`\`\`diff\n${diff}\n\`\`\``;
}

/** Build a focused repair prompt for the next implementation run. */
export function buildRepairPrompt(taskContent: string, feedback: ReviewFeedback): string {
  const findings = feedback.items
    .map(
      (item, index) =>
        `${index + 1}. [${item.priority}] ${item.issue}${item.file ? ` in ${item.file}` : ""}\n   Fix: ${item.suggestion}`,
    )
    .join("\n");
  return `Your implementation did not fully satisfy the task. Address these findings with focused changes:\n\n${findings}\n\nOriginal task:\n${taskContent}\n\nDo not commit or push; the task runner handles delivery.`;
}

function saveVerification(state: DeliveryState, prompt: string, feedback: ReviewFeedback): void {
  const ctx = state.context;
  const taskDir = ctx.taskKey
    ? join(resolveOutputDir(), ctx.taskKey.toLowerCase())
    : dirname(ctx.taskFile);
  try {
    writeFileSync(join(taskDir, "verify-prompt.txt"), prompt);
    writeFileSync(join(taskDir, "verify-feedback.json"), JSON.stringify(feedback, null, 2));
  } catch (error) {
    console.warn(`⚠️  Failed to save verification artifacts: ${error}`);
  }
}

function validateFeedback(feedback: ReviewFeedback): void {
  if (!Array.isArray(feedback.items)) throw new Error("Verification verdict has no items array");
  for (const item of feedback.items) {
    if (
      !item ||
      !PRIORITIES.includes(item.priority) ||
      typeof item.issue !== "string" ||
      typeof item.suggestion !== "string"
    ) {
      throw new Error("Verification verdict contains an invalid finding");
    }
  }
}

/** Verify the committed diff before auto-review and publishing. */
export async function verifyImplementation(
  state: DeliveryState,
  deps: VerifyDependencies = defaultDeps,
  config: VerifyConfig | undefined = state.context.verify,
  repairStep = "repair",
): Promise<TaskStepResult | void> {
  if (!config) return;
  if (!state.committed) return { kind: "halt", reason: "No committed implementation to verify" };
  const maxIterations = config.maxIterations ?? 3;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new Error("verify.maxIterations must be a positive integer");
  }
  const minSeverity = config.minSeverity ?? "high";
  if (!PRIORITIES.includes(minSeverity)) {
    throw new Error(`Unknown verify.minSeverity: ${minSeverity}`);
  }
  if (config.onFail && !["loopback", "halt", "warn"].includes(config.onFail)) {
    throw new Error(`Unknown verify.onFail: ${config.onFail}`);
  }
  const workingDir = process.cwd();
  let prompt = "";
  let feedback: ReviewFeedback | undefined;

  // Transient diff, agent, and JSON failures get one retry. Usage limits are
  // account-wide and must propagate immediately to worker failover.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const diff = deps.getDiff(state.context.prTargetBranch, workingDir);
      prompt = buildVerifyPrompt(config, state.context.taskContent, diff, workingDir);
      const output = await deps.runAgent(
        prompt,
        workingDir,
        state.context.harness,
        state.context.executablePath,
      );
      feedback = deps.parseFeedback(output);
      validateFeedback(feedback);
      break;
    } catch (error) {
      if (error instanceof UsageLimitError) throw error;
      if (attempt === 1) {
        return { kind: "halt", reason: `Verification failed twice: ${(error as Error).message}` };
      }
      console.warn(`⚠️  Verification execution failed; retrying: ${(error as Error).message}`);
    }
  }
  if (!feedback) return { kind: "halt", reason: "Verification returned no verdict" };
  saveVerification(state, prompt, feedback);
  const blocking = deps.filterItems(feedback.items, minSeverity);
  console.log(`\n🔎 Verification: ${feedback.summary}`);
  if (blocking.length === 0) return;

  if (config.onFail === "warn") {
    console.warn(`⚠️  Verification found ${blocking.length} blocking issue(s); continuing`);
    return;
  }
  if (config.onFail === "halt") {
    return { kind: "halt", reason: feedback.summary };
  }
  state.pendingFeedback = feedback;
  return { kind: "repeat", from: repairStep, maxRepeats: maxIterations };
}
