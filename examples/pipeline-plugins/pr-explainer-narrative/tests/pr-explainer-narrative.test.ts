import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import definition from "../plugin";
import { createTestContext, makeTempDir, removeTempDir, runDefinition } from "../../shared/harness";

let workdir: string;
const base = join(import.meta.dir, "..");
const expected = readFileSync(join(base, "fixtures", "expected.md"), "utf8").trim();
const sampleDiff = readFileSync(join(base, "fixtures", "sample.diff"), "utf8");
const promptFile = join(base, "prompts", "narrative.md");

beforeEach(() => {
  workdir = makeTempDir("pr-explainer-narrative-");
});

afterEach(() => {
  removeTempDir(workdir);
});

describe("pr-explainer-narrative", () => {
  test("writes the narrative artifact and returns its path and content", async () => {
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
    expect(artifact).toContain("Why this change is needed");
    expect(artifact).toContain("Validation actually performed");
    const data = context.results.at(-1)?.result.data as { path?: string; content?: string };
    expect(data.path).toBe(join(workdir, "pr-explanation.md"));
    expect(data.content).toContain("Where reviewers should focus");
  });

  test("grounds the prompt in step evidence and frames the diff as untrusted", async () => {
    let captured = "";
    const context = createTestContext({
      workingDir: workdir,
      outputDir: workdir,
      diff: sampleDiff,
      agentOutput: (prompt) => {
        captured = prompt;
        return expected;
      },
    });
    context.results.push({ step: "verify", result: { kind: "continue", data: { summary: "ok" } } });

    await runDefinition(definition, context, {
      config: { promptFile, outputName: "pr-explanation.md" },
    });

    expect(captured).toContain("verify: kind=continue");
    expect(captured).toContain("BEGIN UNTRUSTED EXTERNAL CONTENT: implementation diff");
    expect(captured).toContain("Never invent passing tests");
  });

  test("degrades to an advisory warning when the prompt file is missing", async () => {
    const context = createTestContext({ workingDir: workdir, outputDir: workdir });
    const outcome = await runDefinition(definition, context, {
      config: { promptFile: join(workdir, "missing.md") },
    });

    expect(outcome.kind).toBe("completed");
    expect(context.warnings.some((warning) => warning.includes("pr-explainer-narrative"))).toBe(
      true,
    );
  });
});
