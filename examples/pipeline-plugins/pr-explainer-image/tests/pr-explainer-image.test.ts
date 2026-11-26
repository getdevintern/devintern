import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

const base = join(import.meta.dir, "..");
const config = { promptFile: join(base, "prompts/image.md") };
const png = Buffer.from(
  readFileSync(join(base, "fixtures/pixel.png.base64"), "utf8").trim(),
  "base64",
);
const diff = readFileSync(join(base, "fixtures/sample.diff"), "utf8");
let dir: string;
beforeEach(() => {
  dir = makeTempDir("pr-explainer-image-");
});
afterEach(() => {
  removeTempDir(dir);
});

function outputPath(prompt: string): string {
  return JSON.parse(prompt.match(/exact path: ("[^\n]+")./)![1]) as string;
}

describe("pr-explainer-image", () => {
  test("captures a PNG from the final diff and keeps a reproducible prompt", async () => {
    const context = createTestContext({
      workingDir: dir,
      diff,
      agentOutput: (prompt) => {
        expect(prompt).toContain(diff);
        expect(prompt).toContain("untrusted");
        expect(prompt).toContain("Do not post comments");
        writeFileSync(outputPath(prompt), png);
        return "Generated and inspected the image.";
      },
    });
    expect((await runDefinition(definition, context, { config })).kind).toBe("completed");
    const [artifact] = context.artifacts.list();
    expect(artifact.key).toBe("explanation-image");
    expect(artifact.mediaType).toBe("image/png");
    expect(Buffer.from(context.artifacts.readBytes(artifact.id)!)).toEqual(png);
    const data = context.results[0].result.data as { path: string; promptPath: string };
    expect(readFileSync(data.promptPath, "utf8")).toContain(diff);
    // A later overwrite cannot change the registered snapshot.
    writeFileSync(data.path, "overwritten");
    expect(Buffer.from(context.artifacts.readBytes(artifact.id)!)).toEqual(png);
  });

  test("does not reuse a previous image when a later generation produces no file", async () => {
    let calls = 0;
    const context = createTestContext({
      workingDir: dir,
      agentOutput: (prompt) => {
        if (++calls === 1) writeFileSync(outputPath(prompt), png);
        return "done";
      },
    });
    await runDefinition(definition, context, { config });
    await runDefinition(definition, context, { config });
    expect(context.artifacts.list()).toHaveLength(1);
    expect(context.warnings.some((value) => value.includes("ENOENT"))).toBe(true);
  });

  for (const failure of ["unavailable", "invalid", "capture"] as const) {
    test(`${failure} failure warns and lets finalize continue`, async () => {
      let finalized = false;
      const context = createTestContext({
        workingDir: dir,
        agentOutput: (prompt) => {
          if (failure === "unavailable") throw new Error("image tool unavailable");
          writeFileSync(
            outputPath(prompt),
            failure === "invalid" ? "This is a text diagram, not a PNG." : png,
          );
          return "done";
        },
      });
      if (failure === "capture") context.artifacts.addFile = async () => null;
      expect(
        (
          await runDefinition(definition, context, {
            config,
            after: [
              {
                name: "finalize",
                run: async () => {
                  finalized = true;
                  return { kind: "continue" };
                },
              },
            ],
          })
        ).kind,
      ).toBe("completed");
      expect(finalized).toBe(true);
      expect(context.warnings).toHaveLength(1);
      expect(context.artifacts.list()).toHaveLength(0);
    });
  }

  describe("promptFile resolution", () => {
    let pipelineDir: string;
    beforeEach(() => {
      pipelineDir = makeTempDir("pr-explainer-image-pipeline-");
      for (const root of [dir, pipelineDir]) mkdirSync(join(root, "prompts"), { recursive: true });
      writeFileSync(join(pipelineDir, "prompts", "image.md"), "PIPELINE PROMPT");
      writeFileSync(join(dir, "prompts", "image.md"), "CHECKOUT PROMPT");
    });
    afterEach(() => {
      removeTempDir(pipelineDir);
    });

    async function run(pipelineDirValue: string | null, promptFile: string) {
      let captured = "";
      const context = createTestContext({
        workingDir: dir,
        pipelineDir: pipelineDirValue,
        diff,
        agentOutput: (prompt) => {
          captured = prompt;
          writeFileSync(outputPath(prompt), png);
          return "done";
        },
      });
      await runDefinition(definition, context, { config: { promptFile } });
      return { captured, warnings: context.warnings };
    }

    test("reads a relative promptFile from pipelineDir", async () => {
      const { captured } = await run(pipelineDir, "./prompts/image.md");
      expect(captured).toContain("PIPELINE PROMPT");
      expect(captured).not.toContain("CHECKOUT PROMPT");
    });

    test("reads a relative promptFile from workingDir when pipelineDir is null", async () => {
      const { captured } = await run(null, "./prompts/image.md");
      expect(captured).toContain("CHECKOUT PROMPT");
    });

    test("reads an absolute promptFile as written", async () => {
      const { captured } = await run(pipelineDir, join(dir, "prompts", "image.md"));
      expect(captured).toContain("CHECKOUT PROMPT");
    });

    test("warns with the absolute path tried when missing under pipelineDir", async () => {
      writeFileSync(join(dir, "prompts", "only-in-checkout.md"), "CHECKOUT ONLY");
      const { captured, warnings } = await run(pipelineDir, "./prompts/only-in-checkout.md");
      expect(captured).toBe("");
      expect(warnings.join("\n")).toContain(join(pipelineDir, "prompts", "only-in-checkout.md"));
    });
  });

  test("rejects missing or malformed configuration before running", () => {
    for (const promptFile of [undefined, "", "   ", 123]) {
      expect(() => definition.create({ promptFile })).toThrow("promptFile");
    }
  });
});
