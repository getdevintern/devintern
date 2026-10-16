import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { untrustedContentBlock } from "@getdevintern/code/pipeline";
import type { StepDefinition } from "@getdevintern/code/pipeline";

const definition: StepDefinition = {
  name: "pr-explainer-image",
  create(config) {
    if (typeof config.promptFile !== "string" || !config.promptFile.trim()) {
      throw new Error("pr-explainer-image requires a non-empty promptFile");
    }
    const promptFile = config.promptFile;
    return {
      name: "pr-explainer-image",
      async run(context) {
        try {
          const file = isAbsolute(promptFile) ? promptFile : join(context.workingDir, promptFile);
          const instructions = readFileSync(file, "utf8");
          mkdirSync(context.outputDir, { recursive: true });
          // A fresh directory prevents a failed generation from reusing stale output.
          const outputDir = mkdtempSync(join(context.outputDir, "pr-explainer-image-"));
          const path = join(outputDir, "pr-explanation.png");
          const prompt = [
            instructions,
            `Generate the image and save the final PNG to this exact path: ${JSON.stringify(path)}.`,
            "Use your image generation tool. If it saves elsewhere, copy the selected PNG here.",
            "Inspect the image against the diff and correct inaccurate labels before finishing.",
            "If image generation is unavailable, report that failure; do not substitute a text diagram.",
            "Do not post comments, upload files, or modify repository files; finalize publishes the artifact.",
            untrustedContentBlock(context.taskContent.slice(0, 12_000), "task content"),
            untrustedContentBlock(
              context.getDiff().slice(0, 80_000),
              "final diff (possibly truncated)",
            ),
            "Omitted diff content is unknown; only depict behavior supported by the supplied diff.",
          ].join("\n\n");
          const promptPath = join(outputDir, "prompt.md");
          writeFileSync(promptPath, prompt);
          await context.runAgentPrompt(prompt);
          const size = statSync(path).size;
          if (size < 24 || size > 32 * 1024 * 1024) {
            throw new Error("generated PNG must be between 24 bytes and 32 MiB");
          }
          const bytes = readFileSync(path);
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error("generated file does not have a PNG signature");
          }
          const artifact = await context.artifacts.addFile({
            key: "explanation-image",
            path,
            title: "How this change works",
            kind: "image",
            mediaType: "image/png",
          });
          if (!artifact) throw new Error("image capture failed; check artifact storage");
          return { kind: "continue", data: { path, promptPath, artifactId: artifact.id } };
        } catch (error) {
          return {
            kind: "warn",
            reason: `pr-explainer-image: ${String(error)}. Check image-tool access and retry; PR delivery continues.`,
          };
        }
      },
    };
  },
};

export default definition;
