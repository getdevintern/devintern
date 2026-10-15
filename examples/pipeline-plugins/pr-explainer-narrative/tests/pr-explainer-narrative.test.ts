import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
  test("registers the narrative artifact and returns its path", async () => {
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
    const registered = context.artifacts.list().at(-1)!;
    expect(registered.key).toBe("explanation-narrative");
    expect(context.artifacts.readText(registered.id)).toContain("Where reviewers should focus");
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

  test("includes functional verification and auto-review evidence together", async () => {
    let captured = "";
    const context = createTestContext({
      workingDir: workdir,
      agentOutput: (prompt) => {
        captured = prompt;
        return expected;
      },
    });
    for (const [key, summary] of [
      ["verification", "acceptance criteria checked"],
      ["auto-review", "review completed"],
    ]) {
      const path = join(workdir, `${key}.json`);
      writeFileSync(path, JSON.stringify({ summary }));
      await context.artifacts.addFile({
        key: key!,
        path,
        title: key!,
        kind: "verification",
        mediaType: "application/json",
      });
    }
    await runDefinition(definition, context, { config: { promptFile } });
    expect(captured).toContain("acceptance criteria checked");
    expect(captured).toContain("review completed");
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
