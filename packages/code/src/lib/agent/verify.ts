import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { UsageLimitError } from "@devintern/agent-harness";
import { resolveOutputDir } from "../config/output-dir";
import {
  filterByPriority,
  getPRDiff,
  parseReviewFeedback,
  runAgentPrompt,
} from "../review/auto-review-loop";
import type { ReviewFeedback, ReviewFeedbackItem, ReviewPriority } from "../../types/auto-review";
import { untrustedContentBlock } from "../prompts/untrusted-content";
import { validateReviewFeedback } from "../review/feedback";
import { recordRunStage } from "../state/run-recorder";
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

const DEFAULT_INSTRUCTIONS = `Verify whether the implementation satisfies the task's functional requirements. Check completeness, correctness, acceptance criteria, and regressions. Then apply a blast-radius lens: trace the callers, callees, and sibling consumers of the changed code beyond the diff and name the one fact the change is safe because of. Back each finding with evidence on this ladder (weakest to strongest): asserted, pointed at a real file:line, shown can't-happen, ran a check. Mark each item with a confidence of high (ran it), medium (pointed or can't-happen), or low (asserted or unproven); findings without evidence are reported with low confidence rather than dropped. Return only JSON with this shape: {"summary":"...","items":[{"priority":"critical|high|medium|low|info","confidence":"high|medium|low","category":"bug|testing|documentation|code-quality|performance|security|style","file":"path","line":"42","issue":"...","evidence":"command run and result, file:line, or unproven","suggestion":"..."}],"approved":true}. Report each unmet requirement as a high or critical item. Set approved true only when every requirement is satisfied.`;

const PRIORITIES: readonly ReviewPriority[] = ["critical", "high", "medium", "low", "info"];

function instructionsFor(config: VerifyConfig, workingDir: string): string {
  if (!config.prompt) return DEFAULT_INSTRUCTIONS;
  const path = isAbsolute(config.prompt) ? config.prompt : resolve(workingDir, config.prompt);
  return existsSync(path) ? readFileSync(path, "utf8") : config.prompt;
}

function buildVerifyPrompt(config: VerifyConfig, taskContent: string, diff: string, cwd: string) {
  // `taskContent` is the already-formatted task prompt assembled by our own
  // formatter: its untrusted sections are framed at the leaf. Wrap only the raw
  // external diff here; re-framing the task would nest frames and neutralize the
  // authentic inner boundary markers.
  const framedDiff = untrustedContentBlock(`\`\`\`diff\n${diff}\n\`\`\``, "implementation diff");
  return `${instructionsFor(config, cwd)}\n\n## Task\n${taskContent.trimEnd()}\n\n## Implementation diff\n${framedDiff}`;
}

/** Build a focused repair prompt for the next implementation run. */
export function buildRepairPrompt(taskContent: string, feedback: ReviewFeedback): string {
  const findings = feedback.items
    .map(
      (item, index) =>
        `${index + 1}. [${item.priority}] ${item.issue}${item.file ? ` in ${item.file}` : ""}${item.confidence ? `\n   Confidence: ${item.confidence}` : ""}${item.evidence ? `\n   Evidence: ${item.evidence}` : ""}\n   Fix: ${item.suggestion}`,
    )
    .join("\n");
  // `taskContent` is our own already-framed task prompt; only the raw findings
  // from the verifier are external and need framing.
  return `Your implementation did not fully satisfy the task. Address these findings with focused changes:\n\n${untrustedContentBlock(findings, "verification findings")}\n\nOriginal task:\n${taskContent.trimEnd()}\n\nDo not commit or push; the task runner handles delivery.`;
}

/** Directory holding the task's verification artifacts. */
function taskArtifactDir(state: DeliveryState): string {
  const ctx = state.context;
  return ctx.taskKey ? join(resolveOutputDir(), ctx.taskKey.toLowerCase()) : dirname(ctx.taskFile);
}

async function saveVerification(
  state: DeliveryState,
  prompt: string,
  feedback: ReviewFeedback,
): Promise<void> {
  const taskDir = taskArtifactDir(state);
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "verify-prompt.txt"), prompt);
    writeFileSync(join(taskDir, "verify-feedback.json"), JSON.stringify(feedback, null, 2));
    await state.artifacts.addFile({
      key: "verification",
      path: join(taskDir, "verify-feedback.json"),
      title: "Verification report",
      kind: "verification",
      mediaType: "application/json",
    });
    await state.artifacts.addFile({
      key: "verification-prompt",
      path: join(taskDir, "verify-prompt.txt"),
      title: "Verification prompt",
      kind: "debug",
      mediaType: "text/plain",
    });
  } catch (error) {
    console.warn(`⚠️  Failed to save verification artifacts: ${error}`);
  }
}

/**
 * Persist the prompt and raw agent output when no verdict could be parsed.
 *
 * Without this, a failed verification leaves only the parser's one-line error
 * on the ticket and the raw answer exists only in the harness transcript, so
 * nobody can tell whether the agent found a real problem or wrote bad JSON.
 */
