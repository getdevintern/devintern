import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import narrative from "../../pr-explainer-narrative/plugin";
import visual from "../../pr-explainer-visual/plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../harness";

let workdir: string;
let pipelineDir: string;

beforeEach(() => {
  workdir = makeTempDir("explainer-prompt-work-");
  pipelineDir = makeTempDir("explainer-prompt-pipeline-");
  for (const dir of [workdir, pipelineDir]) mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(pipelineDir, "prompts", "explainer.md"), "PIPELINE PROMPT");
  writeFileSync(join(workdir, "prompts", "explainer.md"), "CHECKOUT PROMPT");
});

afterEach(() => {
  removeTempDir(workdir);
  removeTempDir(pipelineDir);
});

for (const definition of [narrative, visual]) {
  describe(`${definition.name} promptFile resolution`, () => {
    async function run(pipelineDirValue: string | null, promptFile: string) {
      let captured = "";
      const context = createTestContext({
        workingDir: workdir,
        outputDir: workdir,
        pipelineDir: pipelineDirValue,
        agentOutput: (prompt) => {
          captured = prompt;
          return "explanation";
        },
      });
      await runDefinition(definition, context, { config: { promptFile } });
      return { captured, warnings: context.warnings };
    }

    test("reads a relative promptFile from pipelineDir", async () => {
      const { captured } = await run(pipelineDir, "./prompts/explainer.md");
      expect(captured).toContain("PIPELINE PROMPT");
      expect(captured).not.toContain("CHECKOUT PROMPT");
    });

    test("reads a relative promptFile from workingDir when pipelineDir is null", async () => {
      const { captured } = await run(null, "./prompts/explainer.md");
      expect(captured).toContain("CHECKOUT PROMPT");
    });

    test("reads an absolute promptFile as written", async () => {
      const { captured } = await run(pipelineDir, join(workdir, "prompts", "explainer.md"));
      expect(captured).toContain("CHECKOUT PROMPT");
    });

    test("warns with the absolute path tried, without falling back to workingDir", async () => {
      writeFileSync(join(workdir, "prompts", "only-in-checkout.md"), "CHECKOUT ONLY");
      const { captured, warnings } = await run(pipelineDir, "./prompts/only-in-checkout.md");
      expect(captured).toBe("");
      expect(warnings.join("\n")).toContain(join(pipelineDir, "prompts", "only-in-checkout.md"));
    });
  });
}
