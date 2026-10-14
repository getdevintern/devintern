import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;
const base = join(import.meta.dir, "..");
const expected = readFileSync(join(base, "fixtures", "expected.md"), "utf8").trim();
const sampleDiff = readFileSync(join(base, "fixtures", "sample.diff"), "utf8");
const promptFile = join(base, "prompts", "visual.md");

beforeEach(() => {
  workdir = makeTempDir("pr-explainer-visual-");
});

afterEach(() => {
  removeTempDir(workdir);
});

describe("pr-explainer-visual", () => {
  test("writes the visual artifact with Summary, Evidence, and Merge Danger", async () => {
    const context = createTestContext({
      workingDir: workdir,
      outputDir: workdir,
      diff: sampleDiff,
      agentOutput: expected,
    });
    context.results.push({ step: "verify", result: { kind: "continue", data: { summary: "ok" } } });

    const outcome = await runDefinition(definition, context, {
      config: { promptFile, outputName: "pr-explanation.md" },
    });

    expect(outcome.kind).toBe("completed");
    const artifact = readFileSync(join(workdir, "pr-explanation.md"), "utf8").trim();
    expect(artifact).toBe(expected);
    expect(artifact).toContain("## Summary");
    expect(artifact).toContain("## Evidence");
    expect(artifact).toContain("## Merge Danger");
  });

  test("degrades to an advisory warning when generation fails", async () => {
    const context = createTestContext({
      workingDir: workdir,
      outputDir: workdir,
      diff: sampleDiff,
      agentOutput: () => {
        throw new Error("agent unavailable");
      },
    });
    const outcome = await runDefinition(definition, context, {
      config: { promptFile, outputName: "pr-explanation.md" },
    });

    expect(outcome.kind).toBe("completed");
    expect(context.warnings.some((warning) => warning.includes("pr-explainer-visual"))).toBe(true);
  });
});