async function saveVerificationFailure(
  state: DeliveryState,
  prompt: string,
  output: string,
): Promise<void> {
  const taskDir = taskArtifactDir(state);
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "verify-prompt.txt"), prompt);
    writeFileSync(join(taskDir, "verify-output.txt"), output);
    await state.artifacts.addFile({
      key: "verification-prompt",
      path: join(taskDir, "verify-prompt.txt"),
      title: "Verification prompt",
      kind: "debug",
      mediaType: "text/plain",
    });
    await state.artifacts.addFile({
      key: "verification-output",
      path: join(taskDir, "verify-output.txt"),
      title: "Verification agent output",
      kind: "debug",
      mediaType: "text/plain",
    });
  } catch (error) {
    console.warn(`⚠️  Failed to save verification failure artifacts: ${error}`);
  }
}

/**
 * Human-readable verification outcome for a halt, warn, or repair reason.
 *
 * The tracker comment and the dashboard both render this string, so it carries
 * the verdict summary plus the blocking findings — "verification failed"
 * without the findings is not actionable.
 *
 * @param feedback - Parsed verdict.
 * @param blocking - Findings at or above the configured threshold.
 * @param limit - Maximum findings listed inline before eliding the rest.
 */
export function describeVerificationFailure(
  feedback: ReviewFeedback,
  blocking: ReviewFeedbackItem[],
  limit = 8,
): string {
  const listed = blocking.slice(0, limit).map((item) => {
    const where = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : "";
    return `- [${item.priority}] ${item.category}: ${item.issue}${where}`;
  });
  const remaining = blocking.length - listed.length;
  const more = remaining > 0 ? [`- …and ${remaining} more`] : [];
  return [
    `Verification found ${blocking.length} blocking finding(s): ${feedback.summary}`,
    ...listed,
    ...more,
  ].join("\n");
}

/** Verify the committed diff before auto-review and publishing. */
export async function verifyImplementation(
  state: DeliveryState,
  deps: VerifyDependencies = defaultDeps,
  config: VerifyConfig | undefined = state.context.verify,
  repairStep = "repair",
): Promise<TaskStepResult | void> {
  if (!config) return;
  if (!state.enableGit) {
    return { kind: "warn", reason: "verify skipped: git workflow disabled" };
  }
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
  let output = "";
  let feedback: ReviewFeedback | undefined;

  // Transient diff, agent, and JSON failures get one retry. Usage limits are
  // account-wide and must propagate immediately to worker failover.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const diff = deps.getDiff(state.context.prTargetBranch, workingDir);
      prompt = buildVerifyPrompt(config, state.context.taskContent, diff, workingDir);
      output = await deps.runAgent(
        prompt,
        workingDir,
        state.context.harness,
        state.context.executablePath,
      );
      feedback = deps.parseFeedback(output);
      // Approvals only have to be free of findings at or above the configured
      // blocking threshold; lower-priority notes are advisory here.
      validateReviewFeedback(feedback, minSeverity);
      break;
    } catch (error) {
      if (error instanceof UsageLimitError) throw error;
      if (attempt === 1) {
        const message = `Verification failed twice: ${(error as Error).message}`;
        // A missing verdict must still be diagnosable: keep the prompt and the
        // raw answer, and record the stage so the dashboard shows verification
        // instead of an unexplained halted implementation.
        await saveVerificationFailure(state, prompt, output);
        recordRunStage("verify", {
          status: "failed",
          summary: (error as Error).message,
          detail: { error: (error as Error).message, attempts: 2 },
        });
        return { kind: "halt", reason: message };
      }
      console.warn(`⚠️  Verification execution failed; retrying: ${(error as Error).message}`);
    }
  }
  if (!feedback) return { kind: "halt", reason: "Verification returned no verdict" };
  await saveVerification(state, prompt, feedback);
  const blocking = deps.filterItems(feedback.items, minSeverity);
  console.log(`\n🔎 Verification: ${feedback.summary}`);
  recordRunStage("verify", {
    status: blocking.length === 0 ? "succeeded" : "failed",
    summary: feedback.summary,
    detail: {
      approved: feedback.approved,
      summary: feedback.summary,
      blocking: blocking.length,
      total: feedback.items.length,
      items: blocking.length > 0 ? blocking : feedback.items,
    },
  });
  if (blocking.length === 0) return;

  const failure = describeVerificationFailure(feedback, blocking);
  if (config.onFail === "warn") {
    console.warn(`⚠️  Verification found ${blocking.length} blocking issue(s); continuing`);
    return { kind: "warn", reason: failure };
  }
  if (config.onFail === "halt") {
    return { kind: "halt", reason: failure };
  }
  state.pendingFeedback = feedback;
  return { kind: "repeat", from: repairStep, maxRepeats: maxIterations, reason: failure };
}
