/**
 * Shared execution scaffold for the `pr-explainer-*` examples.
 *
 * The two variants differ only in their Markdown prompt (narrative vs visual);
 * the mechanics — gathering the final diff, grounding the explanation in the
 * prior step results, framing task/diff as untrusted data, writing an artifact,
 * and degrading to an advisory warning on failure — live here.
 *
 * The returned `data.content` is picked up by the CLI's PR-body builder for any
 * step whose name starts with `pr-explainer-`: when a PR is created, the
 * explanation is appended as an `Explanation` section. The artifact is still
 * written for the local dashboard, and a failure remains advisory — it never
 * blocks publication. See the example README for details.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { untrustedContentBlock } from "@getdevintern/code/pipeline";
import type {
  PipelineContext,
  StepDefinition,
  TaskStepRecord,
  TaskStepResult,
} from "@getdevintern/code/pipeline";

export interface ExplainerOptions {
  /** Markdown prompt file, relative to `context.workingDir`. */
  promptFile?: string;
  /** Artifact filename written under `context.outputDir`. */
  outputName?: string;
}

const MAX_EVIDENCE_CHARS = 2_000;

/** Render prior step results as bounded, diffable evidence. */
export function evidenceFromResults(results: TaskStepRecord[]): string {
  if (results.length === 0) return "(no prior step results recorded)";
  return results
    .map(({ step, result }) => {
      const data = result.data ? ` data=${JSON.stringify(result.data)}` : "";
      const detail = `kind=${result.kind}${data}`;
      return `- ${step}: ${detail}`;
    })
    .join("\n")
    .slice(0, MAX_EVIDENCE_CHARS);
}

function readPrompt(options: ExplainerOptions, workingDir: string): string | undefined {
  if (typeof options.promptFile !== "string" || !options.promptFile.trim()) return undefined;
  const file = isAbsolute(options.promptFile)
    ? options.promptFile
    : join(workingDir, options.promptFile);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Build a `StepDefinition` for one explainer variant. */
export function createExplainerDefinition(name: string): StepDefinition {
  return {
    name,
    create(config) {
      const options = config as ExplainerOptions;
      const outputName =
        typeof options.outputName === "string" && options.outputName.trim()
          ? options.outputName
          : "pr-explanation.md";

      return {
        name,
        async run(context: PipelineContext): Promise<TaskStepResult> {
          const resultPath = join(context.outputDir, outputName);
          try {
            const instructions = readPrompt(options, context.workingDir);
            if (!instructions) {
              return {
                kind: "warn",
                reason: `${name}: prompt file not found; skipping the explanation artifact.`,
              };
            }

            const evidence = evidenceFromResults(context.results);
            const prompt = [
              instructions.trim(),
              "",
              "## Task",
              untrustedContentBlock(context.taskContent.trim(), "task content"),
              "",
              "## Final diff",
              untrustedContentBlock(
                `\`\`\`diff\n${context.getDiff().trim()}\n\`\`\``,
                "implementation diff",
              ),
              "",
              "## Evidence from earlier pipeline steps",
              untrustedContentBlock(evidence, "pipeline step results"),
              "",
              "Only claim validation that the evidence above actually shows. Never invent passing tests,",
              "screenshots, or before/after results. Separate observed evidence from inference.",
            ].join("\n");

            const content = (await context.runAgentPrompt(prompt)).trim();
            mkdirSync(dirname(resultPath), { recursive: true });
            writeFileSync(resultPath, `${content}\n`, "utf8");
            console.log(`📝 ${name}: wrote explanation to ${resultPath}`);
            return { kind: "continue", data: { path: resultPath, content } };
          } catch (error) {
            return {
              kind: "warn",
              reason: `${name}: could not generate the explanation artifact (${(error as Error).message}). Publication continues.`,
            };
          }
        },
      };
    },
  };
}
