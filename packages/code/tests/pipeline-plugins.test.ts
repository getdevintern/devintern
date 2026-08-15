import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPlugins, resolvePipelineSteps } from "../src/lib/pipeline/config";
import { __resetStepsForTests, getStep } from "../src/lib/pipeline/registry";
import { StepStatus } from "../src/lib/pipeline/types";

let pluginDir: string;
let unique = 0;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "devintern-pipeline-plugins-"));
  unique++;
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
  __resetStepsForTests();
});

/** Write a plugin module and return its file name (relative to pluginDir). */
function writePlugin(fileName: string, contents: string): string {
  writeFileSync(join(pluginDir, fileName), contents, "utf8");
  return fileName;
}

describe("Pipeline plugins", () => {
  test("loads a local module and registers its default-exported step", async () => {
    const stepName = `custom-lint-${unique}-${Date.now()}`;
    const file = writePlugin(
      "my-lint.ts",
      `const definition = {
  name: "${stepName}",
  create(config) {
    return {
      name: "${stepName}",
      async run(ctx) {
        return { status: "continue", data: { threshold: config.threshold } };
      },
    };
  },
};
export default definition;
`,
    );

    // Relative path resolved against the project root (pluginDir here).
    await loadPlugins([`./${file}`], pluginDir);

    const definition = getStep(stepName);
    expect(definition).toBeDefined();
    expect(definition!.name).toBe(stepName);

    // The plugin step is now usable from pipeline.steps, including config.
    const steps = resolvePipelineSteps([{ use: stepName, threshold: 0.9 }]);
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe(stepName);

    // And it runs like any other step.
    // oxlint-disable-next-line no-explicit-any
    const result = await steps[0].run({} as any);
    expect(result.status).toBe(StepStatus.Continue);
    expect(result.data).toEqual({ threshold: 0.9 });
  });

  test("loads plugins referenced by absolute path", async () => {
    const stepName = `abs-path-step-${unique}-${Date.now()}`;
    writePlugin(
      "abs-step.ts",
      `export default { name: "${stepName}", create: () => ({ name: "${stepName}", run: async () => ({ status: "continue" }) }) };
`,
    );

    await loadPlugins([join(pluginDir, "abs-step.ts")], "/somewhere/else");
    expect(getStep(stepName)).toBeDefined();
  });

  test("loading the same plugin again is a no-op for batch task runs", async () => {
    const stepName = `batch-step-${unique}-${Date.now()}`;
    const file = writePlugin(
      "batch-step.ts",
      `export default { name: "${stepName}", create: () => ({ name: "${stepName}", run: async () => ({ status: "continue" }) }) };
`,
    );

    await loadPlugins([`./${file}`], pluginDir);
    await loadPlugins([`./${file}`], pluginDir);

    expect(getStep(stepName)).toBeDefined();
  });

  test("throws a clear error when the module has no default export", async () => {
    const file = writePlugin(
      "no-default.ts",
      `export const definition = { name: "named-only", create: () => ({ name: "named-only", run: async () => ({ status: "continue" }) }) };
`,
    );

    await expect(loadPlugins([`./${file}`], pluginDir)).rejects.toThrow(
      /must default-export a StepDefinition/,
    );
    await expect(loadPlugins([`./${file}`], pluginDir)).rejects.toThrow(/no default export/);
    expect(getStep("named-only")).toBeUndefined();
  });

  test("throws a clear error when the default export is not a StepDefinition", async () => {
    const file = writePlugin(
      "bad-shape.ts",
      `export default { notAName: true };
`,
    );

    await expect(loadPlugins([`./${file}`], pluginDir)).rejects.toThrow(
      /must default-export a StepDefinition/,
    );
  });

  test("throws on a name collision with a built-in step", async () => {
    const file = writePlugin(
      "collides.ts",
      `export default { name: "implement", create: () => ({ name: "implement", run: async () => ({ status: "continue" }) }) };
`,
    );

    await expect(loadPlugins([`./${file}`], pluginDir)).rejects.toThrow(
      /'implement' is already registered/,
    );
  });

  test("throws a clear error for an unresolvable plugin path", async () => {
    await expect(loadPlugins(["./does-not-exist.ts"], pluginDir)).rejects.toThrow(
      /Failed to load pipeline plugin '\.\/does-not-exist\.ts'/,
    );
  });

  test("no plugins is a no-op", async () => {
    await loadPlugins(undefined, pluginDir);
    await loadPlugins([], pluginDir);
  });
});
