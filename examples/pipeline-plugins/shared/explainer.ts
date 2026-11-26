/**
 * Shared execution scaffold for the `pr-explainer-*` examples.
 *
 * The two variants differ only in their Markdown prompt (narrative vs visual);
 * the mechanics — gathering the final diff, grounding the explanation in the
 * prior step results, framing task/diff as untrusted data, writing an artifact,
 * and degrading to an advisory warning on failure — live here.
 *
 * Registers explanation artifacts; publication is selected explicitly through
 * pipeline.artifacts.publish rather than inferred from the plugin's name.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { untrustedContentBlock } from "@getdevintern/code/pipeline";
import type {
  PipelineContext,
  StepDefinition,
  TaskStepRecord,
  TaskStepResult,
} from "@getdevintern/code/pipeline";

import { resolvePromptPath } from "./prompt-path";

export interface ExplainerOptions {
  /**
   * Markdown prompt file. Relative paths resolve against `context.pipelineDir`
   * (the pipeline file's directory), or `context.workingDir` when it is `null`.
   */
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
      const data = result.data ? ` data=${JSON.stringify(result.data).slice(0, 500)}` : "";
      const detail = `kind=${result.kind}${data}`;
      return `- ${step}: ${detail}`;
    })
    .join("\n")
    .slice(-MAX_EVIDENCE_CHARS);
}

type PromptLookup = { instructions: string } | { missing: string | undefined };

function readPrompt(options: ExplainerOptions, context: PipelineContext): PromptLookup {
  if (typeof options.promptFile !== "string" || !options.promptFile.trim()) {
    return { missing: undefined };
  }
  const file = resolvePromptPath(options.promptFile, context);
  return existsSync(file) ? { instructions: readFileSync(file, "utf8") } : { missing: file };
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
            const lookup = readPrompt(options, context);
            if (!("instructions" in lookup)) {
              const where = lookup.missing ? ` at ${lookup.missing}` : " (no promptFile set)";
              return {
                kind: "warn",
                reason: `${name}: prompt file not found${where}; skipping the explanation artifact.`,
              };
            }
            const { instructions } = lookup;

            const latest = [
              ...new Map(
                context.artifacts.list().map((artifact) => [artifact.key, artifact]),
              ).values(),
            ];
            const verification = latest.filter((artifact) => artifact.kind === "verification");
            const priority = (key: string) =>
              key === "verification" ? 0 : key === "auto-review" ? 1 : 2;
            verification.sort(
              (left, right) =>
                priority(left.key) - priority(right.key) || right.createdAt - left.createdAt,
            );
            const registeredEvidence = verification
              .slice(0, 4)
              .map(
                (artifact) =>
                  `Artifact ${artifact.key}, step ${artifact.step}, execution ${artifact.iteration}:\n${context.artifacts.readText(artifact.id)?.slice(0, 2_000) ?? "(preview unavailable)"}`,
              )
              .join("\n\n");
            const evidence = [evidenceFromResults(context.results), registeredEvidence]
              .filter(Boolean)
              .join("\n\n");
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
            await context.artifacts.addFile({
              key: name.replace(/^pr-explainer-/, "explanation-"),
              path: resultPath,
              title: name.endsWith("visual") ? "Visual explanation" : "Change explanation",
              kind: "explanation",
              mediaType: "text/markdown",
            });
            console.log(`📝 ${name}: wrote explanation to ${resultPath}`);
            return { kind: "continue", data: { path: resultPath } };
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
