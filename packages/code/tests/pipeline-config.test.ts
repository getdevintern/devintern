import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PIPELINE, resolvePipelineSteps } from "../src/lib/task/pipeline-config";
import { registerStep } from "../src/lib/task/pipeline-registry";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "pipeline-config-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("pipeline configuration", () => {
  test("exposes the plugin API through the package subpath", async () => {
    const api = await import("@getdevintern/code/pipeline");
    expect(api.registerStep).toBeFunction();
    expect(api.StepExecutionError).toBeFunction();
    const name = `public-api-${randomUUID()}`;
    api.registerStep({ name, create: () => ({ name, run: async () => {} }) });
    expect(api.getStep(name)).toBeDefined();
  });

  test("keeps the existing delivery order when settings omit pipeline", async () => {
    expect(DEFAULT_PIPELINE.map((step) => step.use)).toEqual([
      "implement",
      "commit",
      "auto-review",
      "finalize",
    ]);
    expect((await resolvePipelineSteps(undefined, projectRoot)).map((step) => step.use)).toEqual([
      "commit",
      "auto-review",
      "finalize",
    ]);
  });

  test("allows multiple configured verifiers and a registered plugin", async () => {
    const name = `fixture-${randomUUID()}`;
    registerStep({
      name,
      create: (config) => ({
        name,
        run: async (context) => {
          context.warnings.push(String(config.threshold));
          return { kind: "continue" };
        },
      }),
    });
    const steps = await resolvePipelineSteps(
      {
        steps: [
          { use: "clarity" },
          { use: "implement" },
          { use: "commit" },
          { use: "verify", prompt: "functional", maxIterations: 2 },
          { use: name, threshold: 0.9 },
          { use: "verify", prompt: "security", onFail: "warn" },
          { use: "finalize" },
        ],
      },
      projectRoot,
    );

    expect(steps.map((step) => step.use)).toEqual([
      "commit",
      "verify",
      "plugin",
      "verify",
      "finalize",
    ]);
    expect(steps[1]).toEqual({ use: "verify", config: { prompt: "functional", maxIterations: 2 } });
    if (steps[2]?.use !== "plugin") throw new Error("plugin was not resolved");
    const warnings: string[] = [];
    await steps[2].step.run({ warnings } as never);
    expect(warnings).toEqual(["0.9"]);
  });

  test("loads a project-relative plugin module", async () => {
    const name = `plugin-${randomUUID()}`;
    writeFileSync(
      join(projectRoot, "my-step.ts"),
      `export default {
      name: ${JSON.stringify(name)},
      create(config) { return { name: ${JSON.stringify(name)}, async run(context) {
        context.warnings.push(String(config.label));
        return { kind: "continue" };
      } }; }
    };`,
    );
    const steps = await resolvePipelineSteps(
      {
        plugins: ["./my-step.ts"],
        steps: [
          { use: "implement" },
          { use: "commit" },
          { use: name, label: "loaded" },
          { use: "finalize" },
        ],
      },
      projectRoot,
    );

    expect(steps.map((step) => step.use)).toEqual(["commit", "plugin", "finalize"]);
    if (steps[1]?.use !== "plugin") throw new Error("plugin was not loaded");
    const warnings: string[] = [];
    await steps[1].step.run({ warnings } as never);
    expect(warnings).toEqual(["loaded"]);
  });

  test("rejects invalid ordering and unknown steps before running an agent", async () => {
    await expect(resolvePipelineSteps({ steps: [{ use: "commit" }] }, projectRoot)).rejects.toThrow(
      "follow implement",
    );
    await expect(
      resolvePipelineSteps(
        {
          steps: [{ use: "implement" }, { use: "verify" }, { use: "commit" }, { use: "finalize" }],
        },
        projectRoot,
      ),
    ).rejects.toThrow("follow commit");
    await expect(
      resolvePipelineSteps({ steps: [{ use: "implement" }, { use: "commit" }] }, projectRoot),
    ).rejects.toThrow("include implement, commit, and finalize");
    await expect(
      resolvePipelineSteps(
        {
          steps: [{ use: "implement" }, { use: "commit" }, { use: "unknown" }, { use: "finalize" }],
        },
        projectRoot,
      ),
    ).rejects.toThrow("Unknown pipeline step");
  });

  test("rejects malformed plugin and verifier configuration", async () => {
    await expect(resolvePipelineSteps({ plugins: [""] }, projectRoot)).rejects.toThrow("nonempty");
    await expect(
      resolvePipelineSteps(
        {
          steps: [
            { use: "implement" },
            { use: "commit" },
            { use: "verify", maxIterations: 0 },
            { use: "finalize" },
          ],
        },
        projectRoot,
      ),
    ).rejects.toThrow("positive integer");
    await expect(
      resolvePipelineSteps(
        {
          steps: [
            { use: "implement" },
            { use: "commit" },
            { use: "auto-review", maxIterations: 0 },
            { use: "finalize" },
          ],
        },
        projectRoot,
      ),
    ).rejects.toThrow("auto-review.maxIterations");
    writeFileSync(join(projectRoot, "invalid.ts"), "export default {};\n");
    await expect(resolvePipelineSteps({ plugins: ["./invalid.ts"] }, projectRoot)).rejects.toThrow(
      "name and create",
    );
  });
});
